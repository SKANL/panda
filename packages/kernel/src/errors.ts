export const KERNEL_ERROR_CODES = {
  manifestInvalid: 'PANDA_KERNEL_MANIFEST_INVALID',
  cycleDetected: 'PANDA_KERNEL_CYCLE_DETECTED',
  serviceNotProvided: 'PANDA_KERNEL_SERVICE_NOT_PROVIDED',
  serviceConflict: 'PANDA_KERNEL_SERVICE_CONFLICT',
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
