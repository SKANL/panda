import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MEMORY_FORMAT_VERSION,
  PandaError,
  PANDA_ERROR_CODES,
  isRecord,
  memoryEntryIssues,
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

const META_FILE = 'meta.json'
const LOG_FILE = 'entries.ndjson'

export interface FilesystemMemoryProviderOptions {
  /** Directory holding this store's `meta.json` and append-only `entries.ndjson`. */
  readonly storeDir: string
}

/**
 * Filesystem MemoryProvider: one directory, one JSON stamp, one append-only
 * newline-delimited log.
 *
 * The log is the store. `save()` appends exactly one line and never rewrites,
 * truncates or seeks — which is what makes RD-1's append-only rule a property of
 * the MEDIUM rather than a promise the class makes about itself. There is no
 * update path in this file to disable.
 *
 * ponytail: the whole log is read at open() and held in memory, and every read
 * answers from that array. Ceiling: a store larger than the process can hold, or
 * a second writer against the same directory (RD-1's single-writer doctrine says
 * there is not one). Upgrade path when either arrives: keep a byte offset from
 * the last read and tail the file on each operation, which is the same append-only
 * shape with a cursor.
 */
export class FilesystemMemoryProvider implements MemoryProvider {
  readonly #storeDir: string
  readonly #logPath: string
  readonly #entries: MemoryEntry[]
  #disposed = false

  private constructor(storeDir: string, entries: MemoryEntry[]) {
    this.#storeDir = storeDir
    this.#logPath = join(storeDir, LOG_FILE)
    this.#entries = entries
  }

  /**
   * Opens (and creates, when absent) the store. Async because the format-version
   * stamp has to be READ before this build agrees to serve the directory, and a
   * constructor cannot wait — the alternative, deferring the check to the first
   * operation, would let a caller hold a provider over a store it may never read.
   */
  static async open(options: FilesystemMemoryProviderOptions): Promise<FilesystemMemoryProvider> {
    const storeDir = options?.storeDir
    if (typeof storeDir !== 'string' || storeDir.trim().length === 0) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
        'FilesystemMemoryProvider requires a non-empty string storeDir',
      )
    }
    try {
      await mkdir(storeDir, { recursive: true })
    } catch (error) {
      throw unavailable('create', storeDir, error)
    }
    await readOrStampVersion(storeDir)
    return new FilesystemMemoryProvider(storeDir, await readLog(join(storeDir, LOG_FILE)))
  }

  async save(request: MemorySaveRequest): Promise<MemoryEntry> {
    this.#assertActive()
    // Validation lives in @panda/contracts so both shipped providers refuse the
    // same requests with the same coded message. FR-16 asks for identical
    // behaviour envelopes; two hand-written validators is where that erodes.
    const valid = validateMemorySaveRequest(request)
    if (valid.supersedes !== undefined && !this.#entries.some((entry) => entry.id === valid.supersedes)) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractMemoryUnknownEntry,
        `memory store '${this.#storeDir}' holds no entry '${valid.supersedes}' to supersede`,
      )
    }
    // Provenance is rebuilt field by field rather than spread: what the store
    // holds is the three mandated fields and nothing a caller happened to hang
    // off the same object.
    const entry: MemoryEntry = Object.freeze({
      id: randomUUID(),
      sequence: this.#entries.length + 1,
      payload: valid.payload,
      provenance: Object.freeze({
        agentId: valid.provenance.agentId,
        workspaceId: valid.provenance.workspaceId,
        recordedAt: valid.provenance.recordedAt,
      }),
      ...(valid.supersedes === undefined ? {} : { supersedes: valid.supersedes }),
    })
    try {
      await appendFile(this.#logPath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      throw unavailable('append to', this.#logPath, error)
    }
    this.#entries.push(entry)
    return entry
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
    this.#assertActive()
    const entries = this.#entries.filter((entry) => matches(entry, query ?? {}))
    return { entries, matched: entries.length }
  }

  async timeline(): Promise<MemoryTimeline> {
    this.#assertActive()
    // Already in append order: `sequence` is the array index plus one.
    return { entries: [...this.#entries] }
  }

  async describe(): Promise<MemoryStoreInfo> {
    this.#assertActive()
    const stamps = this.#entries.map((entry) => entry.provenance.recordedAt).sort()
    return {
      formatVersion: MEMORY_FORMAT_VERSION,
      entryCount: this.#entries.length,
      // Absent on an empty store, never an empty string (AD-5).
      ...(stamps.length === 0 ? {} : { firstWriteAt: stamps[0], lastWriteAt: stamps[stamps.length - 1] }),
    }
  }

  async overwrite(entryId: string): Promise<never> {
    this.#assertActive()
    throw memoryOverwriteUnsupported(entryId)
  }

  /** Idempotent, and destroys nothing: the directory outlives every provider. */
  async dispose(): Promise<void> {
    this.#disposed = true
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractProviderDisposed,
        'memory provider has been disposed and no longer serves its store',
      )
    }
  }
}

function unavailable(operation: string, path: string, error: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
    `memory store failed to ${operation} '${path}': ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  )
}

/**
 * Reads the format stamp, writing it when the store is new.
 *
 * An ABSENT `meta.json` is a store that does not exist yet, which is not a
 * failure (AD-5) — it is stamped and served. A PRESENT one that cannot be read,
 * parsed, or that names another version, is refused: version by reject, never
 * migrate.
 */
async function readOrStampVersion(storeDir: string): Promise<void> {
  const metaPath = join(storeDir, META_FILE)
  let raw: string
  try {
    raw = await readFile(metaPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw unavailable('read', metaPath, error)
    try {
      await writeFile(metaPath, `${JSON.stringify({ formatVersion: MEMORY_FORMAT_VERSION }, null, 2)}\n`, 'utf8')
    } catch (writeError) {
      throw unavailable('stamp', metaPath, writeError)
    }
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw unavailable('parse', metaPath, error)
  }
  if (!isRecord(parsed)) throw unavailable('validate', metaPath, new Error('store metadata is not an object'))
  if (parsed['formatVersion'] !== MEMORY_FORMAT_VERSION) {
    throw memoryStoreVersionMismatch(storeDir, parsed['formatVersion'])
  }
}

/** An absent log is an empty store; a malformed one is a store that cannot be read. */
async function readLog(logPath: string): Promise<MemoryEntry[]> {
  let raw: string
  try {
    raw = await readFile(logPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw unavailable('read', logPath, error)
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        throw unavailable('parse', logPath, new Error(`line ${String(index + 1)} is not JSON: ${String(error)}`))
      }
      const issues = memoryEntryIssues(parsed)
      if (issues.length > 0) {
        throw unavailable(
          'validate',
          logPath,
          new Error(`line ${String(index + 1)} violates the entry envelope: ${issues.map((entry) => entry.message).join('; ')}`),
        )
      }
      return parsed as MemoryEntry
    })
}

/**
 * The whole query surface: AND-ed equality on provenance, exact case-sensitive
 * substring on the opaque payload. `contains` uses `String.prototype.includes`,
 * whose empty-needle answer (`true`) is the one `@panda/memory-sqlite` matches
 * with `instr(payload, '') > 0` — the two engines have to agree on the corner
 * cases too, or FR-16's "identical behaviour envelopes" is only about the middle.
 */
function matches(entry: MemoryEntry, query: MemorySearchQuery): boolean {
  if (query.workspaceId !== undefined && entry.provenance.workspaceId !== query.workspaceId) return false
  if (query.agentId !== undefined && entry.provenance.agentId !== query.agentId) return false
  if (query.contains !== undefined && !entry.payload.includes(query.contains)) return false
  return true
}
