import { PandaError, PANDA_ERROR_CODES } from './errors.ts'
import { defineStandardSchema } from './standard-schema.ts'
import type { StandardSchemaIssue, StandardSchemaResult, StandardSchemaV1 } from './standard-schema.ts'
import { isNonEmptyString, isRecord, issue } from './validation.ts'

export const SANDBOX_POLICY_VERSION = 1

export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'] as const)
export type SandboxMode = (typeof SANDBOX_MODES)[number]

export const SANDBOX_AUDIT_EVENT_KINDS = Object.freeze(['execution-started', 'execution-completed'] as const)
export type SandboxAuditEventKind = (typeof SANDBOX_AUDIT_EVENT_KINDS)[number]

/** Overall evidence level; `none` explicitly means no verified substrate exists. */
export const SANDBOX_ENFORCEMENT_LEVELS = Object.freeze(['none', 'simulated', 'partial', 'os', 'remote'] as const)
export type SandboxEnforcementLevel = (typeof SANDBOX_ENFORCEMENT_LEVELS)[number]

export const SANDBOX_CONTROLS = Object.freeze(['filesystem', 'network', 'process', 'resources'] as const)
export type SandboxControl = (typeof SANDBOX_CONTROLS)[number]

export const SANDBOX_CONTROL_EVIDENCE = Object.freeze(['none', 'partial', 'full'] as const)
export type SandboxControlEvidence = (typeof SANDBOX_CONTROL_EVIDENCE)[number]
export type SandboxCapabilityRequirement = Exclude<SandboxControlEvidence, 'none'>

export interface SandboxResourceLimits {
  readonly wallTimeMs?: number
  readonly memoryBytes?: number
  readonly outputBytes?: number
  readonly fileSizeBytes?: number
  readonly processCount?: number
}

export const SANDBOX_RESULT_STATUSES = Object.freeze(['ok', 'denied', 'failed', 'timed-out', 'aborted', 'unavailable'] as const)
export type SandboxExecutionStatus = (typeof SANDBOX_RESULT_STATUSES)[number]

export const SANDBOX_ERROR_CODES = Object.freeze({
  commandDenied: 'PANDA_SANDBOX_COMMAND_DENIED',
  runnerFailed: 'PANDA_SANDBOX_RUNNER_FAILED',
  timedOut: 'PANDA_SANDBOX_TIMED_OUT',
  aborted: 'PANDA_SANDBOX_ABORTED',
  unavailable: 'PANDA_SANDBOX_UNAVAILABLE',
} as const)
export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[keyof typeof SANDBOX_ERROR_CODES]

const SANDBOX_ERROR_CODE_BY_STATUS: Readonly<Record<Exclude<SandboxExecutionStatus, 'ok'>, SandboxErrorCode>> = Object.freeze({
  denied: SANDBOX_ERROR_CODES.commandDenied,
  failed: SANDBOX_ERROR_CODES.runnerFailed,
  'timed-out': SANDBOX_ERROR_CODES.timedOut,
  aborted: SANDBOX_ERROR_CODES.aborted,
  unavailable: SANDBOX_ERROR_CODES.unavailable,
})

export interface SandboxPolicy {
  readonly version: typeof SANDBOX_POLICY_VERSION
  readonly mode: SandboxMode
  readonly workspaceRoot: string
  readonly requiredCapabilities: Readonly<Partial<Record<SandboxControl, SandboxCapabilityRequirement>>>
  readonly resourceLimits?: SandboxResourceLimits
  /** Required only when deliberately requesting unrestricted host authority. */
  readonly allowDangerous?: true
}

export interface SandboxCapabilityFacts {
  readonly version: typeof SANDBOX_POLICY_VERSION
  readonly providerId: string
  readonly enforcement: SandboxEnforcementLevel
  readonly controls: Readonly<Record<SandboxControl, SandboxControlEvidence>>
}

export interface SandboxSnapshot {
  readonly version: typeof SANDBOX_POLICY_VERSION
  /** A portable path relative to the policy workspace root; it cannot escape it. */
  readonly path: string
  readonly kind: 'file' | 'directory'
  /** Opaque provider-owned content identity; snapshot bytes are never in this contract. */
  readonly digest: string
}

export interface SandboxSessionRequest {
  readonly policy: SandboxPolicy
  readonly snapshots: readonly SandboxSnapshot[]
}

export interface SandboxExecutionRequest {
  /** The provider executes these exact tokens. There is no command string or shell option. */
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly policy: SandboxPolicy
  readonly snapshots?: readonly SandboxSnapshot[]
  readonly signal?: AbortSignal
}

export interface SandboxExecutionError {
  readonly code: SandboxErrorCode
  readonly message: string
}

export interface SandboxExecutionResult {
  readonly status: SandboxExecutionStatus
  readonly stdout: string
  readonly stderr: string
  readonly enforcement: SandboxCapabilityFacts
  readonly exitCode?: number
  readonly error?: SandboxExecutionError
}

export interface SandboxAuditEvent {
  readonly providerId: string
  readonly sessionId: string
  readonly mode: 'danger-full-access'
  readonly timestamp: string
  readonly kind: SandboxAuditEventKind
}

/**
 * A provider-owned stdio channel for one sandboxed process. Each operation
 * exchanges exactly one complete UTF-8 frame; transport framing and process
 * handles remain private to the provider.
 */
export interface SandboxStdioSession {
  sendFrame(frame: string, signal?: AbortSignal): Promise<void>
  receiveFrame(signal?: AbortSignal): Promise<string>
  /** Closes the channel and tears down its owned process and descendants. */
  close(): Promise<void>
}

/** The provider creates and owns every process and descendant in this session. */
export interface SandboxSession {
  readonly id: string
  /** Validated file snapshot identities; never represents process state. */
  readonly snapshots?: readonly SandboxSnapshot[]
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>
  /** Opens a provider-owned stdio channel using the existing exact argv contract, when supported. */
  openStdio?(request: SandboxExecutionRequest): Promise<SandboxStdioSession>
  /** Creates file-only content identities; process state is never snapshotted. */
  snapshot?(paths: readonly string[]): Promise<readonly SandboxSnapshot[]>
  /** Restores only provider-owned file snapshots; process state is never restored. */
  restore?(snapshots: readonly SandboxSnapshot[]): Promise<void>
  dispose(): Promise<void>
}

/**
 * Separate from ToolProvider: discovery/ingestion never grants execution
 * authority. A returned session owns all stdio channels and their process
 * trees until each channel is closed or the session is disposed.
 */
export interface SandboxProvider {
  readonly id: string
  readonly capabilities: SandboxCapabilityFacts
  createSession(request: SandboxSessionRequest): Promise<SandboxSession>
}

function freezePolicy(value: SandboxPolicy): SandboxPolicy {
  return Object.freeze({
    ...value,
    requiredCapabilities: Object.freeze({ ...value.requiredCapabilities }),
    ...(value.resourceLimits === undefined ? {} : { resourceLimits: Object.freeze({ ...value.resourceLimits }) }),
  })
}

function freezeSnapshot(value: SandboxSnapshot): SandboxSnapshot {
  return Object.freeze({ ...value })
}

function freezeCapabilities(value: SandboxCapabilityFacts): SandboxCapabilityFacts {
  return Object.freeze({ ...value, controls: Object.freeze({ ...value.controls }) })
}

function freezeExecutionRequest(value: SandboxExecutionRequest): SandboxExecutionRequest {
  const snapshots = value.snapshots === undefined ? undefined : Object.freeze(value.snapshots.map(freezeSnapshot))
  return Object.freeze({
    ...value,
    argv: Object.freeze([...value.argv]) as SandboxExecutionRequest['argv'],
    environment: Object.freeze({ ...value.environment }),
    policy: freezePolicy(value.policy),
    ...(snapshots === undefined ? {} : { snapshots }),
  })
}

function freezeExecutionResult(value: SandboxExecutionResult): SandboxExecutionResult {
  return Object.freeze({
    ...value,
    enforcement: freezeCapabilities(value.enforcement),
    ...(value.error === undefined ? {} : { error: Object.freeze({ ...value.error }) }),
  })
}

function freezeAuditEvent(value: SandboxAuditEvent): SandboxAuditEvent {
  return Object.freeze({ ...value })
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): StandardSchemaIssue[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => issue(`${label} does not allow '${key}'`))
}

function hasUnsafeCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index)
    if (codePoint < 32 || codePoint === 127) return true
  }
  return false
}

const SANDBOX_RESOURCE_LIMIT_KEYS = Object.freeze(['wallTimeMs', 'memoryBytes', 'outputBytes', 'fileSizeBytes', 'processCount'] as const)

function resourceLimitIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue("'resourceLimits' must be an object")]
  const issues = hasOnlyKeys(value, SANDBOX_RESOURCE_LIMIT_KEYS, 'sandbox resource limits')
  for (const key of SANDBOX_RESOURCE_LIMIT_KEYS) {
    const limit = value[key]
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0)) {
      issues.push(issue(`'resourceLimits.${key}' must be a positive finite integer`))
    }
  }
  return issues
}

interface ParsedSandboxPath {
  readonly family: 'posix' | 'windows-drive' | 'windows-unc'
  readonly root: string
  readonly segments: readonly string[]
}

function pathSegments(value: string): readonly string[] | undefined {
  const segments = value.split(/[\\/]+/).filter(Boolean)
  return segments.some((segment) => segment === '.' || segment === '..') ? undefined : segments
}

/**
 * Parses only unambiguous absolute paths. It deliberately rejects Windows
 * drive-relative and root-relative forms because their root depends on ambient
 * process state, which a dependency-free contract cannot safely inspect.
 */
function parseAbsoluteSandboxPath(value: unknown): ParsedSandboxPath | undefined {
  if (!isNonEmptyString(value) || hasUnsafeCharacters(value)) return undefined
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(value)
  if (drive) {
    const segments = pathSegments(drive[2]!)
    return segments === undefined ? undefined : { family: 'windows-drive', root: drive[1]!.toLowerCase(), segments }
  }
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/.exec(value)
  if (unc) {
    const segments = pathSegments(unc[3] ?? '')
    return segments === undefined
      ? undefined
      : { family: 'windows-unc', root: `${unc[1]!.toLowerCase()}/${unc[2]!.toLowerCase()}`, segments }
  }
  if (!value.startsWith('/') || value.startsWith('//')) return undefined
  const segments = pathSegments(value.slice(1))
  return segments === undefined ? undefined : { family: 'posix', root: '/', segments }
}

function pathSegmentEquals(family: ParsedSandboxPath['family'], left: string, right: string): boolean {
  return family === 'posix' ? left === right : left.toLowerCase() === right.toLowerCase()
}

/** Lexical containment only: providers must still prove physical containment against links and reparse points. */
function isContainedByWorkspace(cwd: ParsedSandboxPath, workspaceRoot: ParsedSandboxPath): boolean {
  return (
    cwd.family === workspaceRoot.family &&
    cwd.root === workspaceRoot.root &&
    workspaceRoot.segments.length <= cwd.segments.length &&
    workspaceRoot.segments.every((segment, index) => pathSegmentEquals(cwd.family, segment, cwd.segments[index]!))
  )
}

function isSnapshotPath(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    !hasUnsafeCharacters(value) &&
    !/^[A-Za-z]:/.test(value) &&
    !/^[\\/]/.test(value) &&
    !value.split(/[\\/]+/).some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  )
}

function policyIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('sandbox policy must be an object')]
  const issues = hasOnlyKeys(value, ['version', 'mode', 'workspaceRoot', 'requiredCapabilities', 'resourceLimits', 'allowDangerous'], 'sandbox policy')
  if (value['version'] !== SANDBOX_POLICY_VERSION) issues.push(issue(`'version' must be ${SANDBOX_POLICY_VERSION}`))
  if (!SANDBOX_MODES.includes(value['mode'] as SandboxMode)) issues.push(issue(`'mode' must be one of: ${SANDBOX_MODES.join(', ')}`))
  if (!parseAbsoluteSandboxPath(value['workspaceRoot'])) issues.push(issue("'workspaceRoot' must be an unambiguous absolute path without traversal segments"))
  if (value['allowDangerous'] !== undefined && value['allowDangerous'] !== true) issues.push(issue("'allowDangerous' must be true when present"))
  if (value['resourceLimits'] !== undefined) issues.push(...resourceLimitIssues(value['resourceLimits']))
  if (value['mode'] === 'danger-full-access' && value['allowDangerous'] !== true) {
    issues.push(issue("'danger-full-access' requires 'allowDangerous: true'"))
  }
  const requirements = value['requiredCapabilities']
  if (!isRecord(requirements)) {
    issues.push(issue("'requiredCapabilities' must be an object"))
  } else {
    for (const [control, requirement] of Object.entries(requirements)) {
      if (!SANDBOX_CONTROLS.includes(control as SandboxControl)) issues.push(issue(`unknown required capability '${control}'`))
      if (requirement !== 'partial' && requirement !== 'full') {
        issues.push(issue(`'requiredCapabilities.${control}' must be 'partial' or 'full'`))
      }
    }
    if ((value['mode'] === 'read-only' || value['mode'] === 'workspace-write') && requirements['filesystem'] !== 'full') {
      issues.push(issue(`'${value['mode']}' requires full filesystem evidence`))
    }
  }
  return issues
}

function snapshotIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('sandbox snapshot must be an object')]
  const issues = hasOnlyKeys(value, ['version', 'path', 'kind', 'digest'], 'sandbox snapshot')
  if (value['version'] !== SANDBOX_POLICY_VERSION) issues.push(issue(`'version' must be ${SANDBOX_POLICY_VERSION}`))
  if (!isSnapshotPath(value['path'])) issues.push(issue("'path' must be a non-empty relative path without traversal segments"))
  if (value['kind'] !== 'file' && value['kind'] !== 'directory') issues.push(issue("'kind' must be 'file' or 'directory'"))
  if (!isNonEmptyString(value['digest']) || hasUnsafeCharacters(value['digest'])) issues.push(issue("'digest' must be a non-empty safe string"))
  return issues
}

function capabilityIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('sandbox capability facts must be an object')]
  const issues = hasOnlyKeys(value, ['version', 'providerId', 'enforcement', 'controls'], 'sandbox capability facts')
  if (value['version'] !== SANDBOX_POLICY_VERSION) issues.push(issue(`'version' must be ${SANDBOX_POLICY_VERSION}`))
  if (!isNonEmptyString(value['providerId']) || hasUnsafeCharacters(value['providerId'])) issues.push(issue("'providerId' must be a non-empty safe string"))
  if (!SANDBOX_ENFORCEMENT_LEVELS.includes(value['enforcement'] as SandboxEnforcementLevel)) {
    issues.push(issue(`'enforcement' must be one of: ${SANDBOX_ENFORCEMENT_LEVELS.join(', ')}`))
  }
  if (!isRecord(value['controls'])) {
    issues.push(issue("'controls' must be an object"))
  } else {
    const controls = value['controls']
    for (const control of SANDBOX_CONTROLS) {
      if (!SANDBOX_CONTROL_EVIDENCE.includes(controls[control] as SandboxControlEvidence)) {
        issues.push(issue(`'controls.${control}' must be one of: ${SANDBOX_CONTROL_EVIDENCE.join(', ')}`))
      }
    }
    issues.push(...hasOnlyKeys(controls, SANDBOX_CONTROLS, "'controls'"))
  }
  return issues
}

function executionRequestIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('sandbox execution request must be an object')]
  const issues = hasOnlyKeys(value, ['argv', 'cwd', 'environment', 'policy', 'snapshots', 'signal'], 'sandbox execution request')
  const argv = value['argv']
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((token) => isNonEmptyString(token) && !hasUnsafeCharacters(token))) {
    issues.push(issue("'argv' must be a non-empty array of non-empty safe strings"))
  }
  const cwd = parseAbsoluteSandboxPath(value['cwd'])
  const workspaceRoot = isRecord(value['policy']) ? parseAbsoluteSandboxPath(value['policy']['workspaceRoot']) : undefined
  if (!cwd) {
    issues.push(issue("'cwd' must be an unambiguous absolute path without traversal segments"))
  } else if (workspaceRoot && !isContainedByWorkspace(cwd, workspaceRoot)) {
    issues.push(issue("'cwd' must be contained by 'policy.workspaceRoot'"))
  }
  if (!isRecord(value['environment']) || !Object.entries(value['environment']).every(([key, entry]) => isNonEmptyString(key) && !hasUnsafeCharacters(key) && typeof entry === 'string' && !hasUnsafeCharacters(entry))) {
    issues.push(issue("'environment' must be a record of safe string values"))
  }
  for (const policyIssue of policyIssues(value['policy'])) issues.push(issue(`'policy' is invalid: ${policyIssue.message}`))
  if (value['snapshots'] !== undefined && (!Array.isArray(value['snapshots']) || value['snapshots'].flatMap(snapshotIssues).length > 0)) {
    issues.push(issue("'snapshots' must contain valid sandbox snapshots"))
  }
  if (value['signal'] !== undefined && !(value['signal'] instanceof AbortSignal)) issues.push(issue("'signal' must be an AbortSignal when present"))
  return issues
}

function executionResultIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('sandbox execution result must be an object')]
  const issues = hasOnlyKeys(value, ['status', 'stdout', 'stderr', 'enforcement', 'exitCode', 'error'], 'sandbox execution result')
  const status = value['status']
  if (!SANDBOX_RESULT_STATUSES.includes(status as SandboxExecutionStatus)) issues.push(issue(`'status' must be one of: ${SANDBOX_RESULT_STATUSES.join(', ')}`))
  if (typeof value['stdout'] !== 'string' || typeof value['stderr'] !== 'string') issues.push(issue("'stdout' and 'stderr' must be strings"))
  const exitCode = value['exitCode']
  if (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0)) {
    issues.push(issue("'exitCode' must be a non-negative integer when present"))
  }
  for (const capabilityIssue of capabilityIssues(value['enforcement'])) issues.push(issue(`'enforcement' is invalid: ${capabilityIssue.message}`))
  const error = value['error']
  if (status === 'ok' && (value['exitCode'] === undefined || error !== undefined)) issues.push(issue("status 'ok' requires an exitCode and no error"))
  if (status !== 'ok') {
    const expectedCode = SANDBOX_ERROR_CODE_BY_STATUS[status as Exclude<SandboxExecutionStatus, 'ok'>]
    if (!isRecord(error) || !Object.values(SANDBOX_ERROR_CODES).includes(error['code'] as SandboxErrorCode) || !isNonEmptyString(error['message'])) {
      issues.push(issue("a non-ok status requires a structured sandbox error"))
    } else if (error['code'] !== expectedCode) {
      issues.push(issue(`status '${status}' requires error code '${expectedCode}'`))
    }
  }
  return issues
}

function auditEventIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('sandbox audit event must be an object')]
  const issues = hasOnlyKeys(value, ['providerId', 'sessionId', 'mode', 'timestamp', 'kind'], 'sandbox audit event')
  if (!isNonEmptyString(value['providerId']) || hasUnsafeCharacters(value['providerId'])) issues.push(issue("'providerId' must be a non-empty safe string"))
  if (!isNonEmptyString(value['sessionId']) || hasUnsafeCharacters(value['sessionId'])) issues.push(issue("'sessionId' must be a non-empty safe string"))
  if (value['mode'] !== 'danger-full-access') issues.push(issue("'mode' must be 'danger-full-access'"))
  if (!isNonEmptyString(value['timestamp']) || hasUnsafeCharacters(value['timestamp']) || Number.isNaN(Date.parse(value['timestamp']))) {
    issues.push(issue("'timestamp' must be a non-empty valid ISO-8601 timestamp"))
  }
  if (!SANDBOX_AUDIT_EVENT_KINDS.includes(value['kind'] as SandboxAuditEventKind)) {
    issues.push(issue(`'kind' must be one of: ${SANDBOX_AUDIT_EVENT_KINDS.join(', ')}`))
  }
  return issues
}

function throwInvalid(code: typeof PANDA_ERROR_CODES[keyof typeof PANDA_ERROR_CODES], label: string, issues: readonly StandardSchemaIssue[]): never {
  throw new PandaError(code, `${label}: ${issues.map((entry) => entry.message).join('; ')}`)
}

export function validateSandboxPolicy(value: unknown): SandboxPolicy {
  const issues = policyIssues(value)
  if (issues.length > 0) throwInvalid(PANDA_ERROR_CODES.sandboxPolicyInvalid, 'invalid sandbox policy', issues)
  return freezePolicy(value as SandboxPolicy)
}

export function validateSandboxSnapshot(value: unknown): SandboxSnapshot {
  const issues = snapshotIssues(value)
  if (issues.length > 0) throwInvalid(PANDA_ERROR_CODES.sandboxSnapshotInvalid, 'invalid sandbox snapshot', issues)
  return freezeSnapshot(value as SandboxSnapshot)
}

/** Fails closed when any policy requirement lacks evidence from the selected provider. */
export function validateSandboxCapabilities(policy: unknown, capabilities: unknown): SandboxCapabilityFacts {
  const policyValue = validateSandboxPolicy(policy)
  const issues = capabilityIssues(capabilities)
  if (issues.length > 0) throwInvalid(PANDA_ERROR_CODES.sandboxCapabilityUnavailable, 'invalid sandbox capability facts', issues)
  const facts = capabilities as SandboxCapabilityFacts
  for (const [control, required] of Object.entries(policyValue.requiredCapabilities) as [SandboxControl, SandboxCapabilityRequirement][]) {
    const actual = facts.controls[control]
    if (actual === 'none' || (required === 'full' && actual !== 'full')) {
      throw new PandaError(PANDA_ERROR_CODES.sandboxCapabilityUnavailable, `sandbox provider '${facts.providerId}' cannot prove '${control}' at '${required}' evidence`)
    }
  }
  return freezeCapabilities(facts)
}

export function validateSandboxExecutionRequest(value: unknown): SandboxExecutionRequest {
  const issues = executionRequestIssues(value)
  if (issues.length > 0) throwInvalid(PANDA_ERROR_CODES.sandboxRequestInvalid, 'invalid sandbox execution request', issues)
  return freezeExecutionRequest(value as SandboxExecutionRequest)
}

export function validateSandboxExecutionResult(value: unknown): SandboxExecutionResult {
  const issues = executionResultIssues(value)
  if (issues.length > 0) throwInvalid(PANDA_ERROR_CODES.sandboxResponseInvalid, 'invalid sandbox execution result', issues)
  return freezeExecutionResult(value as SandboxExecutionResult)
}

export function validateSandboxAuditEvent(value: unknown): SandboxAuditEvent {
  const issues = auditEventIssues(value)
  if (issues.length > 0) throwInvalid(PANDA_ERROR_CODES.sandboxRequestInvalid, 'invalid sandbox audit event', issues)
  return freezeAuditEvent(value as SandboxAuditEvent)
}

export const SANDBOX_POLICY_SCHEMA: StandardSchemaV1<SandboxPolicy> = defineStandardSchema(
  (value): StandardSchemaResult<SandboxPolicy> => {
    const issues = policyIssues(value)
    return issues.length > 0 ? { issues } : { value: freezePolicy(value as SandboxPolicy) }
  },
)

export const SANDBOX_AUDIT_EVENT_SCHEMA: StandardSchemaV1<SandboxAuditEvent> = defineStandardSchema(
  (value): StandardSchemaResult<SandboxAuditEvent> => {
    const issues = auditEventIssues(value)
    return issues.length > 0 ? { issues } : { value: freezeAuditEvent(value as SandboxAuditEvent) }
  },
)
