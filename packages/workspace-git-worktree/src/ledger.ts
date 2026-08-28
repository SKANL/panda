import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'

/** The durable proof that a worktree is panda's. */
export interface WorktreeRecord {
  readonly version: 1
  readonly id: string
  readonly ordinal: number
  /** Absolute path of the worktree directory. */
  readonly path: string
  /** Absolute path of the repository the worktree was cut from. */
  readonly repoPath: string
  readonly createdAt: string
}

interface LedgerDocument {
  readonly version: 1
  /** The next ordinal that may be issued. Only ever increases. */
  readonly nextOrdinal: number
}

const LEDGER_FILE = 'worktrees.json'
const RECORDS_DIR = 'records'

/**
 * RECORDS LIVE IN PANDA'S STATE DIRECTORY, NEVER INSIDE THE WORKTREE.
 *
 * The obvious alternative — a marker file inside the checkout — makes every
 * panda worktree permanently dirty: the file shows up as untracked in
 * `git status`, in every diff the user takes, and in anything that refuses to
 * operate on an unclean tree. The other alternative, git's own per-worktree
 * admin directory, is a structure git owns and panda does not write into.
 *
 * So the record stays here, beside the ledger, and carries the absolute
 * worktree path. "A directory lacking the record" is answered by asking panda's
 * own store, which is the only store panda is entitled to trust.
 */

/**
 * Read-modify-write queues, keyed by resolved state directory. Module-level for
 * the same reason `ProjectionLedger` does it: an instance-level queue serialises
 * one provider OBJECT, and two providers constructed over the same directory
 * would each hold their own — which is exactly the pair that must not both
 * reserve the same ordinal.
 *
 * ponytail: in-process only, so two panda PROCESSES can still interleave. The
 * consequence here is bounded and non-destructive — both would read the same
 * `nextOrdinal` and the second `git worktree add` fails on an existing path,
 * surfacing as a coded refusal rather than two trees sharing a name. A
 * cross-process lock is the same leaf-package upgrade path already recorded for
 * the projection ledger; see deferred-work.md.
 */
const LEDGER_QUEUES = new Map<string, Promise<unknown>>()

export class WorktreeLedger {
  readonly stateDir: string
  readonly #queueKey: string

  constructor(stateDir: string) {
    this.stateDir = resolve(stateDir)
    this.#queueKey = process.platform === 'win32' ? this.stateDir.toLowerCase() : this.stateDir
  }

  /**
   * Reserves the next ordinal and PERSISTS the advance before returning it.
   *
   * The ordering is the whole invariant. The caller creates a worktree only
   * after this resolves, so a crash between the two leaks an ordinal — which is
   * harmless, because the entire point of a monotonic counter is that ordinals
   * are never reused. Persisting AFTER creation would do the opposite: the
   * crash would reissue a name that already named a tree, and AD-6 says a name
   * identifies exactly one thing forever.
   */
  async reserveOrdinal(): Promise<number> {
    return this.#queued(async () => {
      const document = await this.#read()
      const ordinal = document.nextOrdinal
      await this.#writeJson(this.#ledgerPath, { version: 1, nextOrdinal: ordinal + 1 })
      return ordinal
    })
  }

  async writeRecord(record: WorktreeRecord): Promise<void> {
    await this.#writeJson(this.#recordPath(record.id), record)
  }

  /**
   * The record for an id, or `undefined` when panda holds none.
   *
   * Absence is a fact, not a failure: it is the answer that classifies a
   * directory as external. A record that EXISTS and cannot be parsed is a
   * different answer entirely and raises, because silently treating a corrupt
   * record as absence would reclassify one of panda's own worktrees as somebody
   * else's.
   */
  async readRecord(id: string): Promise<WorktreeRecord | undefined> {
    let raw: string
    try {
      raw = await readFile(this.#recordPath(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
      throw this.#unreadable(`ownership record for '${id}'`, error)
    }
    const parsed: unknown = parseOrThrow(raw, () => this.#unusable(`ownership record for '${id}'`))
    if (!isRecordShape(parsed)) throw this.#unusable(`ownership record for '${id}'`)
    return parsed
  }

  get #ledgerPath(): string {
    return join(this.stateDir, LEDGER_FILE)
  }

  #recordPath(id: string): string {
    return join(this.stateDir, RECORDS_DIR, `${id}.json`)
  }

  /**
   * An absent ledger is a store that has issued nothing yet — ordinal 0.
   *
   * An UNREADABLE or malformed one is not, and must never fall back to that
   * same zero: restarting the counter reissues every name the store ever
   * handed out. This is the one silent failure this file exists to refuse.
   */
  async #read(): Promise<LedgerDocument> {
    let raw: string
    try {
      raw = await readFile(this.#ledgerPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: 1, nextOrdinal: 0 }
      throw this.#unreadable('worktree ledger', error)
    }
    const parsed: unknown = parseOrThrow(raw, () => this.#unusable('worktree ledger'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Number.isSafeInteger((parsed as { nextOrdinal?: unknown }).nextOrdinal) ||
      (parsed as { nextOrdinal: number }).nextOrdinal < 0
    ) {
      throw this.#unusable('worktree ledger')
    }
    return { version: 1, nextOrdinal: (parsed as { nextOrdinal: number }).nextOrdinal }
  }

  /**
   * Temp file in the destination directory, then rename over the target.
   *
   * NOT `@panda/projection`'s `atomicWriteText`, and deliberately so: that one
   * resolves symlinks and copies file modes because it writes into VENDOR-owned
   * dotfiles a user may have linked into a repository, and it raises
   * `PANDA_PROJECTION_NATIVE_UNCLAIMABLE` when it cannot. Neither hazard exists
   * for a file inside a directory panda created, and importing it would leak
   * `PANDA_PROJECTION_*` codes out of a workspace API — the leak Story 2.8
   * removed from the registry/projection edge. Same three lines of mechanism,
   * different problem.
   */
  async #writeJson(path: string, value: unknown): Promise<void> {
    const directory = dirname(path)
    const temp = join(directory, `${randomUUID()}.tmp`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await rename(temp, path)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw new PandaError(
        PANDA_ERROR_CODES.contractWorkspaceUnavailable,
        `git-worktree provider could not write '${path}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  #unreadable(what: string, error: unknown): PandaError {
    return new PandaError(
      PANDA_ERROR_CODES.contractWorkspaceUnavailable,
      `git-worktree provider could not read the ${what} under '${this.stateDir}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  #unusable(what: string): PandaError {
    return new PandaError(
      PANDA_ERROR_CODES.contractWorkspaceUnavailable,
      `the ${what} under '${this.stateDir}' is present but unusable; refusing to continue, because treating it as empty would reissue names this store has already handed out`,
    )
  }

  /** Generalised from ProjectionLedger's `#queued`, which serialises no result. */
  async #queued<T>(work: () => Promise<T>): Promise<T> {
    const run = (LEDGER_QUEUES.get(this.#queueKey) ?? Promise.resolve()).then(work)
    // The chain must survive a rejection, or one failed reservation would
    // deadlock every later one.
    const settled = run.catch(() => undefined)
    LEDGER_QUEUES.set(this.#queueKey, settled)
    try {
      return await run
    } finally {
      if (LEDGER_QUEUES.get(this.#queueKey) === settled) LEDGER_QUEUES.delete(this.#queueKey)
    }
  }
}

function parseOrThrow(raw: string, fail: () => PandaError): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw fail()
  }
}

function isRecordShape(value: unknown): value is WorktreeRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['id'] === 'string' &&
    candidate['id'].length > 0 &&
    Number.isSafeInteger(candidate['ordinal']) &&
    typeof candidate['path'] === 'string' &&
    candidate['path'].length > 0 &&
    typeof candidate['repoPath'] === 'string' &&
    candidate['repoPath'].length > 0 &&
    typeof candidate['createdAt'] === 'string'
  )
}
