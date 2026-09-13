import { PANDA_ERROR_CODES, PandaError, validateSandboxExecutionRequest, validateToolExecutionContext, validateToolInvocation, validateToolResult } from '@skanl/panda-contracts'
import type { LocalToolInvocation, McpStdioToolInvocation, SandboxStdioSession, ToolExecutionContext, ToolExecutor, ToolInvocation, ToolResult } from '@skanl/panda-contracts'
import type { ResolvedSandboxSession } from '@skanl/panda-sandbox'

const MCP_PROTOCOL_VERSION = '2024-11-05'

function invalidResponse(message: string): PandaError {
  return new PandaError(PANDA_ERROR_CODES.sandboxResponseInvalid, `invalid MCP response: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validateError(value: unknown): void {
  if (!isRecord(value) || !Number.isInteger(value['code']) || !isNonEmptyString(value['message'])) {
    throw invalidResponse('error must contain an integer code and non-empty message')
  }
}

function parseResponse(frame: string, expectedId: number): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch (error) {
    throw invalidResponse(`frame is not JSON (${error instanceof Error ? error.message : 'parse failure'})`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponse('response must be an object')
  const response = value as Record<string, unknown>
  if (response['jsonrpc'] !== '2.0') throw invalidResponse("response 'jsonrpc' must be '2.0'")
  if (response['id'] !== expectedId) throw invalidResponse(`response id does not match request ${expectedId}`)
  const hasResult = Object.hasOwn(response, 'result')
  const hasError = Object.hasOwn(response, 'error')
  if (hasResult === hasError) throw invalidResponse('response must contain exactly one of result or error')
  if (hasError) validateError(response['error'])
  return response
}

function validateInitializeResult(value: unknown): void {
  if (!isRecord(value)) throw invalidResponse("initialize result must be an object")
  const serverInfo = value['serverInfo']
  if (!isNonEmptyString(value['protocolVersion'])) throw invalidResponse("initialize result 'protocolVersion' must be a non-empty string")
  if (!isRecord(value['capabilities'])) throw invalidResponse("initialize result 'capabilities' must be an object")
  if (!isRecord(serverInfo) || !isNonEmptyString(serverInfo['name']) || !isNonEmptyString(serverInfo['version'])) {
    throw invalidResponse("initialize result 'serverInfo' must contain non-empty name and version strings")
  }
  if (value['instructions'] !== undefined && typeof value['instructions'] !== 'string') {
    throw invalidResponse("initialize result 'instructions' must be a string when present")
  }
}

function validateToolCallResult(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value['content'])) throw invalidResponse("tools/call result 'content' must be an array")
  for (const [index, content] of value['content'].entries()) {
    if (!isRecord(content) || !isNonEmptyString(content['type'])) {
      throw invalidResponse(`tools/call result content[${index}] must contain a non-empty type string`)
    }
    if (content['type'] === 'text' && typeof content['text'] !== 'string') {
      throw invalidResponse(`tools/call result content[${index}] text must be a string`)
    }
  }
  if (value['isError'] !== undefined && typeof value['isError'] !== 'boolean') {
    throw invalidResponse("tools/call result 'isError' must be a boolean when present")
  }
  if (value['structuredContent'] !== undefined && !isRecord(value['structuredContent'])) {
    throw invalidResponse("tools/call result 'structuredContent' must be an object when present")
  }
}

function validateResult(method: string, value: unknown): void {
  if (method === 'initialize') {
    validateInitializeResult(value)
    return
  }
  if (method === 'tools/call') validateToolCallResult(value)
}

async function request(
  stdio: SandboxStdioSession,
  id: number,
  method: string,
  params: unknown,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  await stdio.sendFrame(JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal)
  const response = parseResponse(await stdio.receiveFrame(signal), id)
  if (Object.hasOwn(response, 'error')) {
    throw new PandaError(PANDA_ERROR_CODES.executorRunFailed, `MCP request '${method}' failed`)
  }
  validateResult(method, response['result'])
  return response
}

function mcpResult(session: ResolvedSandboxSession, value: unknown): ToolResult {
  return validateToolResult({
    status: 'ok',
    stdout: JSON.stringify(value),
    stderr: '',
    exitCode: 0,
    enforcement: session.capabilities ?? {
      version: 1,
      providerId: session.providerId,
      enforcement: 'simulated',
      controls: { filesystem: 'none', network: 'none', process: 'none', resources: 'none' },
    },
  })
}

async function executeMcp(session: ResolvedSandboxSession, invocation: McpStdioToolInvocation, context: ToolExecutionContext): Promise<ToolResult> {
  const requestContext = validateToolExecutionContext(context)
  const sandboxRequest = validateSandboxExecutionRequest({ ...requestContext, argv: [...invocation.tool.argv] as [string, ...string[]] })
  if (typeof session.openStdio !== 'function') {
    throw new PandaError(PANDA_ERROR_CODES.sandboxUnavailable, `sandbox session '${session.id}' does not expose stdio`)
  }
  const stdio = await session.openStdio(sandboxRequest)
  try {
    await requestMcp(stdio, sandboxRequest.signal)
    const response = await request(stdio, 2, 'tools/call', { name: invocation.tool.name, arguments: invocation.arguments }, sandboxRequest.signal)
    return mcpResult(session, response['result'])
  } finally {
    await stdio.close()
  }
}

async function requestMcp(stdio: SandboxStdioSession, signal: AbortSignal | undefined): Promise<void> {
  await request(stdio, 1, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'panda', version: '0.1.0' },
  }, signal)
  await stdio.sendFrame(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }), signal)
}

/**
 * Binds a caller-owned sandbox session to tool execution. Discovery stays
 * elsewhere: accepting a ToolProvider here would turn listing into authority.
 * This executor never owns or disposes the supplied session.
 */
export function createToolExecutor(session: ResolvedSandboxSession): ToolExecutor {
  return Object.freeze({
    async execute(invocation: ToolInvocation, context: ToolExecutionContext): Promise<ToolResult> {
      // Both validations finish before the first await and therefore before the
      // sandbox provider can create or signal a process.
      const tool = validateToolInvocation(invocation)
      if (tool.tool.kind === 'mcp-stdio') return executeMcp(session, tool as McpStdioToolInvocation, context)
      const executionContext = validateToolExecutionContext(context)
      const localInvocation = tool as LocalToolInvocation
      const request = validateSandboxExecutionRequest({
        ...executionContext,
        argv: [...localInvocation.tool.argv, ...localInvocation.arguments] as [string, ...string[]],
      })
      return validateToolResult(await session.execute(request))
    },
  })
}
