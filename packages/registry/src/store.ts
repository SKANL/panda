import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  PANDA_ERROR_CODES,
  PandaError,
  expandRegistryEntryPaths,
  isRecord,
  normalizeRegistryEntryPaths,
  registryEntryIssues,
  validateRegistryEntry,
  validateRegistryScope,
} from '@panda/contracts'
import type { RegistryEntry, RegistryEntryType, RegistryScope } from '@panda/contracts'
import { acquireLock } from './lock.ts'
import type { LockOptions, StaleLockBreak } from './lock.ts'

// Canonical scoped registry store (v1). Layout per Design Notes:
//   global  `<home>/.panda/registry.json`
//   project `<project>/.panda/registry.json`
//   agent   in-memory only within a kernel session (persistence arrives when a
//           consumer needs it — not speculative)
// Read precedence: agent > project > global.
//
// Every mutation takes the target store's lockfile (`<store>.lock`), performs a
// serialized read-modify-write, persists atomically (temp file + rename), and
// releases the lock. Reads are lock-free: atomic renames guarantee they observe
// complete files — but hand-edited or corrupt documents never flow out: reads
// validate the store version and EVERY entry against the canonical envelope.
//
// Path normalization (NFR-6): at WRITE time, and ONLY in the per-type declared
// path fields (`REGISTRY_PATH_FIELDS`), values under the user home directory
// are stored with a `~/` marker (literal leading tildes escaped as `~~`, so the
// round trip is lossless). Ids and extensions payloads stay verbatim. Reads
// expand markers back uniformly for ALL scopes.
//
// Storage-time transformation is invisible to callers: register() and remove()
// return nothing; get()/list() always return expanded entries.

const STORE_VERSION = 1
const PERSIST_ATTEMPTS = 3
const PERSIST_RETRY_DELAY_MS = 25

export interface RegistryStoreOptions {
  /** Defaults to the OS home directory. */
  readonly homeDir?: string
  /** Enables the project scope when provided. */
  readonly projectDir?: string
  readonly lockTimeoutMs?: number
  readonly lockPollMs?: number
  /** Observes stale/corrupt-lock breaks performed during mutations. */
  readonly onStaleLockBreak?: (broken: StaleLockBreak) => void
}

interface StoreFile {
  version: number
  entries: RegistryEntry[]
}

function entryKey(entry: Pick<RegistryEntry, 'type' | 'id'>): string {
  return `${entry.type}:${entry.id}`
}

function unavailable(operation: string, path: string, cause?: unknown): PandaError {
  const detail = cause === undefined ? '' : `: ${cause instanceof Error ? cause.message : String(cause)}`
  return new PandaError(
    PANDA_ERROR_CODES.registryStoreUnavailable,
    `registry store ${operation} failed on '${path}'${detail}`,
    { cause },
  )
}

export class RegistryStore {
  readonly #homeDir: string
  readonly #projectDir: string | undefined
  readonly #lockOptions: LockOptions
  // Raw validated entries; expansion happens at read time like every other scope.
  readonly #agentEntries = new Map<string, RegistryEntry>()
  #disposed = false
  // Every in-flight mutation registers itself here; dispose() waits for all of
  // them so a concurrent teardown can neither release a mutation's lock early
  // nor lose its write. Each mutation owns its own lock path.
  readonly #inFlight = new Set<Promise<void>>()

  constructor(options: RegistryStoreOptions = {}) {
    this.#homeDir = options.homeDir ?? homedir()
    this.#projectDir = options.projectDir
    const { onStaleLockBreak, lockTimeoutMs, lockPollMs } = options
    this.#lockOptions = {
      timeoutMs: lockTimeoutMs,
      pollMs: lockPollMs,
      onStaleBreak: onStaleLockBreak,
    }
  }

  async register(entry: unknown, scope: RegistryScope): Promise<void> {
    await this.#mutate(scope, async () => {
      const valid = validateRegistryEntry(entry)
      const normalized = normalizeRegistryEntryPaths(valid, this.#homeDir)
      if (scope === 'agent') {
        this.#agentEntries.set(entryKey(valid), valid)
        return
      }
      await this.#persist(this.#storePath(scope), (current) => ({
        version: STORE_VERSION,
        entries: [
          ...current.entries.filter((candidate) => entryKey(candidate) !== entryKey(normalized)),
          normalized,
        ],
      }))
    })
  }

  async remove(type: RegistryEntryType, id: string, scope: RegistryScope): Promise<void> {
    const key = `${type}:${id}`
    await this.#mutate(scope, async () => {
      if (scope === 'agent') {
        this.#agentEntries.delete(key)
        return
      }
      await this.#persist(this.#storePath(scope), (current) => ({
        version: STORE_VERSION,
        entries: current.entries.filter((candidate) => entryKey(candidate) !== key),
      }))
    })
  }

  async get(type: RegistryEntryType, id: string): Promise<RegistryEntry | undefined> {
    this.#assertActive()
    const key = `${type}:${id}`
    const agent = this.#agentEntries.get(key)
    if (agent !== undefined) return expandRegistryEntryPaths(agent, this.#homeDir)
    for (const scope of ['project', 'global'] as const) {
      if (scope === 'project' && this.#projectDir === undefined) continue
      const file = await this.#readStore(this.#storePath(scope))
      const found = file.entries.find((candidate) => entryKey(candidate) === key)
      if (found !== undefined) return expandRegistryEntryPaths(found, this.#homeDir)
    }
    return undefined
  }

  async list(): Promise<RegistryEntry[]> {
    this.#assertActive()
    const merged = new Map<string, RegistryEntry>()
    for (const scope of ['global', 'project'] as const) {
      if (scope === 'project' && this.#projectDir === undefined) continue
      const file = await this.#readStore(this.#storePath(scope))
      for (const entry of file.entries) merged.set(entryKey(entry), entry)
    }
    for (const entry of this.#agentEntries.values()) merged.set(entryKey(entry), entry)
    return [...merged.values()].map((entry) => expandRegistryEntryPaths(entry, this.#homeDir))
  }

  /**
   * Stops the store. Waits for every in-flight mutation to finish (each one
   * releases its own lock), so disposal neither releases a lock early nor
   * loses an already-started write. There is nothing else to flush:
   * persistence is eager via atomic rename.
   */
  async dispose(): Promise<void> {
    this.#disposed = true
    await Promise.allSettled([...this.#inFlight])
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new PandaError(
        PANDA_ERROR_CODES.registryInactive,
        'registry store has been disposed and no longer serves entries',
      )
    }
  }

  // Serializes validation + work through the in-flight registry; the lock is
  // taken inside #persist so each mutation owns exactly its own lockfile.
  async #mutate(scope: RegistryScope, work: () => Promise<void>): Promise<void> {
    validateRegistryScope(scope)
    this.#assertActive()
    const mutation = work().finally(() => this.#inFlight.delete(mutation))
    this.#inFlight.add(mutation)
    await mutation
  }

  #storePath(scope: Exclude<RegistryScope, 'agent'>): string {
    if (scope === 'global') return join(this.#homeDir, '.panda', 'registry.json')
    if (this.#projectDir === undefined) {
      throw unavailable('resolve project scope', '.panda/registry.json', new Error('no project directory is configured'))
    }
    return join(this.#projectDir, '.panda', 'registry.json')
  }

  async #readStore(path: string): Promise<StoreFile> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: STORE_VERSION, entries: [] }
      throw unavailable('read', path, error)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw unavailable('parse', path, error)
    }
    if (!isRecord(parsed)) throw unavailable('validate', path, new Error('store document is not an object'))
    const foundVersion = parsed['version']
    if (foundVersion !== STORE_VERSION) {
      throw unavailable(
        'validate',
        path,
        new Error(`store document has version ${JSON.stringify(foundVersion)} but this build expects ${STORE_VERSION}`),
      )
    }
    if (!Array.isArray(parsed['entries'])) {
      throw unavailable('validate', path, new Error("store document has no 'entries' array"))
    }

    const entries = parsed['entries'] as unknown[]
    entries.forEach((candidate, index) => {
      const issues = registryEntryIssues(candidate)
      if (issues.length > 0) {
        throw unavailable(
          'validate',
          path,
          new Error(`entries[${index}] violates the canonical envelope: ${issues.map((issue) => issue.message).join('; ')}`),
        )
      }
    })
    return { version: STORE_VERSION, entries: entries as RegistryEntry[] }
  }

  async #persist(path: string, next: (current: StoreFile) => StoreFile): Promise<void> {
    const dir = dirname(path)
    await mkdir(dir, { recursive: true }).catch((error: unknown) => {
      throw unavailable('prepare', dir, error)
    })
    const lock = await acquireLock(`${path}.lock`, this.#lockOptions)
    try {
      const updated = next(await this.#readStore(path))
      // Atomic persistence: temp file in the same directory, then rename over
      // the target so readers only ever observe a complete document. Windows
      // can transiently deny rename-over-existing (EPERM while a reader holds
      // a handle open); retry a bounded number of times before failing coded.
      const tempPath = join(dir, `${basename(path)}.${randomUUID()}.tmp`)
      let lastError: unknown
      for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt += 1) {
        try {
          await writeFile(tempPath, JSON.stringify(updated, null, 2), 'utf8')
          await rename(tempPath, path)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          await unlink(tempPath).catch(() => {})
          if ((error as NodeJS.ErrnoException)?.code !== 'EPERM' || attempt === PERSIST_ATTEMPTS) break
          await new Promise((resolve) => setTimeout(resolve, PERSIST_RETRY_DELAY_MS))
        }
      }
      if (lastError !== undefined) throw unavailable('persist', path, lastError)
    } finally {
      await lock.release()
    }
  }
}
