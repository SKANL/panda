import { lstat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'
import type { WorkspaceCapability, WorkspaceHandle, WorkspaceProvider } from '@panda/contracts'
import { git } from './git.ts'
import { WorktreeLedger } from './ledger.ts'

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
    // creation would collide on re-runs and make branch cleanup part of this
    // story; branch lifecycle belongs to crash-safe disposal (Story 4.3).
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
   * destructive operation on a path panda might merely have been handed; tree
   * removal is Story 4.3, where it can be crash-safe and branch-aware.
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
