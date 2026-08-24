import { PandaError, PANDA_ERROR_CODES } from './errors.ts'
import { defineStandardSchema } from './standard-schema.ts'
import type { StandardSchemaIssue, StandardSchemaResult, StandardSchemaV1 } from './standard-schema.ts'
import { isNonEmptyString, isRecord, issue } from './validation.ts'

export type WorkspaceCapability = 'read' | 'write'

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>(['read', 'write'])

export interface WorkspaceHandle {
  readonly id: string
  readonly rootPath: string
  readonly capabilities: readonly WorkspaceCapability[]
}

// The workspace abstraction executors run inside. State written into a workspace
// persists across acquire/release cycles; the executor process itself is ephemeral.
//
// Lease model (intentional): every handle is an independent single-use lease. Two
// simultaneously-live handles to the same workspace may each be released exactly
// once; releasing the SAME handle twice raises PANDA_CONTRACT_WORKSPACE_DOUBLE_RELEASE.
// After dispose(), every operation — including release() of outstanding handles —
// raises PANDA_CONTRACT_PROVIDER_DISPOSED.
export interface WorkspaceProvider {
  create(): Promise<WorkspaceHandle>
  acquire(id: string): Promise<WorkspaceHandle>
  release(handle: WorkspaceHandle): Promise<void>
  dispose(): Promise<void>
}

function throwSchemaViolation(issues: readonly StandardSchemaIssue[]): never {
  throw new PandaError(
    PANDA_ERROR_CODES.contractEnvelopeInvalid,
    `schema violation: ${issues.map((entry) => entry.message).join('; ')}`,
  )
}

// Non-throwing issue collector shared with sibling schema modules.
export function workspaceHandleIssues(value: unknown): StandardSchemaIssue[] {
  if (!isRecord(value)) return [issue('workspace handle must be an object')]
  const issues: StandardSchemaIssue[] = []
  if (!isNonEmptyString(value['id'])) issues.push(issue("'id' must be a non-empty string"))
  if (!isNonEmptyString(value['rootPath'])) issues.push(issue("'rootPath' must be a non-empty string"))
  const capabilities = value['capabilities']
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    issues.push(issue("'capabilities' must be a non-empty array"))
    return issues
  }
  const seen = new Set<string>()
  for (const capability of capabilities) {
    if (typeof capability !== 'string' || !KNOWN_CAPABILITIES.has(capability)) {
      issues.push(issue("'capabilities' entries must be 'read' or 'write'"))
      return issues
    }
    if (seen.has(capability)) {
      issues.push(issue("'capabilities' must not contain duplicate entries"))
      return issues
    }
    seen.add(capability)
  }
  return issues
}

// Programmatic validation: raises a coded PandaError on schema violations.
export function validateWorkspaceHandle(value: unknown): WorkspaceHandle {
  const issues = workspaceHandleIssues(value)
  if (issues.length > 0) throwSchemaViolation(issues)
  return value as WorkspaceHandle
}

export const WORKSPACE_HANDLE_SCHEMA: StandardSchemaV1<WorkspaceHandle> = defineStandardSchema(
  (value): StandardSchemaResult<WorkspaceHandle> => {
    const issues = workspaceHandleIssues(value)
    return issues.length > 0 ? { issues } : { value: value as WorkspaceHandle }
  },
)
