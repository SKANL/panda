import { randomUUID } from 'node:crypto'
import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'

// Hand-rolled portable lockfile protocol for machine-scoped write serialization
// (no locking dependency). A lock is a file at the caller's chosen path, created
// with O_EXCL semantics so exactly one contender wins per host, containing JSON
// `{ pid, host, acquiredAt, token }`. Contenders poll until a bounded timeout
// and then fail with a typed CONTENTION error naming the holder.
//
// This code was MOVED here from `@panda/registry`, unchanged apart from its
// error codes and the word "registry" leaving its messages. It is a leaf: it
// depends on `@panda/contracts` and nothing else (AD-2), so any package can
// serialize writes to a file without importing a sibling's domain — which is
// what `@panda/projection`'s ledger needed and could not have.
//
// The codes are NEUTRAL on purpose (AD-7): a lock owned by no domain may not
// raise another package's code. Callers translate `lockContention` and
// `lockUnavailable` into their own vocabulary at their own boundary, which is
// how `@panda/registry` goes on raising exactly the two codes it always did.
//
// Staleness rules:
// - SAME HOST: the holder pid is provably dead (`process.kill(pid, 0)` fails
//   with ESRCH), OR the lock age exceeds `maxAgeMs` — the age fallback defends
//   against pid reuse on long-lived machines.
// - ANY HOST: a CORRUPT lockfile (unreadable JSON, malformed holder fields) is
//   breakable once its file age exceeds `corruptGraceMs`; before that window
//   contenders get CONTENTION with an 'unreadable lockfile' detail.
// A healthy cross-host lock is never considered stale — we cannot see other
// machines' processes.

const DEFAULT_LOCK_TIMEOUT_MS = 2_000
const DEFAULT_LOCK_POLL_MS = 25
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000
const DEFAULT_CORRUPT_GRACE_MS = 60 * 1000

export interface LockHolder {
  readonly pid: number
  readonly host: string
  readonly acquiredAt: string
  /** Random acquire-time identity used by release to never unlink a successor's lock. */
  readonly token: string
}

export interface StaleLockBreak {
  readonly path: string
  /** Holder metadata when the lockfile was readable; undefined when corrupt. */
  readonly holder: LockHolder | undefined
  readonly evidence: string
}

export interface LockOptions {
  /** Bounded wait before giving up with CONTENTION. */
  readonly timeoutMs?: number
  readonly pollMs?: number
  /** Same-host locks older than this are broken even if their pid looks alive. */
  readonly maxAgeMs?: number
  /** Corrupt lockfiles younger than this are treated as held (not broken). */
  readonly corruptGraceMs?: number
  /** Observes every stale/corrupt-lock break performed on the way to acquisition. */
  readonly onStaleBreak?: (broken: StaleLockBreak) => void
  /**
   * Injection seam for release-race tests: invoked after release renames the
   * lockfile away but before it verifies ownership of the renamed file.
   */
  readonly beforeReleaseVerify?: (renamedPath: string) => void | Promise<void>
}

export interface FileLock {
  readonly path: string
  readonly holder: LockHolder
  release(): Promise<void>
}

type LockFileState =
  | { readonly kind: 'held'; readonly holder: LockHolder }
  | { readonly kind: 'corrupt'; readonly reason: string }
  | { readonly kind: 'missing' }

function currentHolder(): LockHolder {
  const pid = process.pid
  // Never write a holder document a staleness check could not trust.
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new PandaError(
      PANDA_ERROR_CODES.lockUnavailable,
      `cannot acquire lock: process pid ${pid} is not a positive integer`,
    )
  }
  return { pid, host: hostname(), acquiredAt: new Date().toISOString(), token: randomUUID() }
}

async function readLockFile(path: string): Promise<LockFileState> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    // The holder released between our failed create and this read; treat as no lock.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    throw unavailable('read', path, error)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.host !== 'string' ||
      typeof parsed.acquiredAt !== 'string' ||
      typeof parsed.token !== 'string'
    ) {
      return { kind: 'corrupt', reason: 'lockfile does not contain a valid holder document' }
    }
    return {
      kind: 'held',
      holder: {
        pid: parsed.pid,
        host: parsed.host,
        acquiredAt: parsed.acquiredAt,
        token: parsed.token,
      },
    }
  } catch {
    return { kind: 'corrupt', reason: 'lockfile contains truncated or invalid JSON' }
  }
}

function isHolderDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists but is owned by another user: alive.
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function contention(path: string, state: LockFileState): PandaError {
  if (state.kind === 'corrupt') {
    return new PandaError(
      PANDA_ERROR_CODES.lockContention,
      `lock '${path}' names an unreadable lockfile (${state.reason}); will become breakable after the corrupt grace period`,
    )
  }
  const named =
    state.kind === 'held' ? `${state.holder.pid}@${state.holder.host}` : 'a vanished lockfile'
  return new PandaError(
    PANDA_ERROR_CODES.lockContention,
    `lock '${path}' is held by ${named}; another panda process is mid-mutation`,
  )
}

function unavailable(operation: string, path: string, cause: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.lockUnavailable,
    `lock ${operation} failed on '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  )
}

async function breakLock(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw unavailable('stale-break', path, error)
  }
}

/**
 * Acquires the lockfile at `path`, polling up to `timeoutMs`. The holder
 * document is written through the SAME exclusive handle that created the file
 * and only then closed — a contender can never observe an empty lock created
 * by us; if that write fails we remove our own lockfile and rethrow coded.
 */
export async function acquireLock(path: string, options: LockOptions = {}): Promise<FileLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_LOCK_POLL_MS)
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const corruptGraceMs = options.corruptGraceMs ?? DEFAULT_CORRUPT_GRACE_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new PandaError(
      PANDA_ERROR_CODES.lockUnavailable,
      `invalid lock options for '${path}': timeoutMs and maxAgeMs must be finite non-negative numbers`,
    )
  }
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const handle = await open(path, 'wx').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return undefined
      throw unavailable('create', path, error)
    })
    if (handle !== undefined) {
      const holder = currentHolder()
      try {
        await handle.writeFile(JSON.stringify(holder))
      } catch (error) {
        // Orphan-proofing: never leave our own empty lock behind.
        await unlink(path).catch(() => {})
        throw unavailable('write', path, error)
      } finally {
        await handle.close()
      }
      return {
        path,
        holder,
        async release() {
          await releaseAcquired(path, holder, options)
        },
      }
    }

    const state = await readLockFile(path)

    if (state.kind === 'held') {
      const sameHost = state.holder.host === hostname()
      const ageExceeded = Date.now() - Date.parse(state.holder.acquiredAt) > maxAgeMs
      if (sameHost && (isHolderDead(state.holder.pid) || ageExceeded)) {
        const why = isHolderDead(state.holder.pid)
          ? `holder ${state.holder.pid}@${state.holder.host} is provably dead on this machine (process.kill(${state.holder.pid}, 0) === ESRCH)`
          : `holder ${state.holder.pid}@${state.holder.host} exceeded maxAgeMs (${maxAgeMs}ms); pid may have been reused`
        const broken: StaleLockBreak = { path, holder: state.holder, evidence: `${why}; breaking stale lock` }
        await breakLock(path)
        options.onStaleBreak?.(broken)
        continue
      }
    } else if (state.kind === 'corrupt') {
      const mtimeMs = await stat(path).then(
        (info) => info.mtimeMs,
        (error: NodeJS.ErrnoException) => {
          // Vanished between the read and the stat: retry from the top.
          if (error.code === 'ENOENT') return Number.NaN
          throw unavailable('stat', path, error)
        },
      )
      if (!Number.isNaN(mtimeMs) && Date.now() - mtimeMs > corruptGraceMs) {
        const broken: StaleLockBreak = {
          path,
          holder: undefined,
          evidence: `lockfile is corrupt (${state.reason}) and older than corruptGraceMs (${corruptGraceMs}ms); breaking regardless of host`,
        }
        await breakLock(path)
        options.onStaleBreak?.(broken)
        continue
      }
    } else {
      // Missing: released between our failed create and the read; retry at once.
      continue
    }

    if (Date.now() >= deadline) throw contention(path, state)
    await sleep(pollMs)
  }
}

/**
 * Ownership-safe release: rename the lockfile away FIRST, then re-read the
 * renamed file and unlink it ONLY if it still carries our token; otherwise we
 * lost an acquisition race to a successor and must put their lock back.
 */
async function releaseAcquired(path: string, holder: LockHolder, options: LockOptions): Promise<void> {
  const renamedPath = `${path}.${randomUUID()}.releasing`
  let current: LockFileState
  try {
    await rename(path, renamedPath)
    await options.beforeReleaseVerify?.(renamedPath)
    current = await readLockFile(renamedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw unavailable('release', path, error)
  }

  if (current.kind === 'held' && current.holder.token === holder.token) {
    try {
      await unlink(renamedPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw unavailable('release', path, error)
      }
    }
    return
  }

  // Not ours anymore (or corrupt): restore whatever we renamed so the real
  // holder's lock keeps protecting the store.
  await rename(renamedPath, path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw unavailable('release', path, error)
  })
}
