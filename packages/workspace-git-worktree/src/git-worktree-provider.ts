import { realpathSync } from 'node:fs'
import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'
import type { WorkspaceCapability, WorkspaceHandle, WorkspaceProvider } from '@panda/contracts'
import { git } from './git.ts'
import { RECORDS_DIR, WorktreeLedger } from './ledger.ts'
import type { WorktreeRecord } from './ledger.ts'

const WORKTREE_CAPABILITIES: readonly WorkspaceCapability[] = ['read', 'write']

const TREES_DIR = 'trees'

// Ids are generated here (`w-<ordinal>`); acquire() only ever joins this shape
// under the state directory. Windows reserved device names are rejected so an id
// can never name a device instead of a directory — the same guard
// LocalWorkspaceProvider applies, for the same reason.
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const WINDOWS_RESERVED_IDS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export interface GitWorktreeWorkspaceProviderOptions {
  /** The repository worktrees are cut from. */
  readonly repoPath: string
  /** Panda's own directory: the ledger, the ownership records, and the trees. */
  readonly stateDir: string
}

interface Lease {
  released: boolean
}

/**
 * A `WorkspaceProvider` over real `git worktree` checkouts.
 *
 * WHAT MAKES A WORKTREE PANDA'S IS THE RECORD, NOT THE DIRECTORY. Every tree
 * this provider creates gets a durable ownership record under `stateDir`, and
 * `acquire()` answers from that record alone. A directory sitting in the trees
 * folder with no record is classified external and is never read, never
 * modified, and never handed out as a workspace — panda only ever claims what
 * it can prove it created (FR-18, AD-6).
 *
 * NAMES ARE RETIRED PERMANENTLY. Ids come from a monotonic ordinal persisted
 * before the tree is created, so a name that once identified a tree is never
 * issued again — not after removal, not after a crash, not after a restart.
 *
 * Release semantics match the port's lease model and `LocalWorkspaceProvider`:
 * each issued handle may be released exactly once; two simultaneously-live
 * handles to one workspace are independent leases; releasing the SAME handle
 * twice raises PANDA_CONTRACT_WORKSPACE_DOUBLE_RELEASE. After dispose(), every
 * operation raises PANDA_CONTRACT_PROVIDER_DISPOSED, and every tree and record
 * is deliberately left on disk.
 */
export class GitWorktreeWorkspaceProvider implements WorkspaceProvider {
  readonly #repoPath: string
  readonly #stateDir: string
  readonly #ledger: WorktreeLedger
  #disposed = false
  readonly #leases = new WeakMap<WorkspaceHandle, Lease>()

  constructor(options: GitWorktreeWorkspaceProviderOptions) {
    const repoPath = options?.repoPath
    const stateDir = options?.stateDir
    if (typeof repoPath !== 'string' || repoPath.trim().length === 0) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractWorkspaceInvalidHandle,
        'GitWorktreeWorkspaceProvider requires a non-empty string repoPath',
      )
    }
    if (typeof stateDir !== 'string' || stateDir.trim().length === 0) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractWorkspaceInvalidHandle,
        'GitWorktreeWorkspaceProvider requires a non-empty string stateDir',
      )
    }
    this.#repoPath = resolve(repoPath)
    this.#stateDir = resolve(stateDir)
    this.#ledger = new WorktreeLedger(this.#stateDir)
  }

  /**
   * Reserve the name, cut the tree, then record the ownership — in that order.
   *
   * Reserving first is what makes retirement permanent (see
   * `WorktreeLedger.reserveOrdinal`). Recording LAST is the safe direction for
   * the second window: a crash between the tree and the record leaves a
   * directory panda does not claim, which this provider already classifies as
   * external and never touches. The opposite order would leave a record
   * pointing at a tree that does not exist — a claim that is simply false.
   */
  async create(): Promise<WorkspaceHandle> {
    this.#assertActive()
    const ordinal = await this.#ledger.reserveOrdinal()
    const id = `w-${ordinal}`
    const rootPath = join(this.#stateDir, TREES_DIR, id)

    try {
      await mkdir(join(this.#stateDir, TREES_DIR), { recursive: true })
    } catch (error) {
      throw this.#wrapIoFailure('create', error)
    }

    // `--detach`: a worktree per task needs a checkout, not a branch. Branch
    // creation would collide on re-runs, so panda creates none — and Story 4.3
    // (spec M16.A, D1) closed FR-20's branch clause for exactly that reason:
    // with no branch there is no merged branch to delete and no unmerged one to
    // preserve. What removal protects instead is the hazard this shape DOES
    // have, and git does not: a commit made on the detached HEAD, which
    // `git worktree remove` deletes without a word. See `removeWorktree` below.
    await git(this.#repoPath, ['worktree', 'add', '--detach', rootPath])

    await this.#ledger.writeRecord({
      version: 1,
      id,
      ordinal,
      path: rootPath,
      repoPath: this.#repoPath,
      createdAt: new Date().toISOString(),
    })

    return this.#issue(id, rootPath)
  }

  /**
   * The record decides, and it is consulted BEFORE the filesystem.
   *
   * That ordering is the "never auto-modified" clause in executable form: for a
   * directory panda holds no record of, this method has not touched the disk at
   * all by the time it refuses.
   */
  async acquire(id: string): Promise<WorkspaceHandle> {
    this.#assertActive()
    if (typeof id !== 'string' || !WORKSPACE_ID_PATTERN.test(id) || WINDOWS_RESERVED_IDS.test(id)) {
      this.#failUnknownId(id)
    }

    const record = await this.#ledger.readRecord(id)
    if (record === undefined) this.#failUnknownId(id)

    // The record is a claim about a tree; a claim whose tree is gone is not a
    // workspace. lstat (not stat): a symlink where panda left a directory is
    // classified unknown, never followed.
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(record.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') this.#failUnknownId(id)
      throw this.#wrapIoFailure('acquire', error)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) this.#failUnknownId(id)

    return this.#issue(id, record.path)
  }

  async release(handle: WorkspaceHandle): Promise<void> {
    this.#assertActive()
    const lease =
      typeof handle === 'object' && handle !== null ? this.#leases.get(handle) : undefined
    if (!lease) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractWorkspaceInvalidHandle,
        'release() only accepts workspace handles issued by this provider',
      )
    }
    if (lease.released) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractWorkspaceDoubleRelease,
        `workspace '${handle.id}' has already been released through this handle`,
      )
    }
    lease.released = true
  }

  /**
   * Idempotent, and it removes nothing.
   *
   * A worktree outlives the provider by design — that is what makes parallel
   * work resumable. Removing trees here would also make `dispose()` a
   * destructive operation on a path panda might merely have been handed.
   *
   * Tree removal SHIPPED, and it is deliberately not here: it is
   * {@link removeWorktree}, which a user reaches through a verb rather than
   * through the end of a session. Disposal is the end of one run; a removal is
   * a decision, and the two must not be the same event.
   */
  async dispose(): Promise<void> {
    this.#disposed = true
  }

  // Every handle gets its own frozen capabilities copy — no shared mutable array.
  #issue(id: string, rootPath: string): WorkspaceHandle {
    const handle: WorkspaceHandle = Object.freeze({
      id,
      rootPath,
      capabilities: Object.freeze([...WORKTREE_CAPABILITIES]),
    })
    this.#leases.set(handle, { released: false })
    return handle
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new PandaError(
        PANDA_ERROR_CODES.contractProviderDisposed,
        'workspace provider has been disposed and no longer serves workspaces',
      )
    }
  }

  #failUnknownId(id: unknown): never {
    throw new PandaError(
      PANDA_ERROR_CODES.contractWorkspaceUnknownId,
      `unknown workspace id '${String(id)}'`,
    )
  }

  #wrapIoFailure(operation: string, error: unknown): PandaError {
    return new PandaError(
      PANDA_ERROR_CODES.contractWorkspaceUnavailable,
      `git-worktree provider ${operation} failed under '${this.#stateDir}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

// --- Removal (Story 4.3 / spec M16.A) --------------------------------------
//
// A worktree panda made is a worktree panda can take back. Three rules shape
// everything below and none of them is negotiable:
//
//   D2 — panda removes ONLY what its ledger claims. A directory in the trees
//        folder with no `WorktreeRecord` is somebody else's, whatever its name
//        looks like, and is reported rather than touched (AD-6, FR-18).
//   D3 — the intent is recorded DURABLY BEFORE the tree is touched, and the
//        sweep that resolves an interruption is this same function. A sweep
//        that reasoned differently from the remover would be a second answer,
//        and the two would disagree exactly when a user needed them not to.
//   D1 — never destroy work that exists nowhere else. Git already refuses a
//        dirty tree, in its own words, and panda surfaces that refusal rather
//        than translating it. The case git does NOT cover is a detached HEAD
//        carrying a commit no ref contains: `git worktree remove` deletes it
//        silently. That refusal is panda's, and it is the load-bearing half.

/** What a removal did, or would not do. */
export type WorktreeOutcomeKind =
  /** The tree is gone and the record is retired. */
  | 'removed'
  /** There was no tree left to remove; only the record was retired (E6/E8). */
  | 'retired'
  /** Nothing changed, and `error` says why in a code a caller can route on. */
  | 'refused'
  /** Panda's ledger claims no such id, so panda has nothing to remove (D2). */
  | 'unknown'

/**
 * One removal's answer.
 *
 * A REFUSAL IS A VALUE, not a throw. A sweep resolves several leftovers in one
 * pass, and one that aborted at the first refusal would leave the rest of them
 * unresolved — reporting a partial success as a failure, or worse, stopping
 * before the leftover the user actually asked about. The coded error is carried
 * rather than thrown so nothing is lost by returning it (AD-7).
 */
export interface WorktreeOutcome {
  readonly kind: WorktreeOutcomeKind
  readonly id: string
  /** Where panda's record says the tree is; absent when it holds no record. */
  readonly path?: string
  /** The repository the tree was cut from; absent for the same reason. */
  readonly repoPath?: string
  readonly detail: string
  /** Present exactly when nothing was removed: `refused` and `unknown`. */
  readonly error?: PandaError
}

/** A worktree panda's ledger claims and no removal is in flight for. */
export interface ClaimedWorktree {
  readonly id: string
  readonly path: string
  readonly repoPath: string
}

/**
 * A removal that was interrupted between recording its intent and finishing.
 *
 * This is the whole of what the sweep acts on, and it is discovered from panda's
 * OWN durable marker rather than from the shape of anything on disk.
 */
export interface InterruptedRemoval {
  readonly id: string
  readonly path: string
  readonly detail: string
}

/**
 * A directory under the trees folder that no ownership record claims.
 *
 * REPORTED, NEVER REMOVED (D2/E5). It may look exactly like one of panda's —
 * same parent, same `w-<n>` name, a real git worktree inside — and it is still
 * not panda's, because what makes a worktree panda's is the record and never
 * the path.
 */
export interface UnclaimedDirectory {
  readonly id: string
  readonly path: string
}

/** Everything panda can see about one worktree state directory. Read-only. */
export interface WorktreeInspection {
  readonly stateDir: string
  /**
   * The directory names this store owns directly under `stateDir`.
   *
   * DECLARED, because the two shipped providers share one root: `runSession`
   * seeds `workspace.rootDir` with the same path whichever one is mounted, so
   * the local store's own listing of that root sees these and would otherwise
   * report panda's worktrees and panda's ownership proofs as directories panda
   * knows nothing about. A composing caller asks the store which entries are its
   * own rather than spelling `trees` and `records` for itself, which is the same
   * rule `worktreeStateDir` states for the path: the owner decides, everyone
   * else asks.
   *
   * It narrows a REPORT and nothing else. Removal stays record-gated in both
   * stores (D2), so a name here is still refused by `removeLocalWorkspace` for
   * the only reason that matters — it holds no record panda wrote.
   */
  readonly storeDirectories: readonly string[]
  /** Healthy claims. Removal is a decision, so nothing here is ever swept. */
  readonly claimed: readonly ClaimedWorktree[]
  readonly interrupted: readonly InterruptedRemoval[]
  readonly unclaimed: readonly UnclaimedDirectory[]
}

/**
 * What panda holds under one state directory, and what it does NOT hold.
 *
 * It writes nothing — including panda's own directories — so `panda doctor` can
 * report a leftover without becoming the thing that changes it (D4). The verb is
 * the way out; this is only the looking.
 */
export async function inspectWorktrees(stateDir: string): Promise<WorktreeInspection> {
  const resolved = resolve(stateDir)
  const ledger = new WorktreeLedger(resolved)
  const { records, intents } = await ledger.listIds()

  const interrupted: InterruptedRemoval[] = []
  for (const id of intents) {
    const record = await ledger.readRecord(id)
    interrupted.push({
      id,
      path: record?.path ?? join(resolved, TREES_DIR, id),
      detail:
        record === undefined
          ? `a removal of '${id}' was interrupted after its ownership record had already been retired; the marker is all that is left of it`
          : `a removal of '${id}' was interrupted before it finished, so the tree at '${record.path}' is in whatever state that removal left it in`,
    })
  }

  const inFlight = new Set(intents)
  const claimed: ClaimedWorktree[] = []
  for (const id of records) {
    if (inFlight.has(id)) continue
    const record = await ledger.readRecord(id)
    if (record !== undefined) claimed.push({ id, path: record.path, repoPath: record.repoPath })
  }

  const known = new Set(records)
  const unclaimed: UnclaimedDirectory[] = []
  for (const name of await treeDirectories(join(resolved, TREES_DIR))) {
    if (!known.has(name)) unclaimed.push({ id: name, path: join(resolved, TREES_DIR, name) })
  }

  // Read out of the same constants the writers use, never typed out again: a
  // second spelling of this store's own layout is a report that stops matching
  // the store the first time either name changes.
  return { stateDir: resolved, storeDirectories: [RECORDS_DIR, TREES_DIR], claimed, interrupted, unclaimed }
}

/**
 * Removes ONE worktree panda's ledger claims, and retires its record.
 *
 * THE ORDER IS THE CRASH SAFETY (D3): every check that can refuse runs first and
 * touches nothing, then the intent is written durably, then the tree goes, then
 * the record is retired. A process killed anywhere after the intent leaves a
 * marker the next call reads — and the next call is THIS FUNCTION, which is what
 * makes the sweep and a fresh removal one answer instead of two.
 *
 * The ordinal is never freed: `retire` removes the record and leaves
 * `nextOrdinal` alone, so this id names this worktree forever (AD-6, D5).
 */
export async function removeWorktree(stateDir: string, id: string): Promise<WorktreeOutcome> {
  const resolved = resolve(stateDir)
  const ledger = new WorktreeLedger(resolved)
  // The same guard `acquire()` applies, and for a sharper reason here: this id
  // reaches the ledger as a path segment, and a caller's argv is where it comes
  // from. A traversal would make a removal verb read and delete outside panda's
  // own directory.
  if (typeof id !== 'string' || !WORKSPACE_ID_PATTERN.test(id) || WINDOWS_RESERVED_IDS.test(id)) {
    return unknownOutcome(id)
  }

  let record: WorktreeRecord | undefined
  let claimed = false
  try {
    record = await ledger.readRecord(id)
    if (record === undefined) {
      // An intent with no record is the tail of a removal that already
      // succeeded: `retire` drops the record first and the marker second, so
      // this is the window between those two lines. Clearing it finishes the job.
      if ((await ledger.readIntent(id)) === undefined) return unknownOutcome(id)
      await ledger.retire(id)
      return {
        kind: 'retired',
        id,
        detail: `the removal of '${id}' had already retired its ownership record, so panda cleared the marker it left behind and removed nothing`,
      }
    }

    // E9 BEFORE anything else: a repository panda cannot reach is a repository
    // git cannot be asked about, and acting on a tree whose repository is gone
    // would be acting without the one check that protects the user's work.
    await assertRepositoryReachable(record)
    const entry = await worktreeEntryFor(record)
    // D1's load-bearing half, and it runs BEFORE the intent is recorded: a
    // refusal must leave the store exactly as it found it.
    if (entry !== undefined) await assertNothingWouldBeLost(record, entry)

    await ledger.claimRemoval(id)
    claimed = true

    let kind: WorktreeOutcomeKind
    let detail: string
    if (entry !== undefined) {
      // Git's own removal, so git's own refusal: a tree with modified or
      // untracked files raises here carrying the sentence git wrote, and panda
      // does not translate it (D1, correction-01).
      await git(record.repoPath, ['worktree', 'remove', record.path])
      kind = 'removed'
      detail = `removed the worktree at '${record.path}' and retired the record for '${id}'; the ordinal it used is not reused`
    } else if (await directoryExists(record.path)) {
      // Git does not register this path any more, and the directory is still
      // there. That is the state `git worktree remove` itself passes through —
      // it deletes the administrative directory after its clean check and the
      // working tree afterwards — so the remainder here belongs to a removal git
      // had already approved, and finishing it completes that operation.
      //
      // ponytail: panda cannot re-run git's clean check on a directory git no
      // longer knows, so a `.git/worktrees/<id>` deleted BY HAND reaches the
      // same state and would be finished without one. Ceiling accepted: the
      // record is panda's own, the id was named deliberately, and refusing here
      // would leave a directory nothing in the product can take back — the
      // dead end M4.C exists to abolish. Upgrade path: the intent record carries
      // the clean verdict git gave before its admin directory went, and this
      // branch proceeds only when that verdict is present.
      await rm(record.path, { recursive: true, force: true })
      kind = 'removed'
      detail = `git no longer registered '${record.path}' as one of its worktrees, which is what an interrupted 'git worktree remove' leaves behind, so panda removed the remainder and retired the record for '${id}'`
    } else {
      kind = 'retired'
      detail = `the tree at '${record.path}' was already gone, so panda retired the record for '${id}' and removed nothing`
    }

    await ledger.retire(id)
    return { kind, id, path: record.path, repoPath: record.repoPath, detail }
  } catch (error) {
    // A refusal is not an interruption: panda looked, declined, and changed
    // nothing, so the marker it wrote must not outlive the attempt and make the
    // next sweep believe a removal was in flight.
    if (claimed) await ledger.releaseClaim(id).catch(() => {})
    if (!(error instanceof PandaError)) throw error
    return {
      kind: 'refused',
      id,
      ...(record === undefined ? {} : { path: record.path, repoPath: record.repoPath }),
      detail: error.message,
      error,
    }
  }
}

function unknownOutcome(id: string): WorktreeOutcome {
  const error = new PandaError(
    PANDA_ERROR_CODES.contractWorkspaceUnknownId,
    `no ownership record claims the workspace id '${String(id)}', so panda does not own it and will not remove it`,
  )
  return { kind: 'unknown', id: String(id), detail: error.message, error }
}

/**
 * E9. Reported with the repository path and with no git call attempted, because
 * every protection removal rests on is a question only that repository answers.
 */
async function assertRepositoryReachable(record: WorktreeRecord): Promise<void> {
  const reachable = await stat(record.repoPath).then(
    (info) => info.isDirectory(),
    () => false,
  )
  if (reachable) return
  throw new PandaError(
    PANDA_ERROR_CODES.contractWorkspaceRemovalRefused,
    `refusing to remove '${record.id}': the repository it was cut from, '${record.repoPath}', is not there, so git cannot be asked whether the tree at '${record.path}' still holds work`,
  )
}

/**
 * D1's load-bearing half, and the whole reason this story is not "call git".
 *
 * MEASURED, at spec M16.A's base commit, against real git: a worktree whose
 * detached HEAD carries a commit is removed by `git worktree remove` SILENTLY,
 * exit 0, no warning — and `git branch --contains <sha>` then names zero
 * branches. The commit is reachable from nothing and is gc bait. Git guards the
 * dirty tree and does not guard this, so panda does.
 *
 * `for-each-ref --contains` and not `branch --contains`: a tag, a remote-tracking
 * ref or a note keeps a commit just as well as a branch does, and refusing to
 * remove a tree whose commit is already tagged would be panda refusing
 * everything. It is deliberately NOT `rev-list --not --all` either — `--all`
 * includes the HEAD of every other worktree, so that spelling calls the commit
 * reachable *because it is checked out here*, which is exactly the case this
 * exists to catch. (Both spellings driven, each with its control, before this
 * one was chosen.)
 */
async function assertNothingWouldBeLost(record: WorktreeRecord, entry: WorktreeEntry): Promise<void> {
  if (entry.head === undefined) return
  const refs = await git(record.repoPath, [
    'for-each-ref',
    '--contains',
    entry.head,
    '--format=%(refname)',
  ])
  if (refs.trim() !== '') return
  throw new PandaError(
    PANDA_ERROR_CODES.contractWorkspaceRemovalRefused,
    `refusing to remove '${record.id}': its HEAD is at commit ${entry.head} and no ref in '${record.repoPath}' contains it, so removing the tree would leave that commit reachable from nothing. Git removes this without a word; panda will not. Give the commit a ref first — 'git -C ${record.repoPath} branch <name> ${entry.head}' does it — and ask again`,
  )
}

interface WorktreeEntry {
  readonly path: string
  readonly head?: string
  readonly detached: boolean
}

/**
 * Git's OWN answer for one record's path, or `undefined` when git does not
 * register that path as a worktree at all.
 *
 * `git worktree list --porcelain` rather than looking at the directory: the
 * criterion for "is this still a worktree" belongs to git, and its listing is
 * also where the checked-out HEAD comes from — one call, one moment, no second
 * reading of a file git owns.
 */
async function worktreeEntryFor(record: WorktreeRecord): Promise<WorktreeEntry | undefined> {
  const listing = await git(record.repoPath, ['worktree', 'list', '--porcelain'])
  const wanted = pathKeys(record.path)
  for (const entry of parseWorktreeList(listing)) {
    for (const key of pathKeys(entry.path)) {
      if (wanted.has(key)) return entry
    }
  }
  return undefined
}

/** The porcelain listing: blocks of `<keyword>[ <value>]`, blank-line separated. */
function parseWorktreeList(listing: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let path: string | undefined
  let head: string | undefined
  let detached = false
  const flush = (): void => {
    if (path !== undefined) entries.push({ path, ...(head === undefined ? {} : { head }), detached })
    path = undefined
    head = undefined
    detached = false
  }
  for (const line of listing.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush()
      path = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim()
    else if (line.trim() === 'detached') detached = true
  }
  flush()
  return entries
}

/**
 * Every spelling of one path that another spelling of it might be compared
 * against. Git prints forward slashes and its own idea of the real path where
 * `path.resolve` produces backslashes and whatever the caller was handed —
 * which on Windows can still be an 8.3 alias — so comparing the raw strings
 * fails for the spelling rather than for the fact.
 *
 * `realpathSync.native` and not the promise form: `.native` is what resolves an
 * 8.3 alias, and it is absent on the promises API. It THROWS for a path that is
 * gone, which is an ordinary state here (the tree may already be removed), so
 * the resolved spelling is always present as well.
 */
function pathKeys(path: string): Set<string> {
  const keys = new Set<string>()
  const add = (value: string): void => {
    keys.add(process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value)
  }
  add(resolve(path))
  try {
    add(realpathSync.native(path))
  } catch {
    // Gone, or not reachable: the resolved spelling is the only key there is.
  }
  return keys
}

async function directoryExists(path: string): Promise<boolean> {
  return await stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  )
}

/** Directory entries under the trees folder; an absent folder holds none. */
async function treeDirectories(treesDir: string): Promise<string[]> {
  try {
    const entries = await readdir(treesDir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw new PandaError(
      PANDA_ERROR_CODES.contractWorkspaceUnavailable,
      `git-worktree provider could not list the trees under '${treesDir}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}
