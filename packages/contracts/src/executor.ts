import { PandaError, PANDA_ERROR_CODES } from './errors'
import { defineStandardSchema } from './standard-schema'
import type { StandardSchemaIssue, StandardSchemaResult, StandardSchemaV1 } from './standard-schema'
import { isNonEmptyString, isRecord, issue } from './validation'
import type { WorkspaceHandle } from './workspace'
import { workspaceHandleIssues } from './workspace'

export type ResultStatus = 'ok' | 'failed'

export interface EnvelopeError {
  readonly message: string
  readonly code?: string
}

// The typed structured result envelope every adapter returns.
//
// Layering: the schema below is the single source of truth for envelope shape —
// including the invariant that status 'failed' REQUIRES a non-empty errors array.
// The contract-suite completeness clauses stay as behavioral checks on envelopes
// adapters actually return at runtime; they exist to produce clause-named
// diagnostics, not to redefine shape.
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
  if (status !== 'ok' && status !== 'failed') {
    issues.push(issue("'status' must be 'ok' or 'failed'"))
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

function runRequestIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('run request must be an object')]
  const issues: StandardSchemaIssue[] = []
  if (!isNonEmptyString(value['prompt'])) issues.push(issue("'prompt' must be a non-empty string"))
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
