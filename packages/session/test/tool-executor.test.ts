import { describe, expect, it } from 'vitest'
import { PandaError, type SandboxCapabilityFacts, type SandboxExecutionRequest, type SandboxExecutionResult, type SandboxStdioSession, type ToolProvider } from '@skanl/panda-contracts'
import type { ResolvedSandboxSession } from '@skanl/panda-sandbox'
import { createToolExecutor } from '../src/index.ts'

const policy = {
  version: 1 as const,
  mode: 'read-only' as const,
  workspaceRoot: '/workspace',
  requiredCapabilities: { filesystem: 'full' as const },
}

const enforcement: SandboxCapabilityFacts = {
  version: 1,
  providerId: 'fake',
  enforcement: 'simulated',
  controls: { filesystem: 'full', network: 'none', process: 'full', resources: 'full' },
}

class FakeSandboxSession implements ResolvedSandboxSession {
  readonly id = 'fake-session'
  readonly providerId = 'fake'
  readonly capabilities = enforcement
  readonly executions: SandboxExecutionRequest[] = []
  disposals = 0
  result: SandboxExecutionResult = { status: 'ok', stdout: 'ok', stderr: '', exitCode: 0, enforcement }

  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    this.executions.push(request)
    return this.result
  }

  openStdio?: (request: SandboxExecutionRequest) => Promise<SandboxStdioSession>

  async dispose(): Promise<void> {
    this.disposals += 1
  }
}

const context = { cwd: '/workspace', environment: { LANG: 'C' }, policy }

describe('createToolExecutor', () => {
  it('does not execute discovery and forwards exact argv through the sandbox session', async () => {
    const session = new FakeSandboxSession()
    let discoveryCalls = 0
    const provider: ToolProvider = {
      sourceId: 'discovery-only',
      list: () => {
        discoveryCalls += 1
        return []
      },
    }
    const executor = createToolExecutor(session)
    const invocation = { tool: { kind: 'local' as const, argv: ['git', '-C', '/workspace'] as const }, arguments: ['status', '--short'] as const }

    await expect(executor.execute(invocation, context)).resolves.toMatchObject({ status: 'ok', stdout: 'ok' })
    expect(session.executions).toEqual([{ argv: ['git', '-C', '/workspace', 'status', '--short'], ...context }])
    expect(Object.keys(session.executions[0] ?? {})).not.toContain('shell')
    expect(provider.sourceId).toBe('discovery-only')
    expect(discoveryCalls).toBe(0)
    expect(session.disposals).toBe(0)
  })

  it('rejects invalid arguments before calling the sandbox session', async () => {
    const session = new FakeSandboxSession()
    const executor = createToolExecutor(session)

    await expect(executor.execute({ tool: { kind: 'local', argv: ['git'] }, arguments: ['bad\u0000arg'] }, context)).rejects.toMatchObject({
      code: 'PANDA_TOOL_INVOCATION_INVALID',
    })
    expect(session.executions).toEqual([])
  })

  it('fails closed when an MCP session does not expose stdio', async () => {
    const session = new FakeSandboxSession()
    const executor = createToolExecutor(session)

    await expect(executor.execute(
      { tool: { kind: 'mcp-stdio', argv: ['node'], name: 'x' }, arguments: {} },
      context,
    )).rejects.toMatchObject({ code: 'PANDA_SANDBOX_UNAVAILABLE' })
    expect(session.executions).toEqual([])
  })

  it('keeps policy denial distinct from a runner failure', async () => {
    const session = new FakeSandboxSession()
    const executor = createToolExecutor(session)
    const invocation = { tool: { kind: 'local' as const, argv: ['node', 'server.mjs'] as const }, arguments: [] as const }

    session.result = { status: 'denied', stdout: '', stderr: 'blocked', enforcement, error: { code: 'PANDA_SANDBOX_COMMAND_DENIED', message: 'blocked' } }
    await expect(executor.execute(invocation, context)).resolves.toMatchObject({ status: 'denied' })
    session.result = { status: 'failed', stdout: '', stderr: 'crashed', enforcement, error: { code: 'PANDA_SANDBOX_RUNNER_FAILED', message: 'crashed' } }
    await expect(executor.execute(invocation, context)).resolves.toMatchObject({ status: 'failed' })
  })

  it('executes MCP stdio in protocol order and correlates response ids', async () => {
    const session = new FakeSandboxSession()
    const frames: string[] = []
    const responses = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'hello' }], isError: false } }),
    ]
    const stdio: SandboxStdioSession = {
      sendFrame: async (frame) => { frames.push(frame) },
      receiveFrame: async () => responses.shift() ?? '',
      close: async () => { frames.push('closed') },
    }
    session.openStdio = async (request) => {
      expect(request.argv).toEqual(['node', 'server.mjs'])
      expect(request.cwd).toBe('/workspace')
      return stdio
    }

    const result = await createToolExecutor(session).execute(
      { tool: { kind: 'mcp-stdio', argv: ['node', 'server.mjs'], name: 'greet' }, arguments: { who: 'Ada' } },
      context,
    )

    expect(result).toMatchObject({ status: 'ok', exitCode: 0, enforcement })
    expect(frames.slice(0, 3).map((frame) => JSON.parse(frame).method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect(JSON.parse(frames[2]!).params).toEqual({ name: 'greet', arguments: { who: 'Ada' } })
    expect(frames[3]).toBe('closed')
  })

  it('rejects malformed or mismatched MCP responses and still closes', async () => {
    const session = new FakeSandboxSession()
    let closed = 0
    session.openStdio = async () => ({
      sendFrame: async () => {},
      receiveFrame: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
      close: async () => { closed += 1 },
    })

    await expect(createToolExecutor(session).execute(
      { tool: { kind: 'mcp-stdio', argv: ['node'], name: 'x' }, arguments: {} },
      context,
    )).rejects.toMatchObject({ code: 'PANDA_SANDBOX_RESPONSE_INVALID' })
    expect(closed).toBe(1)
  })

  it('rejects a malformed MCP response and still closes', async () => {
    const session = new FakeSandboxSession()
    let closed = 0
    let receives = 0
    session.openStdio = async () => ({
      sendFrame: async () => {},
      receiveFrame: async () => {
        receives += 1
        return receives === 1 ? JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) : '{malformed'
      },
      close: async () => { closed += 1 },
    })

    await expect(createToolExecutor(session).execute(
      { tool: { kind: 'mcp-stdio', argv: ['node'], name: 'x' }, arguments: {} },
      context,
    )).rejects.toMatchObject({ code: 'PANDA_SANDBOX_RESPONSE_INVALID' })
    expect(closed).toBe(1)
  })

  it.each([
    ['missing id', { jsonrpc: '2.0', result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }],
    ['invalid id', { jsonrpc: '2.0', id: '1', result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }],
    ['missing jsonrpc', { id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }],
    ['invalid jsonrpc', { jsonrpc: '1.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }],
  ])('rejects MCP responses with %s', async (_case, response) => {
    const session = new FakeSandboxSession()
    let closed = 0
    session.openStdio = async () => ({
      sendFrame: async () => {},
      receiveFrame: async () => JSON.stringify(response),
      close: async () => { closed += 1 },
    })

    await expect(createToolExecutor(session).execute(
      { tool: { kind: 'mcp-stdio', argv: ['node'], name: 'x' }, arguments: {} },
      context,
    )).rejects.toMatchObject({ code: 'PANDA_SANDBOX_RESPONSE_INVALID' })
    expect(closed).toBe(1)
  })

  it('rejects an MCP response containing both result and error', async () => {
    const session = new FakeSandboxSession()
    let closed = 0
    session.openStdio = async () => ({
      sendFrame: async () => {},
      receiveFrame: async () => JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } },
        error: { code: -32000, message: 'failure' },
      }),
      close: async () => { closed += 1 },
    })

    await expect(createToolExecutor(session).execute(
      { tool: { kind: 'mcp-stdio', argv: ['node'], name: 'x' }, arguments: {} },
      context,
    )).rejects.toMatchObject({ code: 'PANDA_SANDBOX_RESPONSE_INVALID' })
    expect(closed).toBe(1)
  })

  it('rejects malformed MCP error objects', async () => {
    const session = new FakeSandboxSession()
    let closed = 0
    session.openStdio = async () => ({
      sendFrame: async () => {},
      receiveFrame: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 'bad' } }),
      close: async () => { closed += 1 },
    })

    await expect(createToolExecutor(session).execute(
      { tool: { kind: 'mcp-stdio', argv: ['node'], name: 'x' }, arguments: {} },
      context,
    )).rejects.toMatchObject({ code: 'PANDA_SANDBOX_RESPONSE_INVALID' })
    expect(closed).toBe(1)
  })

  it('rejects an invalid initialize result shape', async () => {
    const session = new FakeSandboxSession()
    let closed = 0
    session.openStdio = async () => ({
      sendFrame: async () => {},
      receiveFrame: async () => JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake' } },
      }),
      close: async () => { closed += 1 },
    })

    await expect(createToolExecutor(session).execute(
      { tool: { kind: 'mcp-stdio', argv: ['node'], name: 'x' }, arguments: {} },
      context,
    )).rejects.toMatchObject({ code: 'PANDA_SANDBOX_RESPONSE_INVALID' })
    expect(closed).toBe(1)
  })

  it('rejects an invalid tools-call result shape', async () => {
    const session = new FakeSandboxSession()
    let closed = 0
    let receives = 0
    session.openStdio = async () => ({
      sendFrame: async () => {},
      receiveFrame: async () => {
        receives += 1
        return receives === 1
          ? JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } })
          : JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: 'not-an-array', isError: false } })
      },
      close: async () => { closed += 1 },
    })

    await expect(createToolExecutor(session).execute(
      { tool: { kind: 'mcp-stdio', argv: ['node'], name: 'x' }, arguments: {} },
      context,
    )).rejects.toMatchObject({ code: 'PANDA_SANDBOX_RESPONSE_INVALID' })
    expect(closed).toBe(1)
  })

  it('preserves sandbox cancellation distinctly and closes the channel', async () => {
    const session = new FakeSandboxSession()
    let closed = 0
    session.openStdio = async () => ({
      sendFrame: async (_frame, signal) => {
        if (signal?.aborted) throw new PandaError('PANDA_SANDBOX_ABORTED' as never, 'cancelled')
      },
      receiveFrame: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
      close: async () => { closed += 1 },
    })
    const controller = new AbortController()
    controller.abort()

    await expect(createToolExecutor(session).execute(
      { tool: { kind: 'mcp-stdio', argv: ['node'], name: 'x' }, arguments: {} },
      { ...context, signal: controller.signal },
    )).rejects.toMatchObject({ code: 'PANDA_SANDBOX_ABORTED' })
    expect(closed).toBe(1)
  })

  it('forwards cancellation and leaves caller-owned sandbox teardown to the caller', async () => {
    const session = new FakeSandboxSession()
    const executor = createToolExecutor(session)
    const controller = new AbortController()
    controller.abort()

    await executor.execute({ tool: { kind: 'local', argv: ['git'] }, arguments: [] }, { ...context, signal: controller.signal })
    expect(session.executions[0]?.signal).toBe(controller.signal)
    expect(session.disposals).toBe(0)
    await session.dispose()
    expect(session.disposals).toBe(1)
  })

  it('does not translate sandbox runner exceptions into policy denials', async () => {
    const session = new FakeSandboxSession()
    session.execute = async (): Promise<SandboxExecutionResult> => {
      throw new PandaError('PANDA_SANDBOX_UNAVAILABLE', 'runner disconnected')
    }

    await expect(createToolExecutor(session).execute({ tool: { kind: 'local', argv: ['git'] }, arguments: [] }, context)).rejects.toMatchObject({
      code: 'PANDA_SANDBOX_UNAVAILABLE',
    })
  })
})
