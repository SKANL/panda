import { describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, validateToolExecutionContext, validateToolInvocation, validateToolResult } from '../src/index.ts'
import type { ToolResult } from '../src/index.ts'

const policy = {
  version: 1 as const,
  mode: 'read-only' as const,
  workspaceRoot: '/workspace',
  requiredCapabilities: { filesystem: 'full' as const, process: 'full' as const },
}

const context = { cwd: '/workspace', environment: { LANG: 'C' }, policy }

const enforcement = {
  version: 1 as const,
  providerId: 'fake',
  enforcement: 'simulated' as const,
  controls: { filesystem: 'full' as const, network: 'none' as const, process: 'full' as const, resources: 'full' as const },
}

const successfulToolResult: ToolResult = { status: 'ok', stdout: '', stderr: '', enforcement, exitCode: 0 }
const deniedToolResult: ToolResult = {
  status: 'denied',
  stdout: '',
  stderr: 'blocked',
  enforcement,
  error: { code: 'PANDA_SANDBOX_COMMAND_DENIED', message: 'blocked' },
}

// @ts-expect-error — a successful tool result cannot carry a sandbox error.
const successfulResultWithError: ToolResult = { ...successfulToolResult, error: { code: 'PANDA_SANDBOX_COMMAND_DENIED', message: 'blocked' } }
// @ts-expect-error — a denied tool result never has a process exit code.
const deniedResultWithExitCode: ToolResult = { ...deniedToolResult, exitCode: 1 }
// @ts-expect-error — each non-success status has its own error code.
const deniedResultWithRunnerFailure: ToolResult = { ...deniedToolResult, error: { code: 'PANDA_SANDBOX_RUNNER_FAILED', message: 'crashed' } }

void successfulResultWithError
void deniedResultWithExitCode
void deniedResultWithRunnerFailure

describe('tool execution contracts', () => {
  it('admits exact local argv and stdio MCP descriptors without shell or handler surfaces', () => {
    expect(validateToolInvocation({ tool: { kind: 'local', argv: ['git', 'status'] }, arguments: ['--short'] })).toEqual({
      tool: { kind: 'local', argv: ['git', 'status'] },
      arguments: ['--short'],
    })
    expect(validateToolInvocation({ tool: { kind: 'mcp-stdio', name: 'example.tool', argv: ['node', 'server.mjs'] }, arguments: {} })).toEqual({
      tool: { kind: 'mcp-stdio', name: 'example.tool', argv: ['node', 'server.mjs'] },
      arguments: {},
    })
    expect(() => validateToolInvocation({ tool: { kind: 'local', command: 'git status' }, arguments: [] })).toThrowError(
      expect.objectContaining({ code: PANDA_ERROR_CODES.toolInvocationInvalid }),
    )
    expect(() => validateToolInvocation({ tool: { kind: 'local', argv: ['git'], handler: () => undefined }, arguments: [] })).toThrowError(
      expect.objectContaining({ code: PANDA_ERROR_CODES.toolInvocationInvalid }),
    )
    expect(() => validateToolInvocation({ tool: { kind: 'mcp-http', argv: ['https://example.test'] }, arguments: [] })).toThrowError(
      expect.objectContaining({ code: PANDA_ERROR_CODES.toolInvocationInvalid }),
    )
  })

  it('rejects invalid arguments and context before an implementation can spawn', () => {
    expect(() => validateToolInvocation({ tool: { kind: 'local', argv: ['git'] }, arguments: ['bad\u0000arg'] })).toThrowError(
      expect.objectContaining({ code: PANDA_ERROR_CODES.toolInvocationInvalid }),
    )
    expect(() => validateToolExecutionContext({ ...context, shell: false })).toThrowError(
      expect.objectContaining({ code: PANDA_ERROR_CODES.sandboxRequestInvalid }),
    )
  })

  it('preserves sandbox denial and runner failure as distinct typed outcomes', () => {
    expect(validateToolResult({ status: 'denied', stdout: '', stderr: 'blocked', enforcement, error: { code: 'PANDA_SANDBOX_COMMAND_DENIED', message: 'blocked' } })).toMatchObject({ status: 'denied' })
    expect(validateToolResult({ status: 'failed', stdout: '', stderr: 'crashed', enforcement, error: { code: 'PANDA_SANDBOX_RUNNER_FAILED', message: 'crashed' } })).toMatchObject({ status: 'failed' })
  })

  it('rejects combinations that the public ToolResult union cannot represent', () => {
    expect(() => validateToolResult({ status: 'ok', stdout: '', stderr: '', enforcement, exitCode: 0, error: { code: 'PANDA_SANDBOX_COMMAND_DENIED', message: 'blocked' } })).toThrowError(
      expect.objectContaining({ code: PANDA_ERROR_CODES.sandboxResponseInvalid }),
    )
    expect(() => validateToolResult({ status: 'denied', stdout: '', stderr: 'blocked', enforcement, exitCode: 1, error: { code: 'PANDA_SANDBOX_COMMAND_DENIED', message: 'blocked' } })).toThrowError(
      expect.objectContaining({ code: PANDA_ERROR_CODES.sandboxResponseInvalid }),
    )
  })
})
