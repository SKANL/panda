export const KERNEL_ERROR_CODES = {
  manifestInvalid: 'PANDA_KERNEL_MANIFEST_INVALID',
  cycleDetected: 'PANDA_KERNEL_CYCLE_DETECTED',
  serviceNotProvided: 'PANDA_KERNEL_SERVICE_NOT_PROVIDED',
  serviceConflict: 'PANDA_KERNEL_SERVICE_CONFLICT',
  pluginInactive: 'PANDA_KERNEL_PLUGIN_INACTIVE',
  pluginStartFailed: 'PANDA_KERNEL_PLUGIN_START_FAILED',
  swapRejected: 'PANDA_KERNEL_SWAP_REJECTED',
} as const

export class PandaKernelError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PandaKernelError'
    this.code = code
  }
}

export class ManifestInvalidError extends PandaKernelError {
  constructor(message: string, options?: ErrorOptions) {
    super(KERNEL_ERROR_CODES.manifestInvalid, message, options)
    this.name = 'ManifestInvalidError'
  }
}

export class CycleDetectedError extends PandaKernelError {
  readonly sideA: string
  readonly sideB: string
  readonly cycle: readonly string[]

  constructor(sideA: string, sideB: string, cycle: readonly string[], options?: ErrorOptions) {
    super(
      KERNEL_ERROR_CODES.cycleDetected,
      `plugin dependency cycle detected between '${sideA}' and '${sideB}': ${[...cycle, cycle[0] ?? sideA].join(' -> ')}`,
      options,
    )
    this.name = 'CycleDetectedError'
    this.sideA = sideA
    this.sideB = sideB
    this.cycle = cycle
  }
}

export class ServiceNotProvidedError extends PandaKernelError {
  readonly pluginId: string
  readonly services: readonly string[]

  constructor(pluginId: string, services: readonly string[], options?: ErrorOptions) {
    super(
      KERNEL_ERROR_CODES.serviceNotProvided,
      `plugin '${pluginId}' cannot become ready: no provider registered for hard-consumed service(s): ${services.join(', ')}`,
      options,
    )
    this.name = 'ServiceNotProvidedError'
    this.pluginId = pluginId
    this.services = services
  }
}

export class ServiceConflictError extends PandaKernelError {
  readonly service: string
  readonly existingProviderId: string
  readonly conflictingProviderId: string

  constructor(service: string, existingProviderId: string, conflictingProviderId: string, options?: ErrorOptions) {
    super(
      KERNEL_ERROR_CODES.serviceConflict,
      `service '${service}' is already provided by plugin '${existingProviderId}' (conflicting provider: '${conflictingProviderId}')`,
      options,
    )
    this.name = 'ServiceConflictError'
    this.service = service
    this.existingProviderId = existingProviderId
    this.conflictingProviderId = conflictingProviderId
  }
}

export class PluginInactiveError extends PandaKernelError {
  readonly pluginId: string

  constructor(pluginId: string, detail: string, options?: ErrorOptions) {
    super(KERNEL_ERROR_CODES.pluginInactive, `plugin '${pluginId}' is inactive: ${detail}`, options)
    this.name = 'PluginInactiveError'
    this.pluginId = pluginId
  }
}

export class PluginStartFailedError extends PandaKernelError {
  readonly pluginId: string

  constructor(pluginId: string, detail: string, options?: ErrorOptions) {
    super(KERNEL_ERROR_CODES.pluginStartFailed, `plugin '${pluginId}' failed to start: ${detail}`, options)
    this.name = 'PluginStartFailedError'
    this.pluginId = pluginId
  }
}

export class SwapRejectedError extends PandaKernelError {
  readonly pluginId: string
  readonly issues: readonly string[]

  constructor(pluginId: string, issues: readonly string[], options?: ErrorOptions) {
    super(
      KERNEL_ERROR_CODES.swapRejected,
      `swap rejected for plugin '${pluginId}': candidate validation failed (${issues.join('; ')})`,
      options,
    )
    this.name = 'SwapRejectedError'
    this.pluginId = pluginId
    this.issues = issues
  }
}
