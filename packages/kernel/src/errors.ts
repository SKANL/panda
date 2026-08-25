import type { ActionStage } from './intercept.ts'

export const KERNEL_ERROR_CODES = {
  manifestInvalid: 'PANDA_KERNEL_MANIFEST_INVALID',
  cycleDetected: 'PANDA_KERNEL_CYCLE_DETECTED',
  serviceNotProvided: 'PANDA_KERNEL_SERVICE_NOT_PROVIDED',
  serviceConflict: 'PANDA_KERNEL_SERVICE_CONFLICT',
  pluginInactive: 'PANDA_KERNEL_PLUGIN_INACTIVE',
  pluginStartFailed: 'PANDA_KERNEL_PLUGIN_START_FAILED',
  swapRejected: 'PANDA_KERNEL_SWAP_REJECTED',
  reemitDuringFanout: 'PANDA_KERNEL_REEMIT_DURING_FANOUT',
  invalidScope: 'PANDA_KERNEL_INVALID_SCOPE',
  invalidLayer: 'PANDA_KERNEL_INVALID_LAYER',
  logRecordInvalid: 'PANDA_KERNEL_LOG_RECORD_INVALID',
  actionInvalid: 'PANDA_KERNEL_ACTION_INVALID',
  actionDenied: 'PANDA_KERNEL_ACTION_DENIED',
  // One code per cap kind, not one code plus a field: a log record's shape is
  // closed (`event`, `subject`, `code`) and has nowhere to carry which cap fired,
  // so a single PANDA_KERNEL_BUDGET_EXCEEDED would make every violation in the
  // audit stream indistinguishable from every other.
  invocationCapExceeded: 'PANDA_KERNEL_INVOCATION_CAP_EXCEEDED',
  costCapExceeded: 'PANDA_KERNEL_COST_CAP_EXCEEDED',
  concurrencyCapExceeded: 'PANDA_KERNEL_CONCURRENCY_CAP_EXCEEDED',
  stageFailed: 'PANDA_KERNEL_STAGE_FAILED',
} as const

export type KernelErrorCode = (typeof KERNEL_ERROR_CODES)[keyof typeof KERNEL_ERROR_CODES]

const CODE_VALUES = new Set<string>(Object.values(KERNEL_ERROR_CODES))

/** Narrows an arbitrary string to a kernel code, so a record can carry one without a cast. */
export function isKernelErrorCode(value: string): value is KernelErrorCode {
  return CODE_VALUES.has(value)
}

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

export class ReemitDuringFanoutError extends PandaKernelError {
  constructor(options?: ErrorOptions) {
    super(
      KERNEL_ERROR_CODES.reemitDuringFanout,
      'handlers must not synchronously re-emit into the bus during fan-out',
      options,
    )
    this.name = 'ReemitDuringFanoutError'
  }
}

export class InvalidScopeError extends PandaKernelError {
  readonly scope: string

  constructor(scope: string, detail: string, options?: ErrorOptions) {
    super(KERNEL_ERROR_CODES.invalidScope, `'${scope}' is not a valid scope: ${detail}`, options)
    this.name = 'InvalidScopeError'
    this.scope = scope
  }
}

export class LogRecordInvalidError extends PandaKernelError {
  readonly field: string

  constructor(field: string, detail: string, options?: ErrorOptions) {
    super(KERNEL_ERROR_CODES.logRecordInvalid, `invalid log record: '${field}' ${detail}`, options)
    this.name = 'LogRecordInvalidError'
    this.field = field
  }
}

/** An action descriptor or a policy the interception pipeline cannot enforce with. */
export class ActionInvalidError extends PandaKernelError {
  readonly field: string

  constructor(field: string, detail: string, options?: ErrorOptions) {
    super(KERNEL_ERROR_CODES.actionInvalid, `invalid action declaration: '${field}' ${detail}`, options)
    this.name = 'ActionInvalidError'
    this.field = field
  }
}

/** A guard stage refused the action. The reason is mandatory so the refusal is actionable. */
export class ActionDeniedError extends PandaKernelError {
  readonly actionId: string
  readonly reason: string

  constructor(actionId: string, reason: string, options?: ErrorOptions) {
    super(KERNEL_ERROR_CODES.actionDenied, `action '${actionId}' was denied by its guard: ${reason}`, options)
    this.name = 'ActionDeniedError'
    this.actionId = actionId
    this.reason = reason
  }
}

const CAP_CODES = {
  invocations: KERNEL_ERROR_CODES.invocationCapExceeded,
  cost: KERNEL_ERROR_CODES.costCapExceeded,
  concurrency: KERNEL_ERROR_CODES.concurrencyCapExceeded,
} as const

export type BudgetCap = keyof typeof CAP_CODES

/**
 * A declarative cap would have been exceeded, so the action was refused before it
 * ran. One class over three codes: the classes would have been identical, but the
 * codes must differ so a log record can say WHICH cap fired (see KERNEL_ERROR_CODES).
 */
export class BudgetExceededError extends PandaKernelError {
  readonly cap: BudgetCap
  readonly actionId: string
  readonly limit: number
  /** The total before this invocation — the partial the matrix asks to be reported. */
  readonly current: number
  /** What the total would have become had the invocation been admitted. */
  readonly projected: number

  constructor(cap: BudgetCap, actionId: string, limit: number, current: number, projected: number, options?: ErrorOptions) {
    super(
      CAP_CODES[cap],
      `action '${actionId}' refused: the ${cap} cap of ${limit} would be exceeded (${current} already used, ${projected} required)`,
      options,
    )
    this.name = 'BudgetExceededError'
    this.cap = cap
    this.actionId = actionId
    this.limit = limit
    this.current = current
    this.projected = projected
  }
}

/**
 * An interceptor stage itself threw. Raised INSTEAD of running the action for
 * `pre`, `guard` and `around`: a broken interceptor must not take the kernel down
 * (AD-5), and must not silently let the action through either.
 */
export class StageFailedError extends PandaKernelError {
  readonly actionId: string
  /** Closed vocabulary, imported as a TYPE only so nothing runs across the cycle. */
  readonly stage: ActionStage

  constructor(actionId: string, stage: ActionStage, cause: unknown) {
    super(KERNEL_ERROR_CODES.stageFailed, `action '${actionId}' was refused: its '${stage}' stage threw`, { cause })
    this.name = 'StageFailedError'
    this.actionId = actionId
    this.stage = stage
  }
}

export class InvalidLayerError extends PandaKernelError {
  readonly layer: string

  constructor(layer: string, detail: string, options?: ErrorOptions) {
    super(KERNEL_ERROR_CODES.invalidLayer, `invalid configuration layer '${layer}': ${detail}`, options)
    this.name = 'InvalidLayerError'
    this.layer = layer
  }
}
