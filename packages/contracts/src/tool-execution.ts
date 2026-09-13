import { PANDA_ERROR_CODES, PandaError } from './errors.ts'
import { SANDBOX_ERROR_CODES, validateSandboxExecutionRequest, validateSandboxExecutionResult } from './sandbox.ts'
import type {
  SandboxCapabilityFacts,
  SandboxExecutionError,
  SandboxExecutionResult,
  SandboxPolicy,
  SandboxSnapshot,
} from './sandbox.ts'
import { isNonEmptyString, isRecord } from './validation.ts'

/** A local command is always exact argv; panda never accepts a shell string. */
export interface LocalTool {
  readonly kind: 'local'
  readonly argv: readonly [string, ...string[]]
}

/** A local MCP server connected over stdio; network transports are not in v1. */
export interface McpStdioTool {
  readonly kind: 'mcp-stdio'
  readonly argv: readonly [string, ...string[]]
  readonly name: string
}

export type Tool = LocalTool | McpStdioTool

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject

export interface JsonObject {
  readonly [key: string]: JsonValue
}

export interface LocalToolInvocation {
  readonly tool: LocalTool
  /** Tokens appended to the descriptor argv without parsing or shell expansion. */
  readonly arguments: readonly string[]
}

export interface McpStdioToolInvocation {
  readonly tool: McpStdioTool
  /** Structured JSON object passed as the MCP tools/call arguments. */
  readonly arguments: JsonObject
}

export type ToolInvocation = LocalToolInvocation | McpStdioToolInvocation

export interface ToolExecutionContext {
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly policy: SandboxPolicy
  readonly snapshots?: readonly SandboxSnapshot[]
  readonly signal?: AbortSignal
}

interface ToolResultBase {
  readonly stdout: string
  readonly stderr: string
  readonly enforcement: SandboxCapabilityFacts
}

interface SuccessfulToolResult extends ToolResultBase {
  readonly status: 'ok'
  readonly exitCode: number
  readonly error?: never
}

interface FailedToolResult<Status extends Exclude<SandboxExecutionResult['status'], 'ok'>, Code extends SandboxExecutionError['code']>
  extends ToolResultBase {
  readonly status: Status
  readonly exitCode?: never
  readonly error: Readonly<{ code: Code; message: string }>
}

/** A normalized tool outcome whose status determines its only valid result shape. */
export type ToolResult =
  | SuccessfulToolResult
  | FailedToolResult<'denied', typeof SANDBOX_ERROR_CODES.commandDenied>
  | FailedToolResult<'failed', typeof SANDBOX_ERROR_CODES.runnerFailed>
  | FailedToolResult<'timed-out', typeof SANDBOX_ERROR_CODES.timedOut>
  | FailedToolResult<'aborted', typeof SANDBOX_ERROR_CODES.aborted>
  | FailedToolResult<'unavailable', typeof SANDBOX_ERROR_CODES.unavailable>

export interface ToolExecutor {
  execute(invocation: ToolInvocation, context: ToolExecutionContext): Promise<ToolResult>
}

function invalid(message: string): PandaError {
  return new PandaError(PANDA_ERROR_CODES.toolInvocationInvalid, `invalid tool invocation: ${message}`)
}

function isSafeToken(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index)
    if (codePoint < 32 || codePoint === 127) return false
  }
  return true
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function validatedTool(value: unknown): Tool {
  if (!isRecord(value)) throw invalid("'tool' must be an object")
  if (value['kind'] !== 'local' && value['kind'] !== 'mcp-stdio') throw invalid("'tool.kind' must be 'local' or 'mcp-stdio'")
  const allowedKeys = value['kind'] === 'local' ? ['kind', 'argv'] : ['kind', 'argv', 'name']
  if (!hasOnlyKeys(value, allowedKeys)) throw invalid("'tool' contains an unknown field")
  if (!Array.isArray(value['argv']) || value['argv'].length === 0 || !value['argv'].every(isSafeToken)) {
    throw invalid("'tool.argv' must be a non-empty array of safe strings")
  }
  const argv = Object.freeze([...value['argv']]) as Tool['argv']
  if (value['kind'] === 'local') return Object.freeze({ kind: 'local', argv })
  if (!isSafeToken(value['name'])) throw invalid("'tool.name' must be a non-empty safe string")
  return Object.freeze({ kind: 'mcp-stdio', argv, name: value['name'] })
}

function normalizedJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const normalized = value.map(normalizedJsonValue)
    if (normalized.some((item) => item === undefined)) return undefined
    return Object.freeze(normalized) as readonly JsonValue[]
  }
  if (!isRecord(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const key of Object.keys(value)) {
    const item = normalizedJsonValue(value[key])
    if (item === undefined) return undefined
    normalized[key] = item
  }
  return Object.freeze(normalized)
}

function normalizedJsonObject(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) return undefined
  const normalized = normalizedJsonValue(value)
  if (normalized === undefined || normalized === null || Array.isArray(normalized) || typeof normalized !== 'object') return undefined
  return normalized as JsonObject
}

export function validateToolInvocation(value: unknown): ToolInvocation {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tool', 'arguments'])) throw invalid("an invocation must contain only 'tool' and 'arguments'")
  const tool = validatedTool(value['tool'])
  const argumentsValue = value['arguments']
  if (tool.kind === 'local') {
    if (!Array.isArray(argumentsValue) || !argumentsValue.every(isSafeToken)) throw invalid("'arguments' must be an array of safe strings")
    return Object.freeze({ tool, arguments: Object.freeze([...argumentsValue]) })
  }
  const argumentsObject = normalizedJsonObject(argumentsValue)
  if (argumentsObject === undefined) throw invalid("'arguments' must be a JSON object for an MCP tool")
  return Object.freeze({ tool, arguments: argumentsObject })
}

/** Validates the non-argv sandbox request before a ToolExecutor can call a session. */
export function validateToolExecutionContext(value: unknown): ToolExecutionContext {
  if (!isRecord(value) || !hasOnlyKeys(value, ['cwd', 'environment', 'policy', 'snapshots', 'signal'])) {
    throw new PandaError(PANDA_ERROR_CODES.sandboxRequestInvalid, 'invalid tool execution context: unknown field')
  }
  const request = validateSandboxExecutionRequest({ argv: ['panda-tool'], ...value })
  return Object.freeze({
    cwd: request.cwd,
    environment: request.environment,
    policy: request.policy,
    ...(request.snapshots === undefined ? {} : { snapshots: request.snapshots }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
}

export function validateToolResult(value: unknown): ToolResult {
  const result = validateSandboxExecutionResult(value)
  if (result.status !== 'ok' && result.exitCode !== undefined) {
    throw new PandaError(PANDA_ERROR_CODES.sandboxResponseInvalid, 'invalid tool result: a non-success status cannot include an exitCode')
  }
  return result as ToolResult
}
