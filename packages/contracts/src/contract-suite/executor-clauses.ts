import { PandaError, PANDA_ERROR_CODES } from '../errors'
import { RESULT_ENVELOPE_SCHEMA } from '../executor'
import type { ExecutorAdapter, RunRequest } from '../executor'
import { validateRunRequest } from '../executor'
import { describeThrown, failWith, pass } from './clause'
import type { Clause } from './clause'
import type { WorkspaceHandle } from '../workspace'

export const EXECUTOR_SUITE = 'executor-adapter'

// Probe inputs the suite drives adapters with, deeply frozen so a misbehaving
// adapter cannot corrupt subsequent clauses. The probe workspace handle is a
// placeholder: the harness never touches its rootPath.
export const CONTRACT_PROBE_WORKSPACE_HANDLE: WorkspaceHandle = Object.freeze({
  id: 'panda-contract-probe',
  rootPath: '/panda-contract-probe',
  capabilities: Object.freeze(['read', 'write'] as const),
})

export const CONTRACT_PROBE_REQUEST: RunRequest = Object.freeze({
  prompt: 'panda contract-suite probe run',
  workspace: CONTRACT_PROBE_WORKSPACE_HANDLE,
})

const MALFORMED_REQUEST = Object.freeze({
  prompt: '',
  workspace: { id: '', rootPath: '', capabilities: [] },
})

async function invoke(adapter: ExecutorAdapter): Promise<{ ok: true; envelopePromise: Promise<unknown> } | { ok: false; detail: string }> {
  if (typeof adapter.run !== 'function') {
    return { ok: false, detail: 'adapter exposes no run(request) method' }
  }
  let pending: Promise<unknown>
  try {
    pending = adapter.run(CONTRACT_PROBE_REQUEST)
  } catch (error) {
    return { ok: false, detail: `run threw synchronously instead of returning a promise: ${describeThrown(error)}` }
  }
  if (typeof (pending as { then?: unknown })?.then !== 'function') {
    return { ok: false, detail: 'run must return a promise' }
  }
  return { ok: true, envelopePromise: pending }
}

export const EXECUTOR_CLAUSES: readonly Clause<ExecutorAdapter>[] = [
  {
    name: 'request-schema-conformance',
    check: async () => {
      // The suite's own probe input must satisfy the run-request contract...
      try {
        validateRunRequest(CONTRACT_PROBE_REQUEST)
      } catch (error) {
        return failWith(`probe request fails validateRunRequest: ${describeThrown(error)}`)
      }
      // ...and the validator must reject malformed requests with the canonical code.
      try {
        validateRunRequest(MALFORMED_REQUEST)
        return failWith('validateRunRequest accepted a malformed request')
      } catch (error) {
        if (error instanceof PandaError && error.code === PANDA_ERROR_CODES.contractEnvelopeInvalid) return pass()
        return failWith(`malformed request rejected with unexpected error: ${describeThrown(error)}`)
      }
    },
  },
  {
    name: 'exposes-async-run',
    check: async (adapter) => {
      const invoked = await invoke(adapter)
      if (!invoked.ok) return failWith(invoked.detail)
      await invoked.envelopePromise.catch(() => undefined)
      return pass()
    },
  },
  {
    name: 'envelope-conformance',
    check: async (adapter) => {
      const invoked = await invoke(adapter)
      if (!invoked.ok) return failWith(invoked.detail)
      let envelope: unknown
      try {
        envelope = await invoked.envelopePromise
      } catch (error) {
        return failWith(`run rejected instead of returning an envelope: ${describeThrown(error)}`)
      }
      const result = await RESULT_ENVELOPE_SCHEMA['~standard'].validate(envelope)
      if (result.issues) {
        const codeName = PANDA_ERROR_CODES.contractEnvelopeInvalid
        return failWith(`envelope violates the result envelope schema (${codeName}): ${result.issues.map((entry) => entry.message).join('; ')}`)
      }
      return pass()
    },
  },
  {
    name: 'ok-envelope-completeness',
    check: async (adapter) => {
      const invoked = await invoke(adapter)
      if (!invoked.ok) return failWith(invoked.detail)
      let envelope: unknown
      try {
        envelope = await invoked.envelopePromise
      } catch (error) {
        return failWith(`run rejected: ${describeThrown(error)}`)
      }
      if ((envelope as { status?: unknown })?.status !== 'ok') return pass()
      const record = envelope as Record<string, unknown>
      if (!('data' in record)) return failWith("ok envelope omits required 'data'")
      if (typeof record['summary'] !== 'string' || record['summary'].trim().length === 0) {
        return failWith('ok envelope carries no usable summary')
      }
      return pass()
    },
  },
  {
    name: 'failure-envelope-completeness',
    check: async (adapter) => {
      const invoked = await invoke(adapter)
      if (!invoked.ok) return failWith(invoked.detail)
      let envelope: unknown
      try {
        envelope = await invoked.envelopePromise
      } catch (error) {
        return failWith(`run rejected: ${describeThrown(error)}`)
      }
      if ((envelope as { status?: unknown })?.status !== 'failed') return pass()
      const errors = (envelope as Record<string, unknown>)['errors']
      if (!Array.isArray(errors) || errors.length === 0) {
        return failWith("failed envelope carries no 'errors' entries")
      }
      return pass()
    },
  },
]

