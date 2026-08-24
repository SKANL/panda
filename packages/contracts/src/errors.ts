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
