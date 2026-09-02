export {
  PROJECTION_ACTION_ID,
  initMachine,
  initProject,
  noExecutorsDetected,
  // The seams `panda add` / `remove` / `list` bind to. Exported rather than
  // re-derived in the binding: `storeFor` is the ONE mapping from a scope to a
  // store, `scopeDirectory` is the trust boundary that keeps a project verb from
  // building a tree panda was asked to bind rather than create, and
  // `deliveryFor` is what `add` reports its next step FROM — so the binding
  // holds no idea of which entry type has a location at which scope.
  deliveryFor,
  scopeDirectory,
  storeFor,
  type EntryDelivery,
  type InitMachineOptions,
  type InitProjectOptions,
  type InitResult,
  type LegacyBlock,
  type SkippedExecutor,
  type TargetFailure,
  type TargetProjection,
  type UnprojectableEntry,
} from './init.ts'
export {
  DIAGNOSIS_FINDING_KINDS,
  FINDING_EXITS,
  diagnose,
  findingKindsFor,
  hasProblem,
  type Diagnosis,
  type DiagnoseOptions,
  type DiagnosisFinding,
  type DiagnosisFindingKind,
  type DiagnosisFindingSeverity,
  type DiagnosisTarget,
  type FindingExit,
} from './doctor.ts'
export { remediate, type RemediateOptions, type RemediationReport } from './remediate.ts'
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
// `RegistryStoreOptions.onStaleLockBreak` takes a `StaleLockBreak`,
// `ExecutorProfile.createTarget` returns a `ProjectionConfigTarget` and
// `ExecutorProfile.createSkillsTarget` a `ProjectionMaterialiseTarget`, none of
// which is re-exported. All three are reachable only by a consumer implementing
// one of those callbacks; the ordinary path needs none of them. Recorded in
// deferred-work.md rather than fixed by widening the surface on speculation.
export { RegistryStore } from '@panda/registry'
export type { RegistryStoreOptions } from '@panda/registry'
// The bundle surface, for the same reason: a consumer holding a `RegistryStore`
// can build the artifact and read what did not travel without resolving
// `@panda/registry` itself. `writeBundle` is here and this package still writes
// no file — it names a capability its own guard test forbids it to PERFORM,
// which is the whole point of a facade.
export { BUNDLE_KIND, BUNDLE_VERSION, createBundle, isCredential, parseBundle, readBundle, serializeBundle, writeBundle } from '@panda/registry'
export type { OmittedEntry, RegistryBundle } from '@panda/registry'
export {
  DRIFT_KINDS,
  REGISTRY_ENTRY_TYPES,
  REMEDIATION_KINDS,
  REMOVABLE_ENTRY_TYPES,
  RETIRED_ENTRY_TYPES,
  // The read-time inverse of the store's write-time normalization. A caller
  // holding an entry in its PORTABLE form — the one a bundle carries — needs it
  // to get back to the real paths the store's surface takes, and re-normalizing
  // an already-normalized value corrupts it rather than being a no-op.
  expandRegistryEntryPaths,
  isRetiredEntryType,
} from '@panda/contracts'
export type {
  DriftEntry,
  DriftKind,
  PandaErrorCode,
  ProjectionWarning,
  RegistryEntry,
  RegistryEntryType,
  RegistryScope,
  RemediationChange,
  RemediationKind,
  RemediationOutcome,
  RemediationRefusal,
  RetiredEntryType,
  StoredEntryType,
} from '@panda/contracts'
export { createMemoryLogSink } from '@panda/kernel'
export type { LogRecord, LogSink, MemoryLogSink } from '@panda/kernel'
// Re-exported, not reimplemented. This package may not touch the filesystem at
// all (see test/guard.test.ts): the ledger is the sole authority for what panda
// writes, and the clause is blunt on purpose. The WRITER is forwarded so the CLI
// reaches it through this facade -- the same shape as createMemoryLogSink above
// -- while the atomic primitive it uses stays inside @panda/projection, where a
// previous story deliberately un-exported it.
export {
  WRITABLE_CONFIG_KEYS,
  configPathFor,
  setConfigValue,
  type ConfigWriteOptions,
  type ConfigWriteResult,
  type WritableConfigKey,
} from '@panda/projection'
export { ingestMachineSkills } from './ingest.ts'
export type {
  IngestMachineSkillsOptions,
  MachineSkillsIngest,
  MachineSkillsSkip,
} from './ingest.ts'
export type { IngestOutcome, IngestWarning } from '@panda/contracts'
