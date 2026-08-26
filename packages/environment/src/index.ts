export {
  PROJECTION_ACTION_ID,
  initMachine,
  initProject,
  noExecutorsDetected,
  type InitMachineOptions,
  type InitProjectOptions,
  type InitResult,
  type SkippedExecutor,
  type TargetFailure,
  type TargetProjection,
  type UnprojectableEntry,
} from './init.ts'
export { EXECUTOR_PROFILES, detectExecutors, type EvidencePath, type ExecutorDetection, type ExecutorProfile } from './executors.ts'

// Re-exported, not merely referenced. Under pnpm's strict layout a consumer that
// installed `@panda/environment` cannot resolve `@panda/contracts`,
// `@panda/kernel` or `@panda/registry` unless it declares them too — so a
// surface whose result carries a `DriftEntry` and whose precondition is "put
// entries in the registry first" has to hand back both, or the SDK promise is
// only true inside this monorepo. The list is exactly that: what you need to
// POPULATE the registry this projects from, READ a result, and OBSERVE the run.
//
// The closure is NOT total, and saying so is cheaper than a claim that rots:
// `RegistryStoreOptions.onStaleLockBreak` takes a `StaleLockBreak` and
// `ExecutorProfile.createTarget` returns a `ProjectionTarget`, neither of which
// is re-exported. Both are reachable only by a consumer implementing one of
// those callbacks; the ordinary path needs neither. Recorded in
// deferred-work.md rather than fixed by widening the surface on speculation.
export { RegistryStore } from '@panda/registry'
export type { RegistryStoreOptions } from '@panda/registry'
export type {
  DriftEntry,
  DriftKind,
  PandaErrorCode,
  ProjectionWarning,
  RegistryEntry,
  RegistryEntryType,
  RegistryScope,
} from '@panda/contracts'
export { createMemoryLogSink } from '@panda/kernel'
export type { LogRecord, LogSink, MemoryLogSink } from '@panda/kernel'
