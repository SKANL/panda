import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PandaError, PANDA_ERROR_CODES } from '@skanl/panda-contracts'
import {
  LOCAL_WORKSPACE_RECORD_FILE,
  WINDOWS_RESERVED_IDS,
  WORKSPACE_ID_PATTERN,
  type LocalWorkspaceRecord,
} from './local-workspace-provider.ts'

// Taking back a workspace panda made (spec M27.A). ONE rule shapes everything
// below and it is not negotiable:
//
//   D2 — panda removes a directory IF AND ONLY IF that directory holds a record
//        panda wrote. A directory without one is reported and never touched,
//        whatever its name looks like (AD-6). This is the same REPORTED, NEVER
//        REMOVED clause `git-worktree-provider.ts:297-303` states in its own
//        words: what makes a workspace panda's is the record and never the path.
//
// It is not bookkeeping, and the measurement that forced it is worth restating:
// `runSession` seeds BOTH shipped providers with the same `rootDir`
// (`run-session.ts:364`), and `LocalWorkspaceProvider.acquire` consults no
// record — it tests the id pattern and `lstat`s. Driven at the base commit, with
// a control:
//
//     acquire('trees')     -> caps=read+write  path=<root>/trees
//     acquire('records')   -> caps=read+write  path=<root>/records
//     CONTROL no-such-dir  -> REFUSED PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID
//
// Those two are the git-worktree provider's own worktrees and its ownership
// proofs. A removal keyed on a PATH would make `panda workspace remove trees`
// delete every worktree in the project. `workspace.rootDir` is a user-writable
// config key, so no path-shaped rule closes that class either — only the record
// does.
//
// Nothing here is the port. `WorkspaceProvider` has no `remove()` and gains
// none (D1): these are free functions a verb calls by name, exactly as
// `removeWorktree`/`inspectWorktrees` are, and for the reason `dispose()`'s own
// doc gives — disposal is the end of one run, a removal is a decision.

/** What a removal did, or would not do. A subset of `WorktreeOutcomeKind`. */
export type LocalWorkspaceOutcomeKind =
  /** The directory is gone, and its record went with it in the same operation. */
  | 'removed'
  /** Nothing changed, and `error` says why in a code a caller can route on. */
  | 'refused'
  /** No record claims this id, so panda does not own it and will not remove it. */
  | 'unknown'

/**
 * One removal's answer, structurally a `WorktreeOutcome` so one CLI formatter
 * prints both stores. A REFUSAL IS A VALUE, not a throw, for the reason the
 * worktree pair states: a sweep that aborted at the first refusal would leave
 * every later leftover unreported.
 */
export interface LocalWorkspaceOutcome {
  readonly kind: LocalWorkspaceOutcomeKind
  readonly id: string
  /** The directory panda looked at; absent only when the id could name none. */
  readonly path?: string
  readonly detail: string
  /** Present exactly when nothing was removed: `refused` and `unknown`. */
  readonly error?: PandaError
}

/** A workspace directory panda's own record claims. */
export interface ClaimedLocalWorkspace {
  readonly id: string
  readonly path: string
}

/**
 * A directory under the workspace root that no ownership record claims.
 *
 * REPORTED, NEVER REMOVED (D2/E3/E8). Every `.panda/workspaces/<uuid>` that
 * existed before M27.A is here and stays here: inferring ownership from the UUID
 * shape is exactly the AD-6 violation this verb exists to avoid, and there is no
 * honest way out of it. It is self-liquidating — every workspace made after this
 * change carries a record (D5).
 */
export interface UnclaimedLocalDirectory {
  readonly id: string
  readonly path: string
  /** Why panda holds no claim: no record at all, or one it cannot use (E8). */
  readonly detail: string
}

export interface InspectLocalWorkspacesOptions {
  /**
   * Directory names directly under the root that belong to ANOTHER panda store
   * and must not be reported as local leftovers.
   *
   * The two shipped providers share one root — `runSession` seeds
   * `workspace.rootDir` with the same path whichever is mounted — so a listing
   * of that root sees the git-worktree store's `trees` and `records`. Reporting
   * them as directories panda knows nothing about would be false, and the caller
   * that composes both stores is the one that can ask each for its own footprint
   * (`WorktreeInspection.storeDirectories`). This package deliberately does not
   * spell those names: it has no business knowing another provider's layout, and
   * a hard-coded list here is the same drift `worktreeStateDir` exists to avoid.
   *
   * IT NARROWS THE REPORT AND NOTHING ELSE. {@link removeLocalWorkspace} does
   * not take it and never will: a name that appears here is refused for the only
   * reason that may ever refuse or permit a removal — whether the directory
   * holds a record panda wrote (D2). E4/E5 pass no ignore list at all.
   */
  readonly ignore?: readonly string[]
}

/** Everything panda can see under one local workspace root. Read-only. */
export interface LocalWorkspaceInspection {
  readonly rootDir: string
  /** Healthy claims. Removal is a decision, so nothing here is ever swept. */
  readonly claimed: readonly ClaimedLocalWorkspace[]
  readonly unclaimed: readonly UnclaimedLocalDirectory[]
}

/**
 * What panda holds under one workspace root, and what it does NOT hold.
 *
 * It writes nothing — including panda's own directories — so a report can name a
 * leftover without becoming the thing that changes it. The verb is the way out;
 * this is only the looking.
 *
 * There is no `interrupted` category and there is no sweep to resolve one. A
 * local removal is a single `rm -rf` of the directory that holds its own proof,
 * so a process killed mid-removal leaves either the whole workspace or none of
 * it — never a half-state some other code path has to reason about.
 */
export async function inspectLocalWorkspaces(
  rootDir: string,
  options: InspectLocalWorkspacesOptions = {},
): Promise<LocalWorkspaceInspection> {
  const resolved = resolve(rootDir)
  const elsewhere = new Set(options.ignore ?? [])
  const claimed: ClaimedLocalWorkspace[] = []
  const unclaimed: UnclaimedLocalDirectory[] = []
  for (const name of await workspaceDirectories(resolved)) {
    if (elsewhere.has(name)) continue
    const path = join(resolved, name)
    let record: LocalWorkspaceRecord | undefined
    try {
      record = await readLocalWorkspaceRecord(path, name)
    } catch (error) {
      // E8. A record that EXISTS and cannot be used is not absence, and the two
      // must not be reported with the same sentence: one directory predates
      // panda's records, the other holds one panda wrote and can no longer read.
      unclaimed.push({ id: name, path, detail: describe(error) })
      continue
    }
    if (record === undefined) {
      unclaimed.push({
        id: name,
        path,
        // The sentence does not START with `panda ` on purpose: `packages/cli/`
        // `test/printed-commands.test.ts` scans every shipped string that does
        // and dispatches it as a verb, so a message opening that way is read as
        // a command the binary must have.
        detail: `there is no ownership record inside this directory, so it predates panda's ownership records or was made by something else; nothing here will remove it`,
      })
      continue
    }
    claimed.push({ id: name, path })
  }
  return { rootDir: resolved, claimed, unclaimed }
}

/**
 * Removes ONE local workspace panda's own record claims.
 *
 * The record is READ FIRST and the directory is removed only if that read
 * succeeded — D2, and the order is the whole of it. Nothing durable is written
 * before the removal because nothing needs to be: the directory and the proof
 * that it is panda's go in one operation.
 */
export async function removeLocalWorkspace(
  rootDir: string,
  id: string,
): Promise<LocalWorkspaceOutcome> {
  const resolved = resolve(rootDir)
  // The same guard `acquire()` applies, imported rather than restated, and for a
  // sharper reason here: this id reaches `join()` from a caller's argv, and a
  // traversal would make a removal verb delete outside panda's own root.
  if (typeof id !== 'string' || !WORKSPACE_ID_PATTERN.test(id) || WINDOWS_RESERVED_IDS.test(id)) {
    return unknownOutcome(id)
  }
  const path = join(resolved, id)

  // lstat, not stat, matching `acquire()`: a symlink under the root is
  // classified unknown and never followed. Removing it would be removing
  // something panda did not make even when its target holds a record.
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    return unknownOutcome(id, path)
  }

  let record: LocalWorkspaceRecord | undefined
  try {
    record = await readLocalWorkspaceRecord(path, id)
  } catch (error) {
    // E8: reported, not removed, and the refusal names the path. A corrupt
    // record read as absence would be the same answer as "not panda's", which
    // is exactly the reclassification that must never happen silently.
    const refusal =
      error instanceof PandaError
        ? error
        : new PandaError(PANDA_ERROR_CODES.contractWorkspaceRemovalRefused, describe(error))
    return { kind: 'refused', id, path, detail: refusal.message, error: refusal }
  }
  if (record === undefined) return unknownOutcome(id, path)

  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    const refusal = new PandaError(
      PANDA_ERROR_CODES.contractWorkspaceUnavailable,
      `refusing to report '${id}' as removed: panda could not remove the directory at '${path}': ${describe(error)}`,
      { cause: error },
    )
    return { kind: 'refused', id, path, detail: refusal.message, error: refusal }
  }
  return {
    kind: 'removed',
    id,
    path,
    detail: `removed the workspace at '${path}', and the ownership record inside it went with it`,
  }
}

/**
 * The record inside one workspace directory, or `undefined` when it holds none.
 *
 * Absence is a fact, not a failure: it is the answer that classifies a directory
 * as not panda's. A record that EXISTS and cannot be parsed, or that names a
 * different id, is a different answer entirely and raises — the same split
 * `WorktreeLedger.readRecord` makes, and for the same reason: treating a corrupt
 * record as absence would reclassify one of panda's own workspaces as somebody
 * else's, and here that reclassification is the only thing standing between a
 * verb and a directory.
 *
 * `record.path` is deliberately NOT compared against `path`. It is the directory
 * as it was when panda made it, and a project that has since been moved or
 * renamed would fail an equality check on every one of its own workspaces.
 */
async function readLocalWorkspaceRecord(
  path: string,
  id: string,
): Promise<LocalWorkspaceRecord | undefined> {
  const recordPath = join(path, LOCAL_WORKSPACE_RECORD_FILE)
  let raw: string
  try {
    raw = await readFile(recordPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw new PandaError(
      PANDA_ERROR_CODES.contractWorkspaceUnavailable,
      `refusing to remove '${id}': panda could not read the ownership record at '${recordPath}': ${describe(error)}`,
      { cause: error },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw unusable(id, recordPath, 'it is not readable as JSON')
  }
  if (!isRecordShape(parsed)) throw unusable(id, recordPath, 'it is not shaped like one panda wrote')
  if (parsed.id !== id) {
    throw unusable(id, recordPath, `it claims the workspace id '${parsed.id}' instead`)
  }
  return parsed
}

function unusable(id: string, recordPath: string, why: string): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.contractWorkspaceRemovalRefused,
    `refusing to remove '${id}': the ownership record at '${recordPath}' is present and unusable because ${why}. Panda removes a directory only when it can read its own proof that it made it, and a record it cannot read is not that proof`,
  )
}

function unknownOutcome(id: unknown, path?: string): LocalWorkspaceOutcome {
  const error = new PandaError(
    PANDA_ERROR_CODES.contractWorkspaceUnknownId,
    `no ownership record claims the workspace id '${String(id)}', so panda does not own it and will not remove it`,
  )
  return {
    kind: 'unknown',
    id: String(id),
    ...(path === undefined ? {} : { path }),
    detail: error.message,
    error,
  }
}

/**
 * Directory entries directly under the workspace root.
 *
 * `withFileTypes`, so a symlink is not a directory here either — the same rule
 * `acquire()` and the removal apply, stated once per operation rather than
 * inferred from a `stat` that would follow it.
 *
 * An absent root is a store that has issued nothing, not a failure.
 */
async function workspaceDirectories(rootDir: string): Promise<string[]> {
  try {
    return (await readdir(rootDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw new PandaError(
      PANDA_ERROR_CODES.contractWorkspaceUnavailable,
      `the workspace root '${rootDir}' could not be read: ${describe(error)}`,
      { cause: error },
    )
  }
}

function isRecordShape(value: unknown): value is LocalWorkspaceRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate['id'] === 'string' &&
    candidate['id'].length > 0 &&
    typeof candidate['path'] === 'string' &&
    candidate['path'].length > 0 &&
    typeof candidate['createdAt'] === 'string'
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
