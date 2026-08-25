export {
  PandaKernelError,
  ActionDeniedError,
  ActionInvalidError,
  BudgetExceededError,
  StageFailedError,
  ManifestInvalidError,
  CycleDetectedError,
  ServiceNotProvidedError,
  ServiceConflictError,
  PluginInactiveError,
  PluginStartFailedError,
  SwapRejectedError,
  ReemitDuringFanoutError,
  InvalidScopeError,
  InvalidLayerError,
  LogRecordInvalidError,
  KERNEL_ERROR_CODES,
  isKernelErrorCode,
  type BudgetCap,
  type KernelErrorCode,
} from './errors.ts'
// The interception waterfall exports exactly one factory. There is deliberately
// no raw runner here: `packages/kernel/test/intercept.test.ts` pins this whole
// surface, because the way this guarantee would rot is a new export added BESIDE
// the pipeline, not a weakened signature on it.
export {
  createActionPipeline,
  ACTION_STAGES,
  type ActionDefinition,
  type ActionDescriptor,
  type ActionHandle,
  type ActionOutcome,
  type ActionPipeline,
  type ActionPolicy,
  type ActionStage,
  type BudgetUsage,
  type GuardDecision,
  type StageContext,
} from './intercept.ts'
export {
  validateManifest,
  type PluginManifest,
  type ServiceConsumption,
  type StandardSchemaIssue,
  type StandardSchemaResult,
  type StandardSchemaV1Like,
} from './manifest.ts'
export {
  loadPlugins,
  type LoadedPlugin,
  type PluginFailure,
  type PluginLoadResult,
  type ServiceResolution,
} from './loader.ts'
export {
  createKernel,
  type ActivationContext,
  type ConsumedService,
  type DisposalFailure,
  type HandlerFailure,
  type KernelOptions,
  type KernelStartResult,
  type PandaKernel,
  type PluginFactory,
  type PluginFactoryResult,
  type StopResult,
  type SwapResult,
} from './lifecycle.ts'
export {
  createEventBus,
  BUS_SCOPES,
  type BusEvent,
  type BusScope,
  type DispatchFailure,
  type EmitResult,
  type EventHandler,
  type EventOrigin,
  type ScopedEventBus,
  type Unsubscribe,
} from './events.ts'
export {
  createLogSink,
  createMemoryLogSink,
  lostRecordCount,
  LOG_EVENTS,
  LOG_RECORD_VERSION,
  type LogEntry,
  type LogEvent,
  type LogReader,
  type LogRecord,
  type LogSink,
  type LogSinkState,
  type LogWrite,
  type MemoryLogSink,
} from './log.ts'
export {
  createLayeredConfig,
  CONFIG_LAYERS,
  deepMerge,
  type ConfigEntry,
  type ConfigLayer,
  type LayeredConfig,
} from './config.ts'
