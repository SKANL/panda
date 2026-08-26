export const PANDA_ERROR_CODES = {
  kernelManifestInvalid: 'PANDA_KERNEL_MANIFEST_INVALID',
  kernelCycleDetected: 'PANDA_KERNEL_CYCLE_DETECTED',
  kernelServiceNotProvided: 'PANDA_KERNEL_SERVICE_NOT_PROVIDED',
  kernelServiceConflict: 'PANDA_KERNEL_SERVICE_CONFLICT',
  kernelPluginInactive: 'PANDA_KERNEL_PLUGIN_INACTIVE',
  kernelPluginStartFailed: 'PANDA_KERNEL_PLUGIN_START_FAILED',
  kernelSwapRejected: 'PANDA_KERNEL_SWAP_REJECTED',
  kernelReemitDuringFanout: 'PANDA_KERNEL_REEMIT_DURING_FANOUT',
  kernelInvalidScope: 'PANDA_KERNEL_INVALID_SCOPE',
  kernelInvalidLayer: 'PANDA_KERNEL_INVALID_LAYER',
  kernelLogRecordInvalid: 'PANDA_KERNEL_LOG_RECORD_INVALID',
  kernelActionInvalid: 'PANDA_KERNEL_ACTION_INVALID',
  kernelActionDenied: 'PANDA_KERNEL_ACTION_DENIED',
  kernelInvocationCapExceeded: 'PANDA_KERNEL_INVOCATION_CAP_EXCEEDED',
  kernelCostCapExceeded: 'PANDA_KERNEL_COST_CAP_EXCEEDED',
  kernelConcurrencyCapExceeded: 'PANDA_KERNEL_CONCURRENCY_CAP_EXCEEDED',
  kernelStageFailed: 'PANDA_KERNEL_STAGE_FAILED',
  contractEnvelopeInvalid: 'PANDA_CONTRACT_ENVELOPE_INVALID',
  contractWorkspaceUnknownId: 'PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID',
  contractWorkspaceInvalidHandle: 'PANDA_CONTRACT_WORKSPACE_INVALID_HANDLE',
  contractWorkspaceDoubleRelease: 'PANDA_CONTRACT_WORKSPACE_DOUBLE_RELEASE',
  contractWorkspaceUnavailable: 'PANDA_CONTRACT_WORKSPACE_UNAVAILABLE',
  contractProviderDisposed: 'PANDA_CONTRACT_PROVIDER_DISPOSED',
  executorUnavailable: 'PANDA_EXECUTOR_UNAVAILABLE',
  executorRunFailed: 'PANDA_EXECUTOR_RUN_FAILED',
  executorCancelled: 'PANDA_EXECUTOR_CANCELLED',
  registryInvalidEntry: 'PANDA_REGISTRY_INVALID_ENTRY',
  registryContention: 'PANDA_REGISTRY_CONTENTION',
  registryStoreUnavailable: 'PANDA_REGISTRY_STORE_UNAVAILABLE',
  registryInactive: 'PANDA_REGISTRY_INACTIVE',
  registryProviderRejected: 'PANDA_REGISTRY_PROVIDER_REJECTED',
  registryOriginConflict: 'PANDA_REGISTRY_ORIGIN_CONFLICT',
  projectionNativeMalformed: 'PANDA_PROJECTION_NATIVE_MALFORMED',
  projectionTargetFailed: 'PANDA_PROJECTION_TARGET_FAILED',
  projectionTraitsInvalid: 'PANDA_PROJECTION_TRAITS_INVALID',
  projectionLedgerUnavailable: 'PANDA_PROJECTION_LEDGER_UNAVAILABLE',
  projectionNativeUnclaimable: 'PANDA_PROJECTION_NATIVE_UNCLAIMABLE',
  // The machine or project scope panda was pointed at cannot be used: a
  // directory that does not exist, a path that is not a directory, an empty
  // string where a home was expected, or panda's own state directory occupied
  // by a file. Coded because every one of these is reachable from a caller's
  // argv or a consumer's `process.env.HOME ?? ''`, and a raw ENOENT/EEXIST
  // names neither the path nor what panda wanted from it.
  environmentScopeUnavailable: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE',
} as const

export type PandaErrorCode = (typeof PANDA_ERROR_CODES)[keyof typeof PANDA_ERROR_CODES]

export class PandaError extends Error {
  readonly code: PandaErrorCode

  constructor(code: PandaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PandaError'
    this.code = code
  }
}
