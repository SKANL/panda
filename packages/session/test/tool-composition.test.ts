import { describe, expect, it } from 'vitest'
import type {
  ExecutorAdapter,
  ResultEnvelope,
  SandboxCapabilityFacts,
  SandboxPolicy,
  SandboxProvider,
  ToolExecutor,
  ToolResult,
} from '@skanl/panda-contracts'
import {
  executeTool,
  runSession,
  type SandboxEvent,
  type SessionOptions,
  type ToolApprovalRequest,
  type ToolExecutionEvent,
} from '../src/index.ts'

const policy: SandboxPolicy = {
  version: 1,
  mode: 'read-only',
  workspaceRoot: '/workspace',
  requiredCapabilities: { filesystem: 'full' },
}

const capabilities: SandboxCapabilityFacts = {
  version: 1,
  providerId: 'test-sandbox',
  enforcement: 'simulated',
  controls: { filesystem: 'full', network: 'none', process: 'full', resources: 'full' },
}

function ok(): ResultEnvelope {
  return { status: 'ok', data: null, summary: 'completed', errors: [] }
}

describe('tool composition seam', () => {
  it('executes a validated local tool only after host approval and emits its result', async () => {
    const events: ToolExecutionEvent[] = []
    let approved = 0
    const result: ToolResult = {
      status: 'ok',
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      enforcement: capabilities,
    }
    const actual = await executeTool({
      invocation: { tool: { kind: 'local', argv: ['node', 'probe.mjs'] }, arguments: ['--exact'] },
      context: { cwd: '/workspace', environment: {}, policy },
      sandboxProvider: { id: 'test-sandbox', capabilities, createSession: async () => { throw new Error('unused') } },
      toolExecutor: {
        async execute(invocation, context) {
          expect(invocation.tool.argv).toEqual(['node', 'probe.mjs'])
          expect(invocation.arguments).toEqual(['--exact'])
          expect(context.policy).toEqual(policy)
          return result
        },
      },
      approveTool: () => {
        approved += 1
        return true
      },
      onToolExecution: (event) => events.push(event),
    })

    expect(actual).toBe(result)
    expect(approved).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]?.result).toBe(result)
  })

  it('rejects a denied tool before dispatching it', async () => {
    let executions = 0
    await expect(
      executeTool({
        invocation: { tool: { kind: 'local', argv: ['node'] }, arguments: [] },
        context: { cwd: '/workspace', environment: {}, policy },
        toolExecutor: { async execute() { executions += 1; return {} as ToolResult } },
        approveTool: () => false,
      }),
    ).rejects.toMatchObject({ code: 'PANDA_SANDBOX_DENIED' })
    expect(executions).toBe(0)
  })

  it('accepts semantically equal policies whose object keys were constructed in another order', async () => {
    const reordered: SandboxPolicy = {
      version: 1,
      mode: 'read-only',
      workspaceRoot: '/workspace',
      requiredCapabilities: { filesystem: 'full' },
    }
    const result: ToolResult = { status: 'ok', stdout: '', stderr: '', exitCode: 0, enforcement: capabilities }
    await expect(executeTool({
      invocation: { tool: { kind: 'local', argv: ['true'] }, arguments: [] },
      context: { cwd: '/workspace', environment: {}, policy: reordered },
      toolPolicy: { requiredCapabilities: { filesystem: 'full' }, workspaceRoot: '/workspace', mode: 'read-only', version: 1 },
      toolExecutor: { async execute() { return result } },
    })).resolves.toBe(result)
  })

  it('accepts validated tool dependencies without creating a sandbox session or executing a tool', async () => {
    let sessions = 0
    let executions = 0
    let approvals = 0
    let toolEvents = 0
    let sandboxEvents = 0
    const sandboxProvider: SandboxProvider = {
      id: 'test-sandbox',
      capabilities,
      async createSession() {
        sessions += 1
        throw new Error('a session tool flow does not exist yet')
      },
    }
    const toolExecutor: ToolExecutor = {
      async execute(): Promise<ToolResult> {
        executions += 1
        throw new Error('a session tool flow does not exist yet')
      },
    }
    const approveTool = (_request: ToolApprovalRequest): boolean => {
      void _request
      approvals += 1
      return true
    }
    const onToolExecution = (_event: ToolExecutionEvent): void => {
      void _event
      toolEvents += 1
    }
    const onSandboxEvent = (_event: SandboxEvent): void => {
      void _event
      sandboxEvents += 1
    }
    const adapter: ExecutorAdapter = { run: async () => ok() }
    const options: SessionOptions = {
      prompt: 'complete the task',
      sandboxProvider,
      toolExecutor,
      toolPolicy: policy,
      approveTool,
      onToolExecution,
      onSandboxEvent,
      createAdapter: () => adapter,
    }

    await expect(runSession(options)).resolves.toEqual(ok())
    expect({ sessions, executions, approvals, toolEvents, sandboxEvents }).toEqual({
      sessions: 0,
      executions: 0,
      approvals: 0,
      toolEvents: 0,
      sandboxEvents: 0,
    })
  })

  it('rejects a tool policy the supplied sandbox cannot prove before workspace or adapter execution', async () => {
    let adapterRuns = 0
    const sandboxProvider: SandboxProvider = {
      id: 'test-sandbox',
      capabilities: { ...capabilities, controls: { ...capabilities.controls, network: 'none' } },
      async createSession() {
        throw new Error('must not create a sandbox session')
      },
    }

    await expect(
      runSession({
        prompt: 'complete the task',
        sandboxProvider,
        toolPolicy: { ...policy, requiredCapabilities: { filesystem: 'full', network: 'full' } },
        createAdapter: () => ({
          async run(): Promise<ResultEnvelope> {
            adapterRuns += 1
            return ok()
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'PANDA_SANDBOX_CAPABILITY_UNAVAILABLE' })
    expect(adapterRuns).toBe(0)
  })
})
