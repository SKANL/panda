export { PandaError, PANDA_ERROR_CODES, type PandaErrorCode } from './errors.ts'
export {
  type StandardSchemaIssue,
  type StandardSchemaResult,
  type StandardSchemaV1,
  defineStandardSchema,
} from './standard-schema.ts'
export {
  WORKSPACE_HANDLE_SCHEMA,
  validateWorkspaceHandle,
  type WorkspaceCapability,
  type WorkspaceHandle,
  type WorkspaceProvider,
} from './workspace.ts'
export {
  MEMORY_ENTRY_SCHEMA,
  MEMORY_FORMAT_VERSION,
  memoryEntryIssues,
  memoryOverwriteUnsupported,
  memorySaveRequestIssues,
  memoryStoreVersionMismatch,
  validateMemorySaveRequest,
  type MemoryEntry,
  type MemoryProvenance,
  type MemoryProvider,
  type MemorySaveRequest,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemoryStoreInfo,
  type MemoryTimeline,
} from './memory.ts'
export {
  RESULT_ENVELOPE_SCHEMA,
  RUN_REQUEST_SCHEMA,
  USAGE_ABSENCE_REASONS,
  isUsageReport,
  usageAbsence,
  usageObservation,
  validateEnvelope,
  validateRunRequest,
  type EnvelopeError,
  type ExecutorAdapter,
  type ResultEnvelope,
  type ResultStatus,
  type RunRequest,
  type UsageAbsence,
  type UsageAbsenceReason,
  type UsageObservation,
  type UsageReport,
  type UsageWindow,
} from './executor.ts'
export {
  REGISTRY_ENTRY_SCHEMA,
  REGISTRY_ENTRY_TYPES,
  REGISTRY_PATH_FIELDS,
  REGISTRY_SCOPES,
  REMOVABLE_ENTRY_TYPES,
  RETIRED_ENTRY_TYPES,
  RETIRED_PATH_FIELDS,
  UNPROJECTABLE_ENTRY_IDS,
  expandRegistryEntryPaths,
  isRegistryEntryType,
  isRegistryScopeValue,
  isRetiredEntryType,
  isStoredEntryType,
  pathFieldsFor,
  registryEntryIssues,
  normalizeRegistryEntryPaths,
  validateRegistryEntry,
  validateRegistryScope,
  type RegistryEntry,
  type RegistryEntryType,
  type RegistryScope,
  type RetiredEntryType,
  type StoredEntryType,
} from './registry.ts'
export {
  METHOD_CONFIG_KEY,
  METHOD_PLUGIN_ROOT_KEYS,
  METHOD_PLUGIN_SCHEMA,
  SEMVER_PATTERN,
  activateMethod,
  isProjectRelativePath,
  isSemver,
  methodPluginIssues,
  validateMethodPlugin,
  type MethodActivateHook,
  type MethodActivation,
  type MethodArtifact,
  type MethodCommand,
  type MethodDeactivateHook,
  type MethodHookPair,
  type MethodManifest,
  type MethodPhase,
  type MethodPlugin,
} from './method.ts'
export {
  PANDA_SOURCE_EXTENSION_KEY,
  type IngestOrigin,
  type IngestOutcome,
  type IngestWarning,
  type IngestWarningKind,
  type SkillSource,
  type SourcedSkill,
  type SourceTracking,
  type ToolProvider,
} from './providers.ts'
export {
  DRIFT_KINDS,
  PROJECTION_LEDGER_VERSION,
  REMEDIATION_KINDS,
  projectionTargetLocation,
  type DriftEntry,
  type DriftKind,
  type ProjectionClaim,
  type ProjectionClaimRequest,
  type ProjectionConfigTarget,
  type ProjectionFailure,
  type ProjectionLedgerRecord,
  type ProjectionMaterialiseEntry,
  type ProjectionMaterialiseFile,
  type ProjectionMaterialisePlan,
  type ProjectionMaterialiseRequest,
  type ProjectionMaterialiseTarget,
  type ProjectionMcpEntry,
  type ProjectionMergeOutcome,
  type ProjectionMergeRequest,
  type ProjectionOwnedPath,
  type ProjectionResult,
  type ProjectionSkip,
  type ProjectionTarget,
  type ProjectionWarning,
  type RegistryEntriesByKind,
  type RemediationChange,
  type RemediationKind,
  type RemediationOutcome,
  type RemediationRefusal,
} from './projection.ts'
export {
  SANDBOX_CONTROL_EVIDENCE,
  SANDBOX_ENFORCEMENT_LEVELS,
  SANDBOX_ERROR_CODES,
  SANDBOX_MODES,
  SANDBOX_POLICY_SCHEMA,
  SANDBOX_POLICY_VERSION,
  SANDBOX_RESULT_STATUSES,
  SANDBOX_CONTROLS,
  SANDBOX_AUDIT_EVENT_KINDS,
  SANDBOX_AUDIT_EVENT_SCHEMA,
  validateSandboxAuditEvent,
  validateSandboxCapabilities,
  validateSandboxExecutionRequest,
  validateSandboxExecutionResult,
  validateSandboxPolicy,
  validateSandboxSnapshot,
  type SandboxCapabilityFacts,
  type SandboxAuditEvent,
  type SandboxAuditEventKind,
  type SandboxCapabilityRequirement,
  type SandboxControl,
  type SandboxControlEvidence,
  type SandboxEnforcementLevel,
  type SandboxErrorCode,
  type SandboxExecutionError,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxExecutionStatus,
  type SandboxMode,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxSession,
  type SandboxStdioSession,
  type SandboxSessionRequest,
  type SandboxSnapshot,
} from './sandbox.ts'
export {
  validateToolExecutionContext,
  validateToolInvocation,
  validateToolResult,
  type LocalTool,
  type LocalToolInvocation,
  type JsonObject,
  type JsonValue,
  type McpStdioTool,
  type McpStdioToolInvocation,
  type Tool,
  type ToolExecutionContext,
  type ToolExecutor,
  type ToolInvocation,
  type ToolResult,
} from './tool-execution.ts'
export { isRecord } from './validation.ts'
export {
  CONTRACT_PROBE_REQUEST,
  CONTRACT_PROBE_WORKSPACE_HANDLE,
  DEFAULT_CLAUSE_TIMEOUT_MS,
  EXECUTOR_CLAUSES,
  EXECUTOR_SUITE,
  MEMORY_CLAUSES,
  MEMORY_SUITE,
  WORKSPACE_CLAUSES,
  WORKSPACE_SUITE,
  runExecutorContractSuite,
  runMemoryContractSuite,
  runWorkspaceContractSuite,
  type Clause,
  type ClauseOutcome,
  type ClauseResult,
  type ClauseViolation,
  type MemoryContractHarness,
  type RunOptions,
  type SuiteReport,
} from './contract-suite/index.ts'

/**
 * The version all thirteen packages carry.
 *
 * WHY HERE, unchanged and still true. `panda --version` is what needs it, and
 * `@skanl/panda-cli` is FORBIDDEN to read files at all — eslint's thin-binding
 * pin. `@skanl/panda-environment` was tried next and its OWN guard test refused
 * it: that package may import `mkdir` and `stat` from the filesystem and nothing
 * else. Both refusals are correct, and they are why this sits in the one package
 * that owns version VOCABULARY — `STORE_VERSION`, `BUNDLE_VERSION` and
 * `PROJECTION_LEDGER_VERSION` are all here.
 *
 * WHY A LITERAL, and it replaces a `readFileSync` walk that ran at IMPORT time.
 * Any bundler collapses `import.meta.url` to the bundle's own path, the walk
 * found nothing, and the module THREW — not on `--version`, but on `import`.
 * Measured with two independent bundlers over every package entry point: 12 of
 * 13 died on a bare import of the package by name, and the survivor was
 * `@skanl/panda-kernel`, which AD-1 forbids from importing this package at all.
 * (That sentence used to SPELL the import, and `topology.test.ts` read it as a
 * real specifier and failed — a scanner over raw source reads comments too, for
 * the third time in this repository. Describe the example, never write it out.)
 * A bundled panda could not print its own HELP TEXT. For a project whose PRD
 * says it "ships as an SDK first: a headless kernel usable from any project",
 * that is every serverless, Next.js server and Electron main bundle.
 *
 * TWO POSITION PAPERS argued build-time generation against a lazy typed absence,
 * and both concluded against themselves in the same direction: generation is
 * net-new codegen machinery in a repo that has none, and laziness RELOCATES the
 * failure rather than removing it — a bundled `--version` would answer
 * "unavailable", which is honest and is not an answer. A literal is what both
 * arrived at, and it costs no exported type, no new file and no build step.
 *
 * IT IS NOT A SECOND SOURCE OF TRUTH, which is the objection `versions.test.ts`
 * raises against a thirteenth file holding the version. It is a fourteenth place
 * the number appears, and it is PINNED: that suite asserts this constant equals
 * this package's own manifest, so a bump that forgets it reddens by name. The
 * number without the gate would be the defect; the gate is the point.
 *
 * AND THE WALK'S OWN JUSTIFICATION WAS FALSE, which is why removing it costs
 * nothing. Its comment claimed "the two layouts this module runs in sit at
 * different depths — `src/` in development, `dist/src/` in the published
 * tarball". Measured: `tsconfig.build.json` is `rootDir: src, outDir: dist`, so
 * this package's built output is FLAT (`dist/index.js`), one directory below the
 * manifest in both layouts. The four-level walk was bought to solve a depth
 * difference that does not exist.
 */
export const PANDA_VERSION = '0.1.0'
