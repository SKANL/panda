import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'
import { acquireLock as acquireFileLock } from '@panda/lock'
import type { LockHolder, LockOptions, StaleLockBreak } from '@panda/lock'

// The lockfile protocol itself now lives in `@panda/lock`, a leaf below both
// this package and `@panda/projection`. What stayed here is the TRANSLATION,
// and it is the whole reason the move was safe: `acquireLock` is on this
// package's published surface, so a consumer that catches it must go on seeing
// `PANDA_REGISTRY_CONTENTION` and `PANDA_REGISTRY_STORE_UNAVAILABLE` from the
// same five situations they came from before. AD-7 forbids the opposite
// arrangement — a leaf raising a sibling's codes — which is exactly why the
// borrowed-from-registry lock the ledger wanted was refused for years.
//
// Routing is on `error.code`, never on message text.

export type { LockHolder, LockOptions, StaleLockBreak }

/** Unchanged name and shape: this interface is published from `./index.ts`. */
export interface RegistryLock {
  readonly path: string
  readonly holder: LockHolder
  release(): Promise<void>
}

function asRegistryFailure(error: unknown): unknown {
  if (!(error instanceof PandaError)) return error
  if (error.code === PANDA_ERROR_CODES.lockContention) {
    return new PandaError(PANDA_ERROR_CODES.registryContention, error.message, { cause: error })
  }
  if (error.code === PANDA_ERROR_CODES.lockUnavailable) {
    return new PandaError(PANDA_ERROR_CODES.registryStoreUnavailable, error.message, { cause: error })
  }
  return error
}

/**
 * Acquires the registry's lockfile at `path`. Behaviour is the leaf's, verbatim;
 * only the two codes change on the way out — release included, because a
 * release failure is one of the five situations that used to be a
 * `registryStoreUnavailable` and must stay one.
 */
export async function acquireLock(path: string, options: LockOptions = {}): Promise<RegistryLock> {
  const lock = await acquireFileLock(path, options).catch((error: unknown) => {
    throw asRegistryFailure(error)
  })
  return {
    path: lock.path,
    holder: lock.holder,
    release: () =>
      lock.release().catch((error: unknown) => {
        throw asRegistryFailure(error)
      }),
  }
}
