import type { StandardSchemaV1Like } from '../src'

/**
 * Every value the kernel exports, sorted. Two separate guarantees are pinned
 * against this one list — that no second load entry point can skip the record
 * sink (Story 1.6), and that no raw runner can skip the interception waterfall
 * (Story 1.7) — because both rot the same way: a NEW export added beside the
 * sanctioned one, which no signature check can see.
 *
 * Editing this list is the conscious act both pins exist to force. Adding a name
 * here without reading the two tests that consume it is the mistake.
 */
export const KERNEL_EXPORTS = [
  'ACTION_STAGES',
  'ActionDeniedError',
  'ActionInvalidError',
  'BUS_SCOPES',
  'BudgetExceededError',
  'CONFIG_LAYERS',
  'CycleDetectedError',
  'InvalidLayerError',
  'InvalidScopeError',
  'KERNEL_ERROR_CODES',
  'LOG_EVENTS',
  'LOG_RECORD_VERSION',
  'LogRecordInvalidError',
  'ManifestInvalidError',
  'PandaKernelError',
  'PluginInactiveError',
  'PluginStartFailedError',
  'ReemitDuringFanoutError',
  'ServiceConflictError',
  'ServiceNotProvidedError',
  'StageFailedError',
  'SwapRejectedError',
  'createActionPipeline',
  'createEventBus',
  'createKernel',
  'createLayeredConfig',
  'createLogSink',
  'createMemoryLogSink',
  'deepMerge',
  'isKernelErrorCode',
  'loadPlugins',
  'lostRecordCount',
  'validateManifest',
]

export const passthroughSchema: StandardSchemaV1Like = {
  '~standard': {
    version: 1,
    validate: (value) => ({ value }),
  },
}

export function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'plugin-a',
    version: '1.0.0',
    provides: [],
    consumes: [],
    configSchema: passthroughSchema,
    ...overrides,
  }
}
