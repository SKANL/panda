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
