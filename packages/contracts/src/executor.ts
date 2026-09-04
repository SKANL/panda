import { PandaError, PANDA_ERROR_CODES } from './errors.ts'
import { defineStandardSchema } from './standard-schema.ts'
import type { StandardSchemaIssue, StandardSchemaResult, StandardSchemaV1 } from './standard-schema.ts'
import { isNonEmptyString, isRecord, issue } from './validation.ts'
import type { WorkspaceHandle } from './workspace.ts'
import { workspaceHandleIssues } from './workspace.ts'

export type ResultStatus = 'ok' | 'failed' | 'cancelled'

export interface EnvelopeError {
  readonly message: string
  readonly code?: string
}

// The typed structured result envelope every adapter returns.
//
// Layering: the schema below is the single source of truth for envelope shape —
// including the per-status invariants that status 'failed' and status
// 'cancelled' each REQUIRE a non-empty errors array (a failure or cancellation
// must always say why). The contract-suite completeness clauses stay as
// behavioral checks on envelopes adapters actually return at runtime; they exist
// to produce clause-named diagnostics, not to redefine shape.
export interface ResultEnvelope {
  readonly status: ResultStatus
  readonly data: unknown
  readonly summary: string
  readonly changedPaths?: readonly string[]
  readonly errors?: readonly EnvelopeError[]
}

export interface RunRequest {
  readonly prompt: string
  // Adapters receive the abstract workspace handle, never a bare cwd.
  readonly workspace: WorkspaceHandle
  // Abort the run; the adapter must terminate the executor process tree and
  // resolve a 'cancelled' envelope. Absent means the run is not cancellable.
  readonly signal?: AbortSignal
}

export interface ExecutorAdapter {
  run(request: RunRequest): Promise<ResultEnvelope>
}

function throwSchemaViolation(issues: readonly StandardSchemaIssue[]): never {
  throw new PandaError(
    PANDA_ERROR_CODES.contractEnvelopeInvalid,
    `schema violation: ${issues.map((entry) => entry.message).join('; ')}`,
  )
}

function envelopeIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('result envelope must be an object')]
  const issues: StandardSchemaIssue[] = []
  const status = value['status']
  if (status !== 'ok' && status !== 'failed' && status !== 'cancelled') {
    issues.push(issue("'status' must be 'ok', 'failed' or 'cancelled'"))
  }
  if (!('data' in value)) issues.push(issue("'data' is required (use null when there is no payload)"))
  if (!isNonEmptyString(value['summary'])) issues.push(issue("'summary' must be a non-empty string"))
  const changedPaths = value['changedPaths']
  if (changedPaths !== undefined && (!Array.isArray(changedPaths) || !changedPaths.every(isNonEmptyString))) {
    issues.push(issue("'changedPaths' must be an array of non-empty path strings"))
  }
  const errors = value['errors']
  if (errors !== undefined && !Array.isArray(errors)) {
    issues.push(issue("'errors' must be an array of { message, code? } entries"))
  }
  if (status === 'failed' && (!Array.isArray(errors) || errors.length === 0)) {
    issues.push(issue("status 'failed' requires a non-empty 'errors' array"))
  }
  if (status === 'cancelled' && (!Array.isArray(errors) || errors.length === 0)) {
    issues.push(issue("status 'cancelled' requires a non-empty 'errors' array"))
  }
  if (Array.isArray(errors)) {
    errors.forEach((entry, index) => {
      if (!isRecord(entry) || !isNonEmptyString(entry['message'])) {
        issues.push(issue(`'errors[${index}]' must carry a non-empty 'message'`))
      } else if (entry['code'] !== undefined && typeof entry['code'] !== 'string') {
        issues.push(issue(`'errors[${index}].code' must be a string when present`))
      }
    })
  }
  return issues
}

export const RESULT_ENVELOPE_SCHEMA: StandardSchemaV1<ResultEnvelope> = defineStandardSchema(
  (value): StandardSchemaResult<ResultEnvelope> => {
    const issues = envelopeIssues(value)
    return issues.length > 0 ? { issues } : { value: value as ResultEnvelope }
  },
)

// Programmatic validation: raises a coded PandaError on schema violations.
export function validateEnvelope(value: unknown): ResultEnvelope {
  const issues = envelopeIssues(value)
  if (issues.length > 0) throwSchemaViolation(issues)
  return value as ResultEnvelope
}

function runRequestIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('run request must be an object')]
  const issues: StandardSchemaIssue[] = []
  if (!isNonEmptyString(value['prompt'])) issues.push(issue("'prompt' must be a non-empty string"))
  const signal = value['signal']
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    issues.push(issue("'signal' must be an AbortSignal when present"))
  }
  for (const handleIssue of workspaceHandleIssues(value['workspace'])) {
    issues.push(issue(`'workspace' is not a valid handle: ${handleIssue.message}`))
  }
  return issues
}

// Programmatic validation: raises a coded PandaError on schema violations.
export function validateRunRequest(value: unknown): RunRequest {
  const issues = runRequestIssues(value)
  if (issues.length > 0) throwSchemaViolation(issues)
  return value as RunRequest
}

export const RUN_REQUEST_SCHEMA: StandardSchemaV1<RunRequest> = defineStandardSchema(
  (value): StandardSchemaResult<RunRequest> => {
    const issues = runRequestIssues(value)
    return issues.length > 0 ? { issues } : { value: value as RunRequest }
  },
)

// --- the vendor's own usage surface (Story M15.A) ---------------------------
//
// AD-5 lives here twice over: a usage figure panda could not take is ABSENCE
// with a reason, never a zero and never a blank. A `0` utilisation for an
// executor panda cannot measure is worse than no row at all, because it reads
// as a measurement that was taken.
//
// Nothing here is derived. `utilization` and `resetsAt` are the vendor's own
// values under the vendor's own window name, copied across unchanged: no
// average across windows, no "remaining" figure, no conversion of a reset
// instant into a countdown that starts drifting the moment it is printed.

/**
 * One window a vendor NAMES, carrying that vendor's own numbers verbatim.
 *
 * `resetsAt` is whatever the vendor emitted — for Claude Code 2.1.260, MEASURED,
 * a Unix epoch in SECONDS — and panda neither rebases nor formats it.
 */
export interface UsageWindow {
  /** The vendor's own name for the window, e.g. `five_hour`. */
  readonly name: string
  /** The vendor's own utilisation number, unscaled. */
  readonly utilization: number
  /** The vendor's own reset instant, uninterpreted. */
  readonly resetsAt: number
}

/**
 * Why panda has no usage figure. Routed on (AD-7), never parsed out of prose.
 */
export const USAGE_ABSENCE_REASONS = {
  /** The executor publishes no usage surface panda can read. */
  noUsageSurface: 'PANDA_USAGE_NO_SURFACE',
  /** It does publish one, and no run has been recorded yet. */
  notObserved: 'PANDA_USAGE_NOT_OBSERVED',
  /** A run happened and carried no usage surface in its output. */
  notReported: 'PANDA_USAGE_NOT_REPORTED',
} as const

export type UsageAbsenceReason = (typeof USAGE_ABSENCE_REASONS)[keyof typeof USAGE_ABSENCE_REASONS]

const ABSENCE_REASONS: readonly string[] = Object.values(USAGE_ABSENCE_REASONS)

/**
 * What one executor reported, and WHEN it reported it.
 *
 * `observedAt` is not decoration: a utilisation is only true as of its reading,
 * so a report that hides its age is a report that lies with a straight face.
 */
export interface UsageObservation {
  readonly kind: 'observed'
  readonly executorId: string
  /** ISO-8601 instant at which panda read these values off the vendor. */
  readonly observedAt: string
  readonly windows: readonly UsageWindow[]
}

/** Typed absence with its reason (AD-5), which is never a zero and never a blank. */
export interface UsageAbsence {
  readonly kind: 'absent'
  readonly executorId: string
  readonly reason: UsageAbsenceReason
  /** The sentence a human reads, naming the exit when there is one. */
  readonly detail: string
}

export type UsageReport = UsageObservation | UsageAbsence

/** The constructor AD-5 asks for, so nobody hands a caller a bare `null`. */
export function usageObservation(
  executorId: string,
  windows: readonly UsageWindow[],
  observedAt: string,
): UsageObservation {
  return { kind: 'observed', executorId, observedAt, windows }
}

/** The absence constructor. A reason is required; there is no unreasoned absence. */
export function usageAbsence(executorId: string, reason: UsageAbsenceReason, detail: string): UsageAbsence {
  return { kind: 'absent', executorId, reason, detail }
}

function isUsageWindow(value: unknown): value is UsageWindow {
  return (
    isRecord(value) &&
    isNonEmptyString(value['name']) &&
    typeof value['utilization'] === 'number' &&
    Number.isFinite(value['utilization']) &&
    typeof value['resetsAt'] === 'number' &&
    Number.isFinite(value['resetsAt'])
  )
}

/**
 * Whether an arbitrary value is a usage report.
 *
 * A predicate rather than a throwing validator on purpose: the one caller reads
 * a file panda itself wrote, and a record it can no longer understand is a
 * record to report as ABSENT, not a reason to fail the command that reads it.
 */
export function isUsageReport(value: unknown): value is UsageReport {
  if (!isRecord(value) || !isNonEmptyString(value['executorId'])) return false
  if (value['kind'] === 'observed') {
    const windows = value['windows']
    return isNonEmptyString(value['observedAt']) && Array.isArray(windows) && windows.every(isUsageWindow)
  }
  return (
    value['kind'] === 'absent' &&
    typeof value['reason'] === 'string' &&
    ABSENCE_REASONS.includes(value['reason']) &&
    isNonEmptyString(value['detail'])
  )
}
