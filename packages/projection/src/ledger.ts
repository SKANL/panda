import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PANDA_ERROR_CODES, PandaError, PROJECTION_LEDGER_VERSION, isRecord } from '@panda/contracts'
import type { ProjectionLedgerRecord, ProjectionWarning } from '@panda/contracts'
import { atomicWriteText } from './atomic-write.ts'

// The durable ownership ledger (AD-6, correction-01 C2): panda's own record of
// every entry it placed in someone else's file. It lives beside the registry
// store in panda's own directory and follows the same atomic temp+rename
// discipline, but it owns its state alone — @panda/projection depends on
// @panda/contracts and nothing else (AD-2), so rendering a config file never
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

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read-modify-write queues, keyed by resolved ledger path. Module-level on
 * purpose: an instance-level queue serialises one ProjectionLedger object, and
 * every caller that constructs its own — `initMachine` and `initProject` run
 * concurrently, for instance — gets its own object over the SAME file.
 *
 * ponytail: in-process only, so two panda PROCESSES can still interleave and
 * lose a claim. A cross-process lock cannot be borrowed from @panda/registry
 * (AD-2/AD-7: that edge was removed in Story 2.8 and leaked PANDA_REGISTRY_*
 * codes out of a projection API); extracting a leaf lock package with its own
 * codes is the upgrade path, recorded in deferred-work.md.
 */
const LEDGER_QUEUES = new Map<string, Promise<unknown>>()

export class ProjectionLedger {
  readonly filePath: string
  readonly #queueKey: string

  constructor(options: ProjectionLedgerOptions = {}) {
    this.filePath = options.filePath ?? join(options.homeDir ?? homedir(), '.panda', LEDGER_FILE_NAME)
    const resolved = resolveOwnedPath(this.filePath)
    this.#queueKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
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
    } catch (error) {
      return this.#unreadable(`is not valid JSON: ${detailOf(error)}`)
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
    const run = (LEDGER_QUEUES.get(this.#queueKey) ?? Promise.resolve()).then(async () => {
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

  async #persist(records: readonly ProjectionLedgerRecord[]): Promise<void> {
    try {
      // The temp file is created inside this directory; on a fresh machine
      // nothing has created ~/.panda yet.
      await mkdir(dirname(this.filePath), { recursive: true })
      await atomicWriteText(
        this.filePath,
        JSON.stringify({ version: PROJECTION_LEDGER_VERSION, records: normalizeRecords(records) }, null, 2),
      )
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
