import { randomUUID } from 'node:crypto'
import {
  MEMORY_FORMAT_VERSION,
  PandaError,
  PANDA_ERROR_CODES,
  memoryOverwriteUnsupported,
  memoryStoreVersionMismatch,
  validateMemorySaveRequest,
} from '@panda/contracts'
import type {
  MemoryEntry,
  MemoryProvider,
  MemorySaveRequest,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryStoreInfo,
  MemoryTimeline,
} from '@panda/contracts'
import { loadSqlite } from './load-sqlite.ts'
import type { DatabaseSync } from 'node:sqlite'

/**
 * The store, as one table. `sequence` is `INTEGER PRIMARY KEY AUTOINCREMENT`
 * rather than a plain rowid alias: AUTOINCREMENT is what guarantees the counter
 * never goes backwards, and an append-only log with a reused sequence number is
 * a log that reorders itself.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  supersedes TEXT
)`

const COLUMNS = 'sequence, id, payload, agent_id, workspace_id, recorded_at, supersedes'

export interface SqliteMemoryProviderOptions {
  /** Path to the SQLite database file. Its directory must already exist. */
  readonly databasePath: string
}

/**
 * Embedded-SQLite MemoryProvider on `node:sqlite`'s `DatabaseSync`.
 *
 * NO new dependency: `node:sqlite` is the platform, measured working on Node
 * 24.14.1 and 26.8.1 — the exact two versions CI runs. Its experimental warning
 * is handled in `load-sqlite.ts`, which is also why this module imports the
 * class TYPE only and the runtime binding arrives through `loadSqlite()`.
 *
 * Append-only is enforced by omission and by SQL: this file contains no UPDATE
 * and no DELETE, and the format version lives in `PRAGMA user_version`, which is
 * where SQLite already keeps exactly this fact.
 */
export class SqliteMemoryProvider implements MemoryProvider {
  readonly #databasePath: string
  readonly #db: DatabaseSync
  #disposed = false

  private constructor(databasePath: string, db: DatabaseSync) {
    this.#databasePath = databasePath
    this.#db = db
  }

  static async open(options: SqliteMemoryProviderOptions): Promise<SqliteMemoryProvider> {
    const databasePath = options?.databasePath
    if (typeof databasePath !== 'string' || databasePath.trim().length === 0) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
        'SqliteMemoryProvider requires a non-empty string databasePath',
      )
    }
    const { DatabaseSync: Database } = await loadSqlite()
    let db: DatabaseSync
    try {
      db = new Database(databasePath)
    } catch (error) {
      throw unavailable('open', databasePath, error)
    }
    try {
      const found = readUserVersion(db, databasePath)
      // 0 is SQLite's default for a database nobody has stamped: an absent store,
      // not a wrong one (AD-5). Any OTHER value is a store this build refuses —
      // version by reject, never migrate.
      if (found !== 0 && found !== MEMORY_FORMAT_VERSION) {
        throw memoryStoreVersionMismatch(databasePath, found)
      }
      db.exec(SCHEMA)
      if (found === 0) db.exec(`PRAGMA user_version = ${String(MEMORY_FORMAT_VERSION)}`)
    } catch (error) {
      // A database opened but not accepted must not be left open, or a caller
      // that retries after fixing the store meets a lock it cannot explain.
      try {
        db.close()
      } catch {
        // The refusal below is the verdict; a close failure must not replace it.
      }
      throw error instanceof PandaError ? error : unavailable('initialise', databasePath, error)
    }
    return new SqliteMemoryProvider(databasePath, db)
  }

  async save(request: MemorySaveRequest): Promise<MemoryEntry> {
    this.#assertActive()
    const valid = validateMemorySaveRequest(request)
    if (valid.supersedes !== undefined) {
      const existing = this.#db.prepare('SELECT 1 AS present FROM entries WHERE id = ?').get(valid.supersedes)
      if (existing === undefined) {
        throw new PandaError(
          PANDA_ERROR_CODES.contractMemoryUnknownEntry,
          `memory store '${this.#databasePath}' holds no entry '${valid.supersedes}' to supersede`,
        )
      }
    }
    const id = randomUUID()
    let inserted
    try {
      inserted = this.#db
        .prepare('INSERT INTO entries (id, payload, agent_id, workspace_id, recorded_at, supersedes) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, valid.payload, valid.provenance.agentId, valid.provenance.workspaceId, valid.provenance.recordedAt, valid.supersedes ?? null)
    } catch (error) {
      throw unavailable('append to', this.#databasePath, error)
    }
    return Object.freeze({
      id,
      sequence: Number(inserted.lastInsertRowid),
      payload: valid.payload,
      provenance: Object.freeze({
        agentId: valid.provenance.agentId,
        workspaceId: valid.provenance.workspaceId,
        recordedAt: valid.provenance.recordedAt,
      }),
      ...(valid.supersedes === undefined ? {} : { supersedes: valid.supersedes }),
    })
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    this.#assertActive()
    const conditions: string[] = []
    const parameters: string[] = []
    if (query?.workspaceId !== undefined) {
      conditions.push('workspace_id = ?')
      parameters.push(query.workspaceId)
    }
    if (query?.agentId !== undefined) {
      conditions.push('agent_id = ?')
      parameters.push(query.agentId)
    }
    if (query?.contains !== undefined) {
      // `instr`, not `LIKE`: LIKE is case-INSENSITIVE for ASCII by default and
      // would disagree with `String.prototype.includes` in the filesystem
      // provider on exactly the inputs FR-16 says must behave identically.
      // Measured on the empty needle too — `instr(x, '') = 1`, matching
      // `''.includes('') === true`.
      conditions.push('instr(payload, ?) > 0')
      parameters.push(query.contains)
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`
    const rows = this.#db.prepare(`SELECT ${COLUMNS} FROM entries${where} ORDER BY sequence ASC`).all(...parameters)
    const entries = rows.map((row) => this.#toEntry(row))
    return { entries, matched: entries.length }
  }

  async timeline(): Promise<MemoryTimeline> {
    this.#assertActive()
    const rows = this.#db.prepare(`SELECT ${COLUMNS} FROM entries ORDER BY sequence ASC`).all()
    return { entries: rows.map((row) => this.#toEntry(row)) }
  }

  async describe(): Promise<MemoryStoreInfo> {
    this.#assertActive()
    const row = this.#db
      .prepare('SELECT COUNT(*) AS entry_count, MIN(recorded_at) AS first_write, MAX(recorded_at) AS last_write FROM entries')
      .get()
    const entryCount = Number(row?.['entry_count'] ?? 0)
    const first = row?.['first_write']
    const last = row?.['last_write']
    return {
      formatVersion: MEMORY_FORMAT_VERSION,
      entryCount,
      // MIN/MAX over an empty table are SQL NULL. Absent, not null and not '' (AD-5).
      ...(typeof first === 'string' && typeof last === 'string' ? { firstWriteAt: first, lastWriteAt: last } : {}),
    }
  }

  async overwrite(entryId: string): Promise<never> {
    this.#assertActive()
    throw memoryOverwriteUnsupported(entryId)
  }

  /** Idempotent, and destroys nothing: the database file outlives every provider. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    try {
      this.#db.close()
    } catch (error) {
      throw unavailable('close', this.#databasePath, error)
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractProviderDisposed,
        'memory provider has been disposed and no longer serves its store',
      )
    }
  }

  /**
   * Rows arrive as `SQLOutputValue`, a union that includes `null` and numbers.
   * Every column is read through a type check rather than a cast, so a database
   * someone else wrote into surfaces as a coded store failure instead of an
   * entry with `null` where its workspace id should be — which is precisely the
   * provenance leak D5 exists to prevent, arriving through the back door.
   */
  #toEntry(row: Record<string, unknown>): MemoryEntry {
    const sequence = row['sequence']
    if (typeof sequence !== 'number' && typeof sequence !== 'bigint') {
      throw unavailable('read', this.#databasePath, new Error("column 'sequence' is not an integer"))
    }
    const supersedes = row['supersedes']
    if (supersedes !== null && typeof supersedes !== 'string') {
      throw unavailable('read', this.#databasePath, new Error("column 'supersedes' is neither NULL nor text"))
    }
    return Object.freeze({
      id: this.#text(row, 'id'),
      sequence: Number(sequence),
      payload: this.#text(row, 'payload'),
      provenance: Object.freeze({
        agentId: this.#text(row, 'agent_id'),
        workspaceId: this.#text(row, 'workspace_id'),
        recordedAt: this.#text(row, 'recorded_at'),
      }),
      ...(supersedes === null ? {} : { supersedes }),
    })
  }

  #text(row: Record<string, unknown>, column: string): string {
    const value = row[column]
    if (typeof value !== 'string') {
      throw unavailable('read', this.#databasePath, new Error(`column '${column}' is not text`))
    }
    return value
  }
}

function readUserVersion(db: DatabaseSync, databasePath: string): number {
  const row = db.prepare('PRAGMA user_version').get()
  const found = row?.['user_version']
  if (typeof found !== 'number' && typeof found !== 'bigint') {
    throw unavailable('read the format version of', databasePath, new Error('PRAGMA user_version returned no integer'))
  }
  return Number(found)
}

function unavailable(operation: string, path: string, error: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
    `memory store failed to ${operation} '${path}': ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  )
}
