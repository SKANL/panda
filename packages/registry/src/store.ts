import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
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
import type { RegistryEntry, RegistryScope, StoredEntryType } from '@panda/contracts'
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

/** Same directory, spelled either way. Case-insensitive on win32, like paths are. */
function sameDirectory(left: string, right: string): boolean {
  const [a, b] = [resolvePath(left), resolvePath(right)]
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
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
    // The one collision that makes two scopes ONE document. `#storePath` puts
    // the global store at `<home>/.panda/registry.json` and the project store at
    // `<project>/.panda/registry.json`, so a project directory that IS the home
    // directory aliases them: `list('global')` and `list('project')` return the
    // same rows under two scope labels, and a project-scope REMOVE empties the
    // global registry while reporting a project-scope removal. Cosmetic until a
    // command could delete an entry; destruction from the moment one could.
    //
    // Refused in the constructor rather than at each call, so no caller — the
    // CLI, `initProject`, `diagnose`, or a third party holding the store
    // directly — can reach the aliased state by forgetting to check.
    if (this.#projectDir !== undefined && sameDirectory(this.#projectDir, this.#homeDir)) {
      throw new PandaError(
        PANDA_ERROR_CODES.registryStoreUnavailable,
        `registry store cannot use '${this.#projectDir}' as a project directory: it is the home directory, so the project scope would be the very same document as the global scope`,
      )
    }
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

  /**
   * Materialises the store document for a persisted scope and returns its path,
   * so a machine that has registered nothing still has a readable store on disk
   * (`panda init`'s guarantee). It lives here rather than in the caller because
   * the document's version and shape are the store's to define — a caller
   * writing `{version, entries}` by hand would silently fork the format.
   *
   * CREATE-ONLY, and both halves of that matter. An existing document is
   * VALIDATED and left byte-for-byte alone: rewriting it would persist this
   * build's reconstruction of it, destroying any top-level key the store does
   * not model — on every `panda init`. And a read-only call must not queue
   * behind the lockfile, or preparing a machine could die with
   * PANDA_REGISTRY_CONTENTION because another panda happened to be writing.
   * A corrupt document fails coded through #readStore and is never replaced.
   */
  async ensure(scope: Exclude<RegistryScope, 'agent'>): Promise<string> {
    if ((scope as RegistryScope) === 'agent') {
      throw new PandaError(
        PANDA_ERROR_CODES.registryInvalidEntry,
        "invalid registry entry: the 'agent' scope is in-memory and has no store document to create",
      )
    }
    validateRegistryScope(scope)
    this.#assertActive()
    const path = this.#storePath(scope)
    const present = await stat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw unavailable('read', path, error)
      },
    )
    if (present) {
      await this.#readStore(path)
      return path
    }
    await this.#mutate(scope, () => this.#persist(path, (current) => current))
    return path
  }

  /**
   * Where a persisted scope's document LIVES, without creating it — the
   * read-only half of `ensure`. It exists because "has panda been initialised
   * here" is a question about that document, and the only other way to ask it
   * was `ensure`, which answers by creating it. A caller that cannot write
   * (`panda doctor`) would otherwise have to fork the layout, putting a second
   * copy of a path this class defines outside this class.
   *
   * The path is returned whether or not anything is there; `stat` it to find out.
   */
  storePath(scope: Exclude<RegistryScope, 'agent'>): string {
    validateRegistryScope(scope)
    return this.#storePath(scope)
  }

  async remove(type: StoredEntryType, id: string, scope: RegistryScope): Promise<void> {
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

  /**
   * Two deliberately different modes:
   *  - WITHOUT `scope`: the merged read every consumer wants — agent > project
   *    > global precedence, i.e. what the registry actually serves for this id.
   *  - WITH `scope`: that ONE scope, no fallthrough. A writer targeting a scope
   *    must see what is stored THERE; the merged view would let an entry
   *    shadowing from another scope hide a stale target-scope entry forever.
   */
  async get(
    type: StoredEntryType,
    id: string,
    scope?: RegistryScope,
  ): Promise<RegistryEntry | undefined> {
    this.#assertActive()
    const key = `${type}:${id}`
    if (scope === 'agent') {
      const agent = this.#agentEntries.get(key)
      return agent === undefined ? undefined : expandRegistryEntryPaths(agent, this.#homeDir)
    }
    if (scope === undefined) {
      const agent = this.#agentEntries.get(key)
      if (agent !== undefined) return expandRegistryEntryPaths(agent, this.#homeDir)
    }
    const scopes = scope === undefined ? (['project', 'global'] as const) : ([scope] as const)
    for (const candidateScope of scopes) {
      // Only the merged read skips an unconfigured project scope; an EXPLICIT
      // project read is a configuration error and fails coded through #storePath.
      if (scope === undefined && candidateScope === 'project' && this.#projectDir === undefined) continue
      const file = await this.#readStore(this.#storePath(candidateScope))
      const found = file.entries.find((candidate) => entryKey(candidate) === key)
      if (found !== undefined) return expandRegistryEntryPaths(found, this.#homeDir)
    }
    return undefined
  }

  /**
   * The same two modes {@link RegistryStore.get} has, for the whole store:
   *  - WITHOUT `scope`: the merged view every projection reads, agent > project
   *    > global.
   *  - WITH `scope`: that ONE scope, no fallthrough. A reader that has to say
   *    WHERE an entry lives cannot use the merged view, because the merge keeps
   *    one row per `type:id` and drops the scope that produced it.
   */
  async list(scope?: RegistryScope): Promise<RegistryEntry[]> {
    this.#assertActive()
    if (scope === 'agent') {
      return [...this.#agentEntries.values()].map((entry) => expandRegistryEntryPaths(entry, this.#homeDir))
    }
    const merged = new Map<string, RegistryEntry>()
    const scopes = scope === undefined ? (['global', 'project'] as const) : ([scope] as const)
    for (const candidateScope of scopes) {
      // Only the merged read skips an unconfigured project scope; an EXPLICIT
      // project read is a configuration error and fails coded through #storePath.
      if (scope === undefined && candidateScope === 'project' && this.#projectDir === undefined) continue
      const file = await this.#readStore(this.#storePath(candidateScope))
      for (const entry of file.entries) merged.set(entryKey(entry), entry)
    }
    if (scope === undefined) {
      for (const entry of this.#agentEntries.values()) merged.set(entryKey(entry), entry)
    }
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
      // `admitRetired`, and ONLY here: a document written by an older build may
      // hold a word panda has since retired, and one such row used to make the
      // WHOLE store unreadable — which blocks `panda list`, `panda remove` and
      // `panda init`, i.e. the very commands that would take it out. Retiring a
      // word must not be reachable as a dead end by upgrading (M4.C). Every
      // other rule of the envelope still applies, so a genuinely malformed entry
      // still fails the store here exactly as before.
      const issues = registryEntryIssues(candidate, true)
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
