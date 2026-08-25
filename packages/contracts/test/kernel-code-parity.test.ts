import { describe, expect, it } from 'vitest'
import {
  ActionDeniedError,
  ActionInvalidError,
  BudgetExceededError,
  CycleDetectedError,
  InvalidLayerError,
  InvalidScopeError,
  LogRecordInvalidError,
  ManifestInvalidError,
  PluginInactiveError,
  PluginStartFailedError,
  ReemitDuringFanoutError,
  ServiceConflictError,
  ServiceNotProvidedError,
  StageFailedError,
  SwapRejectedError,
  KERNEL_ERROR_CODES,
  createMemoryLogSink,
  loadPlugins,
  validateManifest,
} from '@panda/kernel'
import { PANDA_ERROR_CODES } from '../src'

// Temporary local helpers until the shared contract-test harness lands (Story 1.4); they move there.
const passthroughSchema = {
  '~standard': { version: 1 as const, validate: (value: unknown) => ({ value }) },
}

function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'plugin-a',
    version: '1.0.0',
    provides: [],
    consumes: [],
    configSchema: passthroughSchema,
    ...overrides,
  }
}

// loadPlugins requires a record sink; these clauses only care about the codes it
// raises, but each gets its own so no state leaks between them.
const sink = createMemoryLogSink

describe('kernel error-code parity with canonical contracts constants', () => {
  it('emits PANDA_KERNEL_MANIFEST_INVALID for invalid manifests', () => {
    expect(() => validateManifest({})).toThrow(ManifestInvalidError)
    try {
      validateManifest({})
      expect.unreachable()
    } catch (error) {
      // Dual assertion (canonical constant AND verbatim literal) is deliberate drift detection:
      // if either table changes independently, this suite fails before consumers see a renamed code.
      expect((error as { code: string }).code).toBe(PANDA_ERROR_CODES.kernelManifestInvalid)
      expect((error as { code: string }).code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
    }
  })

  it('emits PANDA_KERNEL_CYCLE_DETECTED for dependency cycles', () => {
    expect(() =>
      loadPlugins([
        manifest({ id: 'a', provides: ['svc.a'], consumes: [{ service: 'svc.b', mode: 'hard' }] }),
        manifest({ id: 'b', provides: ['svc.b'], consumes: [{ service: 'svc.a', mode: 'hard' }] }),
      ], sink()),
    ).toThrow(CycleDetectedError)
    try {
      loadPlugins([
        manifest({ id: 'a', provides: ['svc.a'], consumes: [{ service: 'svc.b', mode: 'hard' }] }),
        manifest({ id: 'b', provides: ['svc.b'], consumes: [{ service: 'svc.a', mode: 'hard' }] }),
      ], sink())
      expect.unreachable()
    } catch (error) {
      expect((error as { code: string }).code).toBe(PANDA_ERROR_CODES.kernelCycleDetected)
      expect((error as { code: string }).code).toBe('PANDA_KERNEL_CYCLE_DETECTED')
    }
  })

  it('emits PANDA_KERNEL_SERVICE_NOT_PROVIDED when a hard-consumed service has no provider', () => {
    const result = loadPlugins([manifest({ id: 'b', consumes: [{ service: 'svc.gone', mode: 'hard' }] })], sink())
    expect(result.failures[0]?.error).toBeInstanceOf(ServiceNotProvidedError)
    expect(result.failures[0]?.error.code).toBe(PANDA_ERROR_CODES.kernelServiceNotProvided)
    expect(result.failures[0]?.error.code).toBe('PANDA_KERNEL_SERVICE_NOT_PROVIDED')
  })

  it('emits PANDA_KERNEL_SERVICE_CONFLICT when two plugins provide the same service', () => {
    expect(() =>
      loadPlugins([
        manifest({ id: 'first', provides: ['svc.dup'] }),
        manifest({ id: 'second', provides: ['svc.dup'] }),
      ], sink()),
    ).toThrow(ServiceConflictError)
    try {
      loadPlugins([
        manifest({ id: 'first', provides: ['svc.dup'] }),
        manifest({ id: 'second', provides: ['svc.dup'] }),
      ], sink())
      expect.unreachable()
    } catch (error) {
      expect((error as { code: string }).code).toBe(PANDA_ERROR_CODES.kernelServiceConflict)
      expect((error as { code: string }).code).toBe('PANDA_KERNEL_SERVICE_CONFLICT')
    }
  })

  it('pins PANDA_KERNEL_PLUGIN_INACTIVE to the canonical constant', () => {
    const error = new PluginInactiveError('p', 'detail')
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelPluginInactive)
    expect(error.code).toBe('PANDA_KERNEL_PLUGIN_INACTIVE')
  })

  it('pins PANDA_KERNEL_PLUGIN_START_FAILED to the canonical constant', () => {
    const error = new PluginStartFailedError('p', 'detail')
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelPluginStartFailed)
    expect(error.code).toBe('PANDA_KERNEL_PLUGIN_START_FAILED')
  })

  it('pins PANDA_KERNEL_SWAP_REJECTED to the canonical constant', () => {
    const error = new SwapRejectedError('p', ['issue'])
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelSwapRejected)
    expect(error.code).toBe('PANDA_KERNEL_SWAP_REJECTED')
  })

  it('pins PANDA_KERNEL_REEMIT_DURING_FANOUT to the canonical constant', () => {
    const error = new ReemitDuringFanoutError()
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelReemitDuringFanout)
    expect(error.code).toBe('PANDA_KERNEL_REEMIT_DURING_FANOUT')
  })

  it('pins PANDA_KERNEL_INVALID_SCOPE to the canonical constant', () => {
    const error = new InvalidScopeError('tenant', 'unknown scope')
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelInvalidScope)
    expect(error.code).toBe('PANDA_KERNEL_INVALID_SCOPE')
  })

  it('pins PANDA_KERNEL_INVALID_LAYER to the canonical constant', () => {
    const error = new InvalidLayerError('tenant', 'unknown layer')
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelInvalidLayer)
    expect(error.code).toBe('PANDA_KERNEL_INVALID_LAYER')
  })

  it('pins PANDA_KERNEL_LOG_RECORD_INVALID to the canonical constant', () => {
    const error = new LogRecordInvalidError('payload', 'is not part of the closed record shape')
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelLogRecordInvalid)
    expect(error.code).toBe('PANDA_KERNEL_LOG_RECORD_INVALID')
  })

  it('pins PANDA_KERNEL_ACTION_INVALID to the canonical constant', () => {
    const error = new ActionInvalidError('cost', 'must be a finite number of at least 0')
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelActionInvalid)
    expect(error.code).toBe('PANDA_KERNEL_ACTION_INVALID')
  })

  it('pins PANDA_KERNEL_ACTION_DENIED to the canonical constant', () => {
    const error = new ActionDeniedError('act.run', 'denied for a reason')
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelActionDenied)
    expect(error.code).toBe('PANDA_KERNEL_ACTION_DENIED')
  })

  it('pins one code per cap kind, so a violation record says WHICH cap fired', () => {
    // The log record shape is closed and carries no cap field, so collapsing these
    // into one code would make every budget violation in the audit stream read
    // identically to every other.
    expect(new BudgetExceededError('invocations', 'act.run', 1, 1, 2).code).toBe(
      PANDA_ERROR_CODES.kernelInvocationCapExceeded,
    )
    expect(new BudgetExceededError('invocations', 'act.run', 1, 1, 2).code).toBe('PANDA_KERNEL_INVOCATION_CAP_EXCEEDED')
    expect(new BudgetExceededError('cost', 'act.run', 1, 1, 2).code).toBe(PANDA_ERROR_CODES.kernelCostCapExceeded)
    expect(new BudgetExceededError('cost', 'act.run', 1, 1, 2).code).toBe('PANDA_KERNEL_COST_CAP_EXCEEDED')
    expect(new BudgetExceededError('concurrency', 'act.run', 1, 1, 2).code).toBe(
      PANDA_ERROR_CODES.kernelConcurrencyCapExceeded,
    )
    expect(new BudgetExceededError('concurrency', 'act.run', 1, 1, 2).code).toBe(
      'PANDA_KERNEL_CONCURRENCY_CAP_EXCEEDED',
    )
  })

  it('pins PANDA_KERNEL_STAGE_FAILED to the canonical constant', () => {
    const error = new StageFailedError('act.run', 'guard', new Error('boom'))
    expect(error.code).toBe(PANDA_ERROR_CODES.kernelStageFailed)
    expect(error.code).toBe('PANDA_KERNEL_STAGE_FAILED')
  })

  it('leaves no kernel code unmirrored, so the next one cannot be forgotten', () => {
    // The per-code clauses above catch a RENAME. This catches an ADDITION: every
    // clause above had to be written by hand, and the one nobody wrote is exactly
    // the code that would drift silently.
    const mirrored = new Set<string>(Object.values(PANDA_ERROR_CODES))
    for (const code of Object.values(KERNEL_ERROR_CODES)) {
      expect(mirrored.has(code), `${code} is missing from PANDA_ERROR_CODES`).toBe(true)
    }
  })
})
