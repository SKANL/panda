import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PandaError, PANDA_ERROR_CODES } from '@skanl/panda-contracts'

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

/**
 * The durable INTENT to remove one worktree, written before anything is touched.
 *
 * Its own file rather than a field on the record, and the reason is exclusivity:
 * it is created with `wx` (O_EXCL), so exactly one contender per host wins the
 * removal and every other one gets a coded refusal naming the holder. A flag
 * inside the record would need a read-modify-write, which two processes can
 * interleave — the same reasoning `@skanl/panda-registry`'s lockfile rests on, whose
 * rule this matches rather than answering a second time.
 *
 * It doubles as the crash marker: a process killed between writing this and
 * finishing leaves the file behind, and that is exactly what the sweep looks for.
 */
export interface WorktreeRemovalIntent {
  readonly version: 1
  readonly id: string
  readonly pid: number
  readonly host: string
  readonly startedAt: string
}

const LEDGER_FILE = 'worktrees.json'
/**
 * EXPORTED so `inspectWorktrees` can declare this store's own footprint under a
 * shared state directory without spelling the name a second time.
 */
export const RECORDS_DIR = 'records'
const RECORD_SUFFIX = '.json'
/**
 * Longer than the suffix above ON PURPOSE, and stripped first everywhere: an
 * intent file also ends in `.json`, so a listing that tested the record suffix
 * first would report `w-3.removing` as a worktree with that id.
 */
const INTENT_SUFFIX = '.removing.json'

/**
 * How long a removal intent whose holder still looks alive is believed.
 *
 * Taken from `@skanl/panda-registry`'s `DEFAULT_MAX_AGE_MS` rather than chosen here,
 * and for its reason: a pid on a long-lived machine gets reused, and without an
 * age fallback a reused pid would make one interrupted removal unresolvable
 * forever — a state panda reports and cannot leave, which is what M4.C abolishes.
 */
const INTENT_MAX_AGE_MS = 30 * 60 * 1000

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

  /**
   * Every id this store holds an ownership record for, and every id it holds a
   * removal INTENT for — read from one directory listing so the two answers
   * cannot come from two different moments.
   *
   * An entry it cannot classify is left out rather than guessed at: the atomic
   * writer above lands `<uuid>.tmp` files here, and a crash during a write can
   * leave one behind.
   */
  async listIds(): Promise<{ records: string[]; intents: string[] }> {
    let entries: string[]
    try {
      entries = await readdir(join(this.stateDir, RECORDS_DIR))
    } catch (error) {
      // No records directory is a store that has issued nothing, not a failure.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { records: [], intents: [] }
      throw this.#unreadable('ownership records', error)
    }
    const records: string[] = []
    const intents: string[] = []
    for (const entry of entries) {
      // Intents FIRST: `w-3.removing.json` also ends in `.json`.
      if (entry.endsWith(INTENT_SUFFIX)) intents.push(entry.slice(0, -INTENT_SUFFIX.length))
      else if (entry.endsWith(RECORD_SUFFIX)) records.push(entry.slice(0, -RECORD_SUFFIX.length))
    }
    return { records: records.sort(), intents: intents.sort() }
  }

  /** The removal intent for an id, or `undefined` when none was ever written. */
  async readIntent(id: string): Promise<WorktreeRemovalIntent | undefined> {
    let raw: string
    try {
      raw = await readFile(this.#intentPath(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
      throw this.#unreadable(`removal intent for '${id}'`, error)
    }
    // A CORRUPT intent is not absence and is not a live holder either: it is a
    // marker some process wrote and did not finish — an empty file is exactly
    // what a crash between the exclusive create and the write leaves. It is
    // treated as a holder panda cannot identify, dated by the FILE's own mtime
    // so the age fallback gives it the same grace `@skanl/panda-registry` gives a
    // corrupt lockfile. Reading it as absence would let two removals run.
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isIntentShape(parsed)) return parsed
    } catch {
      // fall through
    }
    const writtenAt = await stat(this.#intentPath(id)).then(
      (info) => info.mtimeMs,
      () => 0,
    )
    return { version: 1, id, pid: 0, host: '', startedAt: new Date(writtenAt).toISOString() }
  }

  /**
   * Records the intent to remove `id`, exclusively.
   *
   * `wx` is the whole mechanism: the file either did not exist and is now ours,
   * or somebody else holds the removal. A holder that is provably dead on THIS
   * host, or older than {@link INTENT_MAX_AGE_MS}, is taken over — that is the
   * interrupted removal being resumed, and it is the same call a fresh removal
   * makes, so the sweep and the remover cannot drift apart. Anything else is
   * contention, coded, naming the holder.
   *
   * ponytail: a healthy intent written by ANOTHER host is never taken over,
   * because panda cannot see that machine's processes — the identical ceiling
   * `@skanl/panda-registry`'s lock accepts, with the identical consequence (a state
   * dir on a network share needs the age fallback to expire). Upgrade path: the
   * same one that lock records.
   */
  async claimRemoval(id: string): Promise<WorktreeRemovalIntent> {
    const intent: WorktreeRemovalIntent = {
      version: 1,
      id,
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    }
    const path = this.#intentPath(id)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(dirname(path), { recursive: true })
        const handle = await open(path, 'wx')
        try {
          await handle.writeFile(`${JSON.stringify(intent, null, 2)}\n`, 'utf8')
        } finally {
          await handle.close()
        }
        return intent
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw new PandaError(
            PANDA_ERROR_CODES.contractWorkspaceUnavailable,
            `git-worktree provider could not record the intent to remove '${id}': ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
      }
      const holder = await this.readIntent(id)
      if (holder === undefined) continue // released between our create and our read
      if (!isStale(holder)) {
        throw new PandaError(
          PANDA_ERROR_CODES.contractWorkspaceContention,
          `the removal of workspace '${id}' is held by ${holder.pid}@${holder.host} since ${holder.startedAt}; another panda process is mid-removal`,
        )
      }
      // Stale: take it over by overwriting in place. `writeJson` renames over
      // the target, so no window exists where the intent is absent — losing the
      // marker mid-takeover is exactly the crash this file exists to survive.
      await this.#writeJson(path, intent)
      return intent
    }
    throw new PandaError(
      PANDA_ERROR_CODES.contractWorkspaceContention,
      `the removal of workspace '${id}' could not be claimed; another panda process is mid-removal`,
    )
  }

  /**
   * Drops a removal intent this process holds, leaving the record in place.
   *
   * For a REFUSAL, which is not an interruption: panda looked, declined, and
   * changed nothing — so leaving the marker behind would make the next sweep
   * think a removal was in flight when none ever started.
   */
  async releaseClaim(id: string): Promise<void> {
    const holder = await this.readIntent(id)
    // Never unlink a successor's claim: after the age fallback another process
    // may legitimately hold it, and this one has no business removing it.
    if (holder === undefined || holder.pid !== process.pid || holder.host !== hostname()) return
    await this.#unlinkIfPresent(this.#intentPath(id))
  }

  /**
   * Retires an id permanently: the ownership record first, then the intent.
   *
   * THAT ORDER IS THE INVARIANT. A crash between the two leaves an intent with
   * no record, which the sweep reads as "the removal already finished" and
   * clears. The opposite order leaves a record with nothing marking it, which
   * nothing would ever look at again.
   *
   * The ordinal is NOT freed — `nextOrdinal` only increases (AD-6), so the name
   * this id used is never issued to another worktree.
   */
  async retire(id: string): Promise<void> {
    await this.#unlinkIfPresent(this.#recordPath(id))
    await this.#unlinkIfPresent(this.#intentPath(id))
  }

  get #ledgerPath(): string {
    return join(this.stateDir, LEDGER_FILE)
  }

  #recordPath(id: string): string {
    return join(this.stateDir, RECORDS_DIR, `${id}${RECORD_SUFFIX}`)
  }

  #intentPath(id: string): string {
    return join(this.stateDir, RECORDS_DIR, `${id}${INTENT_SUFFIX}`)
  }

  async #unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      throw new PandaError(
        PANDA_ERROR_CODES.contractWorkspaceUnavailable,
        `git-worktree provider could not remove '${path}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
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
   * NOT `@skanl/panda-projection`'s `atomicWriteText`, and deliberately so: that one
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

function isIntentShape(value: unknown): value is WorktreeRemovalIntent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['id'] === 'string' &&
    candidate['id'].length > 0 &&
    Number.isSafeInteger(candidate['pid']) &&
    typeof candidate['host'] === 'string' &&
    typeof candidate['startedAt'] === 'string'
  )
}

/**
 * Whether a removal intent may be taken over: its holder is provably gone on
 * THIS machine, or it has outlived {@link INTENT_MAX_AGE_MS}.
 *
 * `process.kill(pid, 0)` throwing EPERM means the process exists under another
 * user — alive. Only ESRCH proves it is gone, which is `@skanl/panda-registry`'s rule
 * and is not restated here for a second time by accident.
 */
function isStale(intent: WorktreeRemovalIntent): boolean {
  const started = Date.parse(intent.startedAt)
  if (!Number.isFinite(started) || Date.now() - started > INTENT_MAX_AGE_MS) return true
  if (intent.host !== hostname()) return false
  if (!Number.isSafeInteger(intent.pid) || intent.pid <= 0) return true
  try {
    process.kill(intent.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH'
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
