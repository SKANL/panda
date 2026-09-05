import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { PANDA_ERROR_CODES, PandaError, PROJECTION_LEDGER_VERSION, isRecord } from '@skanl/panda-contracts'
import type { ProjectionLedgerRecord, ProjectionWarning } from '@skanl/panda-contracts'
import { acquireLock } from '@skanl/panda-lock'
import type { StaleLockBreak } from '@skanl/panda-lock'
import { atomicWriteText } from './atomic-write.ts'
import { strictFaultLocation } from './document-fault.ts'

// The durable ownership ledger (AD-6, correction-01 C2): panda's own record of
// every entry it placed in someone else's file. It lives beside the registry
// store in panda's own directory and follows the same atomic temp+rename
// discipline, but it owns its state alone — @skanl/panda-projection depends on
// @skanl/panda-contracts and nothing else (AD-2), so rendering a config file never
// drags the Registry store or the microkernel in behind it.
//
// The ledger is the ONLY proof of ownership. That is deliberate: no vendor
// schema can reject a record that lives outside the vendor's file, and no
// format has to carry a marker it has nowhere to put.
//
// Failure policy, and it only bends one way. A ledger that cannot be READ is
// treated as "panda has written nothing" for this run, which makes panda report
// its own entries as foreign and touch nothing — recoverable. PERSISTING that
// under-claim is not recoverable: it would orphan every entry panda has ever
// written, in every config, with no way back. So an unreadable ledger is never
// written over; it is reported and left exactly as it is.
//
// Writes MERGE: a run replaces only the records for the target and file it just
// projected, so it can never drop a claim for a target+file pair it did not
// touch. Merging alone is NOT enough, because `update` rewrites the whole
// document from a read taken before it: two interleaved read-modify-writes lose
// one side's claim permanently, and the entry is then a foreign collision
// forever. Serialisation therefore keys on the LEDGER FILE and is process-wide
// — two ProjectionLedger INSTANCES over one path share a queue, which is what
// two concurrent inits in one process actually are.

const LEDGER_FILE_NAME = 'projection-ledger.json'

const RECORD_FIELDS = ['targetId', 'filePath', 'nativeLocation', 'entryId', 'contentHash'] as const

/**
 * Hash of the CANONICAL form of the text panda placed at a native location.
 *
 * EOL is normalised because a file that git, an editor or a formatter rewrites
 * from LF to CRLF has not been edited in any sense a vendor can observe — and
 * `~/.claude.json` is rewritten by Claude Code itself. Treating that as an edit
 * would make panda disown every entry it has in the file. Format-specific
 * canonicalisation (indentation, key order) happens in the strategies, which
 * are the only code that knows what "the same entry" means per format.
 */
export function hashOwnedText(text: string): string {
  return createHash('sha256').update(text.replaceAll('\r\n', '\n'), 'utf8').digest('hex')
}

/**
 * Hash of the exact BYTES panda copied to a path.
 *
 * Deliberately not {@link hashOwnedText}: a materialised file is copied verbatim
 * from a source panda does not author, so "the same file" means the same bytes.
 * Normalising EOL here would let panda overwrite a file whose line endings a
 * user deliberately changed, and — far worse, since this is the delete path —
 * let it REMOVE one.
 */
export function hashOwnedBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The EOL-normalised form of the same bytes, for the OVERWRITE comparison only.
 *
 * Never for a removal. A removal is decided byte for byte, because a false
 * match there precedes `rm`; an overwrite decided byte for byte instead makes
 * a skills root kept under `core.autocrlf` report every panda file as edited
 * forever, and the product has no adopt, force or reclaim path out of that.
 */
export function canonicalBytesHash(bytes: Uint8Array): string {
  return hashOwnedText(Buffer.from(bytes).toString('utf8'))
}

/** Ownership keys must be one canonical spelling of a path, never two. */
export function resolveOwnedPath(filePath: string): string {
  return resolve(filePath)
}

/** win32 paths differ in drive-letter and directory casing between processes. */
export function sameOwnedPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/**
 * Whether `path` is strictly inside `root`. Both arguments must already be
 * resolved — this predicate answers about paths, not about strings a caller
 * hopes are paths.
 *
 * It lives beside {@link resolveOwnedPath} because it is the second half of the
 * same rule: a path panda acts on is CANONICALISED and then proven to be inside
 * the location panda owns. Every caller that skips either half has been a
 * user-data defect — the removal path took raw ledger strings straight to `rm`,
 * and a relative one resolved against the process working directory.
 */
export function isUnderRoot(path: string, root: string): boolean {
  const rest = relative(root, path)
  return rest !== '' && !rest.startsWith('..') && !rest.startsWith(sep + '..')
}

/**
 * The right to replace the WHOLE ownership document without merging.
 *
 * A module-scope symbol rather than a convention: the only way to hold it is to
 * import it, so "one caller" stops being a claim a text scan makes and becomes
 * something the runtime enforces. `test/guard.test.ts` pins who imports it.
 */
export const LEDGER_REPAIR_AUTHORITY: unique symbol = Symbol('panda.projection.ledger.repair')

export type ProjectionLedgerState = 'absent' | 'readable' | 'unreadable'

export interface ProjectionLedgerRead {
  /** `unreadable` means the file exists but panda must not write over it. */
  readonly state: ProjectionLedgerState
  readonly records: readonly ProjectionLedgerRecord[]
  readonly warnings: readonly ProjectionWarning[]
}

/** Everything one target claims in one file — the unit a run replaces. */
export interface ProjectionLedgerScope {
  readonly targetId: string
  readonly filePath: string
}

export interface ProjectionLedgerOptions {
  /** Defaults to the OS home directory. */
  readonly homeDir?: string
  /** Overrides the whole path; the default is `<home>/.panda/projection-ledger.json`. */
  readonly filePath?: string
  /** Bounded wait for the cross-process lock before a coded CONTENTION refusal. */
  readonly lockTimeoutMs?: number
  /**
   * Observes every stale/corrupt-lock break performed on the way to a write.
   *
   * A break is panda deciding that a lock left behind by a dead process no
   * longer protects anything. That decision is REPORTED rather than silent,
   * because it is the one moment where the outer boundary steps aside.
   */
  readonly onStaleLockBreak?: (broken: StaleLockBreak) => void
}

/**
 * A malformed `ownedPaths` makes the WHOLE record invalid, and that direction is
 * the point: a dropped record claims nothing, so panda under-claims and removes
 * nothing. Keeping a record whose path list is half-readable would hand the one
 * operation that deletes a user's files an authority panda cannot vouch for.
 */
function isOwnedPathList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item['path'] === 'string' &&
        item['path'] !== '' &&
        typeof item['contentHash'] === 'string' &&
        item['contentHash'] !== '' &&
        (item['canonicalHash'] === undefined ||
          (typeof item['canonicalHash'] === 'string' && item['canonicalHash'] !== '')),
    )
  )
}

function isLedgerRecord(value: unknown): value is ProjectionLedgerRecord {
  if (!isRecord(value)) return false
  if (!RECORD_FIELDS.every((field) => typeof value[field] === 'string' && value[field] !== '')) {
    return false
  }
  return value['ownedPaths'] === undefined || isOwnedPathList(value['ownedPaths'])
}

function recordKey(record: ProjectionLedgerRecord): string {
  return `${record.targetId}\u0000${record.filePath}\u0000${record.entryId}`
}

/**
 * Stable on-disk order with a total ordering over the record key, so an
 * unchanged ledger really is a byte-unchanged file. Later records win a
 * duplicate key: a run's own output must override whatever it is replacing.
 */
function normalizeRecords(records: readonly ProjectionLedgerRecord[]): ProjectionLedgerRecord[] {
  const deduped = new Map<string, ProjectionLedgerRecord>()
  for (const record of records) deduped.set(recordKey(record), record)
  return [...deduped.values()].sort((a, b) => {
    const left = recordKey(a)
    const right = recordKey(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/**
 * The exact bytes of the ledger document for a record set.
 *
 * Exported so a remediation can PREDICT the document it is about to write and
 * report the byte delta before writing it, using the same serialisation the
 * write itself performs. A second spelling here would let a preview report a
 * size the act does not produce.
 */
export function serialiseLedgerDocument(records: readonly ProjectionLedgerRecord[]): string {
  return JSON.stringify({ version: PROJECTION_LEDGER_VERSION, records: normalizeRecords(records) }, null, 2)
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read-modify-write queues, keyed by resolved ledger path. Module-level on
 * purpose: an instance-level queue serialises one ProjectionLedger object, and
 * every caller that constructs its own — `initMachine` and `initProject` run
 * concurrently, for instance — gets its own object over the SAME file.
 *
 * This is the INNER boundary and it covers one process. The outer one is the
 * `<ledger>.lock` file taken in `#locked`, which covers two panda PROCESSES —
 * that gap used to lose 10 of 24 claims across three measured rounds, silently,
 * with every writer exiting 0. The queue is kept rather than replaced: it is
 * cheaper than a lockfile and it is exactly right for its own case, so the file
 * lock only ever contends between processes.
 */
const LEDGER_QUEUES = new Map<string, Promise<unknown>>()

/**
 * The leaf lock's neutral codes, translated at this package's boundary (AD-7).
 * `@skanl/panda-lock` may not raise a projection code and this package may not
 * publish a `PANDA_LOCK_*` one, so the mapping lives exactly here.
 */
function asLedgerFailure(filePath: string, error: unknown): unknown {
  if (!(error instanceof PandaError)) return error
  if (error.code === PANDA_ERROR_CODES.lockContention) {
    return new PandaError(
      PANDA_ERROR_CODES.projectionLedgerContention,
      `projection ledger '${filePath}' is held by another panda process: ${error.message}`,
      { cause: error },
    )
  }
  if (error.code === PANDA_ERROR_CODES.lockUnavailable) {
    return new PandaError(
      PANDA_ERROR_CODES.projectionLedgerUnavailable,
      `projection ledger '${filePath}' could not be locked for writing: ${error.message}`,
      { cause: error },
    )
  }
  return error
}

export class ProjectionLedger {
  readonly filePath: string
  readonly #queueKey: string
  readonly #lockPath: string
  readonly #lockTimeoutMs: number | undefined
  readonly #onStaleLockBreak: ((broken: StaleLockBreak) => void) | undefined

  constructor(options: ProjectionLedgerOptions = {}) {
    this.filePath = options.filePath ?? join(options.homeDir ?? homedir(), '.panda', LEDGER_FILE_NAME)
    const resolved = resolveOwnedPath(this.filePath)
    this.#queueKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    // Beside the document, like the registry store's. Derived from the RESOLVED
    // path so two processes spelling the same ledger differently — a relative
    // argv, a different drive-letter case on win32 — still contend for one file.
    this.#lockPath = `${resolved}.lock`
    this.#lockTimeoutMs = options.lockTimeoutMs
    this.#onStaleLockBreak = options.onStaleLockBreak
  }

  /** Never throws: the three states are what callers must distinguish. */
  async read(): Promise<ProjectionLedgerRead> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { state: 'absent', records: [], warnings: [] }
      }
      return this.#unreadable(`cannot be read: ${detailOf(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // LOCATED, never quoted (`document-fault.ts`). This ledger holds paths and
      // hashes rather than server arguments, so no leak was measured out of it —
      // and it is brought under the rule anyway, because "no credential happens
      // to sit inside V8's snippet window today" is not a property of the code.
      return this.#unreadable(`is not valid JSON: ${strictFaultLocation(raw)}`)
    }
    if (!isRecord(parsed) || parsed['version'] !== PROJECTION_LEDGER_VERSION) {
      return this.#unreadable(
        `declares version ${JSON.stringify(isRecord(parsed) ? parsed['version'] : undefined)} but this build reads version ${PROJECTION_LEDGER_VERSION}`,
      )
    }
    const records = parsed['records']
    if (!Array.isArray(records)) return this.#unreadable('has no records array')
    // One damaged record is not a damaged ledger: keeping the valid claims
    // keeps panda able to update and remove everything it still recognises.
    const valid = records.filter(isLedgerRecord)
    const dropped = records.length - valid.length
    return {
      state: 'readable',
      records: valid,
      warnings:
        dropped === 0
          ? []
          : [
              {
                code: PANDA_ERROR_CODES.projectionLedgerUnavailable,
                detail: `projection ledger '${this.filePath}' has ${dropped} malformed record(s); those entries are no longer claimed by panda`,
              },
            ],
    }
  }

  /**
   * Replaces this scope's records inside the on-disk document, keeping every
   * other claim. Serialised against concurrent calls on this instance so the
   * read-modify-write window cannot interleave.
   */
  async update(scope: ProjectionLedgerScope, records: readonly ProjectionLedgerRecord[]): Promise<void> {
    await this.#queued(async () => {
      const current = await this.read()
      if (current.state === 'unreadable') {
        throw new PandaError(
          PANDA_ERROR_CODES.projectionLedgerUnavailable,
          `projection ledger '${this.filePath}' became unreadable; refusing to overwrite it and orphan every claim it holds`,
        )
      }
      const kept = current.records.filter(
        (record) =>
          record.targetId !== scope.targetId || !sameOwnedPath(record.filePath, scope.filePath),
      )
      await this.#persist([...kept, ...records])
    })
  }

  /**
   * Replaces ONE entry's record inside one scope, reading the current document
   * INSIDE the queue.
   *
   * The granularity is the point. A caller that read the ledger, decided, and
   * then handed `update` a whole replacement set for the scope would resurrect
   * every claim another writer legitimately dropped in between — panda would
   * then claim a path it does not own, which on the materialisation path is a
   * delete authority. Only the named entry moves here; every sibling claim is
   * whatever the document says at the moment of the write.
   *
   * `record === undefined` drops the entry instead of replacing it.
   */
  async updateEntry(
    scope: ProjectionLedgerScope,
    entryId: string,
    record: ProjectionLedgerRecord | undefined,
  ): Promise<void> {
    await this.#queued(async () => {
      const current = await this.read()
      if (current.state === 'unreadable') {
        throw new PandaError(
          PANDA_ERROR_CODES.projectionLedgerUnavailable,
          `projection ledger '${this.filePath}' became unreadable; refusing to overwrite it and orphan every claim it holds`,
        )
      }
      const kept = current.records.filter(
        (candidate) =>
          candidate.entryId !== entryId ||
          candidate.targetId !== scope.targetId ||
          !sameOwnedPath(resolveOwnedPath(candidate.filePath), scope.filePath),
      )
      await this.#persist(record === undefined ? kept : [...kept, record])
    })
  }

  /**
   * Replaces the WHOLE document with whatever `select` returns for the document
   * as it is INSIDE the queue.
   *
   * This is the one write that does not merge, and it exists for exactly one
   * caller: the user-named `repair` remediation, which is how a ledger holding
   * records panda cannot read stops being a state with no exit. Nothing else may
   * use it — `update` is the merging write every projection performs, and its
   * refusal to overwrite an unreadable ledger is a load-bearing guarantee that
   * this method deliberately does not have. `test/guard.test.ts` pins the caller
   * list, because a second one would silently reintroduce the orphan-every-claim
   * failure Story 2.8 declared terminal.
   *
   * `select` runs INSIDE the queue and is handed the read the write will be
   * based on. A caller that read the document itself and passed the result would
   * destroy every claim written in between — with no merge to save it, which is
   * exactly what makes this method the dangerous one. It may throw to abort the
   * write, which is how `repair` refuses when the document moved under it.
   */
  async rewriteAll(
    authority: typeof LEDGER_REPAIR_AUTHORITY,
    select: (read: ProjectionLedgerRead) => readonly ProjectionLedgerRecord[],
  ): Promise<void> {
    // A CAPABILITY, not a spelling check. The static caller list in
    // `test/guard.test.ts` catches the honest second caller and was evaded by a
    // reviewer with `ledger['rewrite' + 'All']([])` — a scan cannot see a name
    // assembled at runtime. Holding the sentinel can only come from importing
    // it, which both the symbol scan and the package's import graph do see, so
    // the obfuscated route now fails at run time instead of silently working.
    if (authority !== LEDGER_REPAIR_AUTHORITY) {
      throw new PandaError(
        PANDA_ERROR_CODES.projectionLedgerUnavailable,
        `projection ledger '${this.filePath}': rewriting the whole document is reserved for the repair remediation`,
      )
    }
    await this.#queued(async () => {
      await this.#persist(select(await this.read()))
    })
  }

  /** The read-modify-write queue, keyed by ledger path and shared by instances. */
  async #queued(work: () => Promise<void>): Promise<void> {
    const run = (LEDGER_QUEUES.get(this.#queueKey) ?? Promise.resolve()).then(() => this.#locked(work))
    // The chain must survive a rejection, or one failed target would deadlock
    // every later one.
    const settled = run.catch(() => undefined)
    LEDGER_QUEUES.set(this.#queueKey, settled)
    try {
      await run
    } finally {
      // Drop the entry once this is the tail, so a long-lived process does not
      // accumulate one resolved promise per ledger path it ever touched.
      if (LEDGER_QUEUES.get(this.#queueKey) === settled) LEDGER_QUEUES.delete(this.#queueKey)
    }
  }

  /**
   * The OUTER boundary: the whole read-modify-write happens while this process
   * holds `<ledger>.lock`, so a sibling PROCESS cannot read the document, be
   * overtaken, and persist a set that never saw the other's claim. Merging alone
   * never closed that window — the read is what interleaves, and only mutual
   * exclusion over the read AND the write can close it.
   *
   * `finally { release }` mirrors `RegistryStore.#persist` exactly: the lock is
   * given back whether the write succeeded or threw, and a release failure is
   * itself coded rather than swallowed.
   */
  async #locked(work: () => Promise<void>): Promise<void> {
    // The lockfile is created inside this directory; on a fresh machine nothing
    // has created ~/.panda yet, and an exclusive create into a missing directory
    // is an ENOENT the lock would report as an unavailable medium.
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
    } catch (error) {
      throw new PandaError(
        PANDA_ERROR_CODES.projectionLedgerUnavailable,
        `projection ledger '${this.filePath}' could not be written: ${detailOf(error)}`,
        { cause: error },
      )
    }
    const lock = await acquireLock(this.#lockPath, {
      timeoutMs: this.#lockTimeoutMs,
      onStaleBreak: this.#onStaleLockBreak,
    }).catch((error: unknown) => {
      throw asLedgerFailure(this.filePath, error)
    })
    try {
      await work()
    } finally {
      await lock.release().catch((error: unknown) => {
        throw asLedgerFailure(this.filePath, error)
      })
    }
  }

  async #persist(records: readonly ProjectionLedgerRecord[]): Promise<void> {
    try {
      await atomicWriteText(this.filePath, serialiseLedgerDocument(records))
    } catch (error) {
      throw new PandaError(
        PANDA_ERROR_CODES.projectionLedgerUnavailable,
        `projection ledger '${this.filePath}' could not be written: ${detailOf(error)}`,
        { cause: error },
      )
    }
  }

  #unreadable(reason: string): ProjectionLedgerRead {
    return {
      state: 'unreadable',
      records: [],
      warnings: [
        {
          code: PANDA_ERROR_CODES.projectionLedgerUnavailable,
          detail: `projection ledger '${this.filePath}' ${reason}; treating it as if panda had written nothing, and leaving the file untouched`,
        },
      ],
    }
  }
}
