import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
 * The version all thirteen packages carry, read from this package's manifest.
 *
 * WHY HERE. `panda --version` is what needs it, and `@skanl/panda-cli` is FORBIDDEN to
 * read files at all -- eslint's thin-binding pin, whose comment records that a
 * reviewer once planted a whole executor-selection capability inside `run.ts`
 * and the entire gate stayed green, because owning it needed only `node:fs` and
 * no new import specifier. The blunt rule is the point, so the CLI is not where
 * this can live. `@skanl/panda-environment` was tried next and its OWN guard test
 * refused it: that package may import `mkdir` and `stat` from the filesystem and
 * nothing else. Both refusals are correct, and they are why this sits in the one
 * package that owns version VOCABULARY -- `STORE_VERSION`, `BUNDLE_VERSION`,
 * `PROJECTION_LEDGER_VERSION` are all here, and so is the lockstep gate in
 * `test/versions.test.ts` that makes one package's version answer for all of
 * them.
 *
 * THE COST, stated rather than hidden: `@skanl/panda-contracts` is the SDK leaf a port
 * author installs alone, and it now performs one synchronous read at import.
 * That is microseconds against NFR-9's 300ms cold-start budget, and it is a
 * genuine widening of what this package does at load time. The alternative was
 * widening an architectural pin for a convenience, which is the worse trade.
 *
 * WALKED rather than a fixed relative path, and that was measured: the two
 * layouts this module runs in sit at different depths -- `src/` in development,
 * `dist/src/` in the published tarball -- so a single `../package.json` resolves
 * to the manifest in exactly one of them and to `dist/package.json`, a file no
 * tarball carries, in the other. The wrong one is the one a USER gets.
 */
function readOwnVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 4; up += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (manifest.name === '@skanl/panda-contracts' && typeof manifest.version === 'string') {
        return manifest.version
      }
    } catch {
      // Not here, or not readable: keep walking.
    }
    dir = dirname(dir)
  }
  // Loud rather than a plausible '0.0.0'. A version this cannot find is a
  // packaging defect, and inventing one hides it behind a number a user quotes
  // into a bug report.
  throw new Error('@skanl/panda-contracts could not read its own version from any package.json above this module')
}

export const PANDA_VERSION: string = readOwnVersion()
