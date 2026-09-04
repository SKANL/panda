import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PandaError, PANDA_ERROR_CODES } from '../errors.ts'
import { WORKSPACE_HANDLE_SCHEMA } from '../workspace.ts'
import type { WorkspaceHandle, WorkspaceProvider } from '../workspace.ts'
import { describeThrown, failWith, pass } from './clause.ts'
import type { Clause, ClauseOutcome } from './clause.ts'

export const WORKSPACE_SUITE = 'workspace-provider'

function expectRejection(
  action: string,
  expectedCode: string,
  attempt: Promise<unknown>,
): Promise<ClauseOutcome> {
  return attempt.then(
    () => failWith(`${action} was expected to reject with ${expectedCode} but resolved`),
    (error: unknown) => {
      if (error instanceof PandaError && error.code === expectedCode) return pass()
      const actual =
        error instanceof PandaError
          ? `code ${error.code}`
          : `non-coded error: ${describeThrown(error)}`
      return failWith(`${action} rejected with ${actual}, expected ${expectedCode}`)
    },
  )
}

async function bestEffortRelease(provider: WorkspaceProvider, handle: WorkspaceHandle): Promise<void> {
  try {
    await provider.release(handle)
  } catch {
    // Cleanup only; clause verdicts come from the checks themselves.
  }
}

const FORGED_HANDLE: WorkspaceHandle = Object.freeze({
  id: 'not-issued-by-any-provider',
  rootPath: '/forged',
  capabilities: ['read'] as const,
})

// NOTE: the final two clauses dispose the subject provider. They are ordered last
// so a compliant provider still passes the full aggregate run.
export const WORKSPACE_CLAUSES: readonly Clause<WorkspaceProvider>[] = [
  {
    name: 'create-yields-valid-handle',
    check: async (provider) => {
      const first = await provider.create()
      const second = await provider.create()
      try {
        for (const handle of [first, second]) {
          const result = await WORKSPACE_HANDLE_SCHEMA['~standard'].validate(handle)
          if (result.issues) {
            return failWith(`created handle violates the handle schema: ${result.issues.map((entry) => entry.message).join('; ')}`)
          }
        }
        if (first.id === second.id) return failWith('two create() calls returned the same workspace id')
      } finally {
        await bestEffortRelease(provider, second)
        await bestEffortRelease(provider, first)
      }
      return pass()
    },
  },
  {
    name: 'acquire-roundtrip',
    check: async (provider) => {
      const created = await provider.create()
      try {
        const acquired = await provider.acquire(created.id)
        try {
          const mismatches: string[] = []
          if (acquired.id !== created.id) mismatches.push(`id (${String(acquired.id)} != ${String(created.id)})`)
          if (acquired.rootPath !== created.rootPath) mismatches.push('rootPath')
          // Exact capability-set comparison — no duplicate-tolerant subset checks.
          const sameCapabilities =
            acquired.capabilities.length === created.capabilities.length &&
            created.capabilities.every((capability) => acquired.capabilities.includes(capability)) &&
            acquired.capabilities.every((capability) => created.capabilities.includes(capability))
          if (!sameCapabilities) mismatches.push('capabilities')
          if (mismatches.length > 0) return failWith(`acquired handle differs from created handle in: ${mismatches.join(', ')}`)
        } finally {
          await bestEffortRelease(provider, acquired)
        }
      } finally {
        await bestEffortRelease(provider, created)
      }
      return pass()
    },
  },
  {
    name: 'acquire-unknown-id-rejected',
    check: (provider) =>
      expectRejection(
        'acquire() of an unknown id',
        PANDA_ERROR_CODES.contractWorkspaceUnknownId,
        provider.acquire(`panda-missing-${randomUUID()}`),
      ),
  },
  {
    // AD-7 at the port's own edge: an id that is not a string has to leave
    // through the SAME coded door as one that names nothing. The cast is
    // deliberate and is the point of the clause — this port is reachable from
    // untyped JavaScript and from a parsed document, where `null` is a value
    // rather than a type error, and a provider that lets it reach `path.join`
    // throws an UNCODED `TypeError [ERR_INVALID_ARG_TYPE]` out of an API whose
    // entire contract is coded refusals. A regex is not the guard: `/^[A-Za-z0-9]/`
    // stringifies its argument, so `test(null)` answers `true` for "null".
    name: 'acquire-non-string-id-rejected',
    check: (provider) =>
      expectRejection(
        'acquire() of a non-string id',
        PANDA_ERROR_CODES.contractWorkspaceUnknownId,
        provider.acquire(null as unknown as string),
      ),
  },
  {
    name: 'release-forged-handle-rejected',
    check: (provider) =>
      expectRejection(
        'release() of a forged handle',
        PANDA_ERROR_CODES.contractWorkspaceInvalidHandle,
        provider.release(FORGED_HANDLE),
      ),
  },
  {
    name: 'double-release-rejected',
    check: async (provider) => {
      const handle = await provider.create()
      await provider.release(handle)
      return expectRejection(
        'second release() of the same handle',
        PANDA_ERROR_CODES.contractWorkspaceDoubleRelease,
        provider.release(handle),
      )
    },
  },
  {
    name: 'state-persists-across-sessions',
    check: async (provider) => {
      const created = await provider.create()
      const payload = `persisted-${randomUUID()}`
      try {
        await writeFile(join(created.rootPath, '.panda-contract-state'), payload, 'utf8')
        await provider.release(created)
        const reacquired = await provider.acquire(created.id)
        try {
          const readBack = await readFile(join(reacquired.rootPath, '.panda-contract-state'), 'utf8')
          if (readBack !== payload) {
            return failWith('state written before release did not survive release + re-acquire intact')
          }
        } finally {
          await bestEffortRelease(provider, reacquired)
        }
      } finally {
        await bestEffortRelease(provider, created)
      }
      return pass()
    },
  },
  {
    name: 'dispose-idempotent-preserves-state',
    check: async (provider) => {
      const handle = await provider.create()
      const payload = `durable-${randomUUID()}`
      await writeFile(join(handle.rootPath, '.panda-contract-state'), payload, 'utf8')
      try {
        await provider.dispose()
        await provider.dispose()
      } catch (error) {
        return failWith(`dispose() must be idempotent and resolve: ${describeThrown(error)}`)
      }
      try {
        await stat(handle.rootPath)
      } catch (error) {
        return failWith(`workspace state vanished after double dispose: ${describeThrown(error)}`)
      }
      return pass()
    },
  },
  {
    name: 'disposed-provider-rejects-operations',
    check: async (provider) => {
      // Tolerates arriving on an already-disposed subject (aggregate run order);
      // independent runs take the live path and dispose here themselves.
      let outstanding: WorkspaceHandle | undefined
      try {
        outstanding = await provider.create()
      } catch (error) {
        if (!(error instanceof PandaError && error.code === PANDA_ERROR_CODES.contractProviderDisposed)) {
          return failWith(`create() before dispose failed unexpectedly: ${describeThrown(error)}`)
        }
      }
      try {
        await provider.dispose()
      } catch (error) {
        return failWith(`dispose() rejected unexpectedly: ${describeThrown(error)}`)
      }
      const code = PANDA_ERROR_CODES.contractProviderDisposed
      // THUNKS, not promises. An array literal of calls starts every one of them
      // before the loop's first `await`, and the `return` below abandons the ones
      // it never reached — whose rejections then have no handler and surface as an
      // unhandled rejection in the CONSUMER's process. That is the failure path of
      // a suite whose whole job is to diagnose a non-conformant provider: the
      // report is correct and the process still dies. Invisible to every in-repo
      // run, because panda's own providers PASS this clause and therefore await
      // all three; measured from a packed tarball against a half-right subject.
      for (const [action, attempt] of [
        ['create() after dispose', () => provider.create()],
        ['acquire() after dispose', () => provider.acquire('panda-post-dispose-probe')],
        [
          'release() of an outstanding handle after dispose',
          () => provider.release(outstanding ?? FORGED_HANDLE),
        ],
      ] as const) {
        const outcome = await expectRejection(action, code, attempt())
        if (!outcome.ok) return outcome
      }
      return pass()
    },
  },
]
