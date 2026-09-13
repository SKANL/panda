import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { PANDA_ERROR_CODES, SANDBOX_ERROR_CODES, validateSandboxAuditEvent } from '@skanl/panda-contracts'
import { createLocalSandboxProvider } from '../src/index.ts'
import { createLinuxSandboxProvider } from '../src/linux.ts'
import { createMacosSandboxProvider } from '../src/macos.ts'
import { createWindowsSandboxProvider } from '../src/windows.ts'
import { containedWorkspace, createProvider, type LocalSandboxRunner } from '../src/shared.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (command: string, args?: readonly string[], options?: object) => {
      if (command !== 'panda-windows-sandbox-broker') return actual.spawn(command, args, options)
      const child = new EventEmitter() as EventEmitter & {
        readonly pid: undefined
        readonly stdout: EventEmitter
        readonly stderr: EventEmitter
        killed: boolean
        kill: () => boolean
      }
      Object.assign(child, { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false })
      child.kill = () => { child.killed = true; return true }
      queueMicrotask(() => child.emit('close', 0))
      return child
    },
  }
})

const execFileAsync = promisify(execFile)

const policy = {
  version: 1 as const,
  mode: 'read-only' as const,
  workspaceRoot: '/workspace',
  requiredCapabilities: { filesystem: 'full' as const, process: 'full' as const },
}

const dangerousPolicy = {
  version: 1 as const,
  mode: 'danger-full-access' as const,
  workspaceRoot: '/workspace',
  requiredCapabilities: {},
  allowDangerous: true as const,
}

class InjectedChild extends EventEmitter {
  readonly pid = undefined
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed = false
  close = (exitCode: number | null = null): void => { this.emit('close', exitCode) }
  kill = (): boolean => { this.killed = true; return true }
}

class InjectedStdioChild extends EventEmitter {
  readonly pid = undefined
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: (encoding: BufferEncoding): void => { void encoding } })
  readonly stderr = new EventEmitter()
  readonly writes: string[] = []
  killed = false
  killAttempts = 0
  blockWrites = false
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.writes.push(chunk)
      return !this.blockWrites
    },
    once: (event: string, listener: () => void): void => { this.on(`stdin:${event}`, listener) },
    removeListener: (event: string, listener: () => void): void => { this.off(`stdin:${event}`, listener) },
  }
  close = (): void => { this.emit('close', null) }
  kill = (): boolean => { this.killAttempts += 1; this.killed = true; return true }
}

function injectedRunner(child: InjectedChild, calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }>): LocalSandboxRunner {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } })
    return child as unknown as ChildProcess
  }
}

function successfulRunner(): LocalSandboxRunner {
  return (command, args, options) => {
    const child = new InjectedChild()
    queueMicrotask(() => child.close(0))
    void command
    void args
    void options
    return child as unknown as ChildProcess
  }
}

async function waitForRunnerRegistrations(calls: readonly unknown[], expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && calls.length < expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(calls).toHaveLength(expected)
}

describe('@skanl/panda-sandbox-local', () => {
  it('loads its source entry with Node strip-only TypeScript', async () => {
    const entryUrl = new URL('../src/index.ts', import.meta.url).href
    const { stdout } = await execFileAsync(process.execPath, [
      '--conditions=panda-source',
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(entryUrl)}); console.log('source entry imported')`,
    ])

    expect(stdout).toBe('source entry imported\n')
  })

  it('accepts the physical workspace root and its descendant', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-contained-workspace-'))
    const workspaceRoot = join(fixture, 'workspace')
    const descendant = join(workspaceRoot, 'nested')
    await mkdir(descendant, { recursive: true })

    try {
      await expect(containedWorkspace(workspaceRoot, workspaceRoot)).resolves.toBe(true)
      await expect(containedWorkspace(descendant, workspaceRoot)).resolves.toBe(true)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('does not spawn an already-aborted stdio request', async () => {
    const child = new InjectedStdioChild()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider('test-local', { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false }, 'full', 1_000, (request) => request.argv, injectedRunner(child, calls))
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const controller = new AbortController()
    controller.abort()

    await expect(session.openStdio!({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy, signal: controller.signal })).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.aborted })
    expect(calls).toEqual([])
    await session.dispose()
  })

  it('does not spawn stdio outside the physically proven workspace', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-stdio-containment-'))
    const workspaceRoot = join(fixture, 'workspace')
    const outside = join(fixture, 'outside')
    const escape = join(workspaceRoot, 'escape')
    await Promise.all([mkdir(workspaceRoot), mkdir(outside)])
    const child = new InjectedStdioChild()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider('test-local', { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false }, 'full', 1_000, (request) => request.argv, injectedRunner(child, calls))
    try {
      try {
        await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error: unknown) {
        if (error instanceof Error && ['EACCES', 'ENOTSUP', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return
        throw error
      }
      const sessionPolicy = { ...dangerousPolicy, workspaceRoot }
      const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
      await expect(session.openStdio!({ argv: [process.execPath], cwd: escape, environment: {}, policy: sessionPolicy })).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.unavailable })
      expect(calls).toEqual([])
      await session.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects physical workspace parents and siblings', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-contained-workspace-'))
    const workspaceRoot = join(fixture, 'workspace')
    const sibling = join(fixture, 'sibling')
    await Promise.all([mkdir(workspaceRoot), mkdir(sibling)])

    try {
      await expect(containedWorkspace(fixture, workspaceRoot)).resolves.toBe(false)
      await expect(containedWorkspace(sibling, workspaceRoot)).resolves.toBe(false)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a physical escape link when the host supports creating one', async (context) => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-contained-workspace-'))
    const workspaceRoot = join(fixture, 'workspace')
    const outside = join(fixture, 'outside')
    const escape = join(workspaceRoot, 'escape')
    await Promise.all([mkdir(workspaceRoot), mkdir(outside)])

    try {
      try {
        await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error: unknown) {
        if (error instanceof Error && ['EACCES', 'ENOTSUP', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          context.skip(`host cannot create directory links: ${(error as NodeJS.ErrnoException).code}`)
          return
        }
        throw error
      }

      await expect(containedWorkspace(escape, workspaceRoot)).resolves.toBe(false)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it.each([
    ['linux', 'local-linux'],
    ['darwin', 'local-macos'],
    ['win32', 'local-windows'],
  ] as const)('dispatches %s to the %s provider', async (platform, providerId) => {
    const provider = await createLocalSandboxProvider({ platform, inspect: async () => false })

    expect(provider.id).toBe(providerId)
    expect(provider.capabilities.controls).toEqual({ filesystem: 'none', network: 'none', process: 'none', resources: 'none' })
  })

  it.each([
    ['linux', createLinuxSandboxProvider],
    ['darwin', createMacosSandboxProvider],
    ['win32', createWindowsSandboxProvider],
  ] as const)('forwards the audit callback through the %s factory', async (_platform, createFactory) => {
    const events: string[] = []
    const provider = await createFactory({
      inspect: async (argv) => _platform === 'win32' && (argv[1] === '--version' || argv[1] === 'self-test'),
      audit: (event) => { events.push(event.kind) },
    })
    const session = await provider.createSession({ policy: { ...dangerousPolicy, workspaceRoot: process.cwd() }, snapshots: [] })

    await session.execute({ argv: [process.execPath, '--eval', 'process.exit(0)'], cwd: process.cwd(), environment: {}, policy: { ...dangerousPolicy, workspaceRoot: process.cwd() } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toEqual(['execution-started', 'execution-completed'])
    await session.dispose()
  })

  it('emits validated danger-full-access audit events with provider and session IDs', async () => {
    const events: unknown[] = []
    const provider = createProvider(
      'audit-provider',
      { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      successfulRunner(),
      (event) => {
        events.push(validateSandboxAuditEvent(event))
      },
    )
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })

    await expect(session.execute({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })).resolves.toMatchObject({ status: 'ok' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toHaveLength(2)
    expect(events).toEqual([
      expect.objectContaining({ providerId: 'audit-provider', sessionId: 'audit-provider-1', mode: 'danger-full-access', kind: 'execution-started' }),
      expect.objectContaining({ providerId: 'audit-provider', sessionId: 'audit-provider-1', mode: 'danger-full-access', kind: 'execution-completed' }),
    ])
    await session.dispose()
  })

  it.each(['read-only', 'workspace-write'] as const)('does not emit audit events in %s mode', async (mode) => {
    const events: unknown[] = []
    const safePolicy = { ...policy, mode, workspaceRoot: process.cwd(), requiredCapabilities: { filesystem: 'full' as const } }
    const provider = createProvider(
      'safe-provider',
      { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      successfulRunner(),
      (event) => { events.push(event) },
    )
    const session = await provider.createSession({ policy: safePolicy, snapshots: [] })

    await expect(session.execute({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: safePolicy })).resolves.toMatchObject({ status: 'ok' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toEqual([])
    await session.dispose()
  })

  it('preserves the execution result when the audit callback throws', async () => {
    const provider = createProvider(
      'throwing-audit-provider',
      { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      successfulRunner(),
      () => { throw new Error('audit sink failed') },
    )
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })

    await expect(session.execute({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })).resolves.toMatchObject({
      status: 'ok',
      exitCode: 0,
    })
    await session.dispose()
  })

  it('returns typed unavailable without host fallback when the Windows broker is absent', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-windows-no-broker-'))
    const marker = join(fixture, 'spawned')
    const provider = await createLocalSandboxProvider({ platform: 'win32', inspect: async () => false })

    try {
      const session = await provider.createSession({ policy: { ...dangerousPolicy, workspaceRoot: fixture }, snapshots: [] })
      const result = await session.execute({
        argv: [process.execPath, '--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd: fixture,
        environment: {},
        policy: { ...dangerousPolicy, workspaceRoot: fixture },
      })

      expect(result.status).toBe('unavailable')
      expect(result.error?.code).toBe(SANDBOX_ERROR_CODES.unavailable)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('returns typed unavailable without spawning when the Windows broker is absent', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-windows-safe-no-broker-'))
    const marker = join(fixture, 'spawned')
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider(
      'local-windows',
      { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      undefined,
      injectedRunner(new InjectedChild(), calls),
    )

    try {
      expect(provider.discovery.windowsSandboxBroker).toBe(false)
      const safePolicy = { ...policy, workspaceRoot: fixture, requiredCapabilities: { filesystem: 'full' as const } }
      const session = await provider.createSession({
        policy: safePolicy,
        snapshots: [],
      })

      const result = await session.execute({
        argv: [process.execPath, '--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd: fixture,
        environment: {},
        policy: safePolicy,
      })

      expect(result.status).toBe('unavailable')
      expect(result.error?.code).toBe(SANDBOX_ERROR_CODES.unavailable)
      expect(calls).toEqual([])
      expect(existsSync(marker)).toBe(false)
      await session.dispose()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('does not infer functional bubblewrap from an executable inspection', async () => {
    let inspections = 0
    const provider = await createLocalSandboxProvider({
      platform: 'linux',
      inspect: async () => {
        inspections += 1
        return false
      },
    })

    await expect(provider.createSession({ policy, snapshots: [] })).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxCapabilityUnavailable })
    expect(inspections).toBe(process.platform === 'linux' ? 2 : 0)
  })

  it('returns unavailable without spawning after session disposal', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-disposed-sandbox-'))
    const marker = join(fixture, 'spawned')
    const provider = createProvider(
      'test-local',
      { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
    )
    const session = await provider.createSession({
      policy: { ...dangerousPolicy, workspaceRoot: fixture },
      snapshots: [],
    })

    try {
      await session.dispose()

      const result = await session.execute({
        argv: [process.execPath, '--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd: fixture,
        environment: {},
        policy: { ...dangerousPolicy, workspaceRoot: fixture },
      })

      expect(result.status).toBe('unavailable')
      expect(result.error?.code).toBe(SANDBOX_ERROR_CODES.unavailable)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a request policy for another workspace before executing its target', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-session-policy-'))
    const workspaceA = join(fixture, 'workspace-a')
    const workspaceB = join(fixture, 'workspace-b')
    const marker = join(workspaceB, 'spawned')
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)])
    const provider = createProvider(
      'test-local',
      { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
    )
    const session = await provider.createSession({
      policy: { ...dangerousPolicy, workspaceRoot: workspaceA },
      snapshots: [],
    })

    try {
      await expect(session.execute({
        argv: [process.execPath, '--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd: workspaceB,
        environment: {},
        policy: { ...dangerousPolicy, workspaceRoot: workspaceB },
      })).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxRequestInvalid })

      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('fails closed before spawning a safe-mode request without a wrapper', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-safe-without-wrapper-'))
    const marker = join(fixture, 'spawned')
    const provider = createProvider(
      'test-local',
      { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
    )

    try {
      const safePolicy = { ...policy, workspaceRoot: fixture, requiredCapabilities: { filesystem: 'full' as const } }
      const session = await provider.createSession({ policy: safePolicy, snapshots: [] })
      const result = await session.execute({
        argv: [process.execPath, '--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd: fixture,
        environment: {},
        policy: safePolicy,
      })

      expect(result.status).toBe('unavailable')
      expect(result.error?.code).toBe(SANDBOX_ERROR_CODES.unavailable)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('enforces the policy output limit instead of the provider default', async () => {
    const child = new InjectedChild()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      injectedRunner(child, calls),
    )
    const limitedPolicy = {
      ...policy,
      workspaceRoot: process.cwd(),
      requiredCapabilities: { filesystem: 'full' as const },
      resourceLimits: { outputBytes: 3 },
    }
    const session = await provider.createSession({ policy: limitedPolicy, snapshots: [] })
    const execution = session.execute({ argv: [process.execPath, '--eval', 'process.stdout.write("abcd")'], cwd: process.cwd(), environment: {}, policy: limitedPolicy })

    try {
      await waitForRunnerRegistrations(calls, 1)
      expect(calls[0]?.options).toEqual(expect.objectContaining({ shell: false }))
      child.stdout.emit('data', Buffer.from('abcd'))
      expect(child.killed).toBe(true)
      child.close()
      await expect(execution).resolves.toMatchObject({ status: 'failed', error: { code: SANDBOX_ERROR_CODES.runnerFailed } })
    } finally {
      await session.dispose()
    }
  })

  it('enforces the policy wall-time limit instead of the provider default', async () => {
    const child = new InjectedChild()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      injectedRunner(child, calls),
    )
    const limitedPolicy = {
      ...policy,
      workspaceRoot: process.cwd(),
      requiredCapabilities: { filesystem: 'full' as const },
      resourceLimits: { wallTimeMs: 10 },
    }
    const session = await provider.createSession({ policy: limitedPolicy, snapshots: [] })
    const execution = session.execute({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: limitedPolicy })

    try {
      await waitForRunnerRegistrations(calls, 1)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(child.killed).toBe(true)
      child.close()
      await expect(execution).resolves.toMatchObject({ status: 'timed-out', error: { code: SANDBOX_ERROR_CODES.timedOut } })
    } finally {
      await session.dispose()
    }
  })

  it.each(['memoryBytes', 'fileSizeBytes', 'processCount'] as const)('fails closed for unsupported safe resource limit %s', async (limit) => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      injectedRunner(new InjectedChild(), calls),
    )
    const safePolicy = {
      ...policy,
      workspaceRoot: process.cwd(),
      requiredCapabilities: { filesystem: 'full' as const },
      resourceLimits: { [limit]: 1 },
    }
    const session = await provider.createSession({ policy: safePolicy, snapshots: [] })

    try {
      await expect(session.execute({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: safePolicy })).resolves.toMatchObject({
        status: 'unavailable',
        error: { code: SANDBOX_ERROR_CODES.unavailable },
      })
      expect(calls).toEqual([])
    } finally {
      await session.dispose()
    }
  })

  it('does not spawn a pre-aborted safe-mode request', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-pre-aborted-sandbox-'))
    const marker = join(fixture, 'spawned')
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
    )
    const safePolicy = { ...policy, workspaceRoot: fixture, requiredCapabilities: { filesystem: 'full' as const } }
    const session = await provider.createSession({ policy: safePolicy, snapshots: [] })
    const controller = new AbortController()
    controller.abort()

    try {
      const result = await session.execute({
        argv: [process.execPath, '--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd: fixture,
        environment: {},
        policy: safePolicy,
        signal: controller.signal,
      })

      expect(result.status).toBe('aborted')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await session.dispose()
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('terminates active children and awaits their close before disposing a session', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-dispose-active-sandbox-'))
    const child = new InjectedChild()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      5_000,
      (request) => request.argv,
      injectedRunner(child, calls),
    )
    const sessionPolicy = { ...policy, workspaceRoot: fixture, requiredCapabilities: { filesystem: 'full' as const } }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const execution = session.execute({
      argv: [process.execPath, '--eval', 'process.stdout.write("running")'],
      cwd: fixture,
      environment: {},
      policy: sessionPolicy,
    })

    try {
      await waitForRunnerRegistrations(calls, 1)
      expect(calls).toEqual([{ command: process.execPath, args: ['--eval', 'process.stdout.write("running")'], options: expect.objectContaining({ shell: false }) }])
      const disposal = session.dispose()
      expect(child.killed).toBe(true)
      let settled = false
      void disposal.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      child.close()
      await disposal
      await expect(execution).resolves.toMatchObject({ status: 'aborted' })
    } finally {
      await session.dispose()
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('returns the same idempotent disposal promise for concurrent callers', async () => {
    const child = new InjectedChild()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider('test-local', { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false }, 'full', 1_000, (request) => request.argv, injectedRunner(child, calls))
    const sessionPolicy = { ...policy, workspaceRoot: process.cwd(), requiredCapabilities: { filesystem: 'full' as const } }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const execution = session.execute({ argv: [process.execPath, '--eval', 'process.exit(0)'], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    await waitForRunnerRegistrations(calls, 1)
    const first = session.dispose()
    const second = session.dispose()
    expect(second).toBe(first)
    child.close()
    await expect(first).resolves.toBeUndefined()
    await expect(execution).resolves.toMatchObject({ status: 'aborted' })
  })

  it('rejects disposal with a typed unavailable error when child cleanup is uncertain', async () => {
    const child = new InjectedChild()
    child.kill = (): boolean => { throw new Error('kill failed') }
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider('test-local', { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false }, 'full', 1_000, (request) => request.argv, injectedRunner(child, calls))
    const sessionPolicy = { ...policy, workspaceRoot: process.cwd(), requiredCapabilities: { filesystem: 'full' as const } }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const execution = session.execute({ argv: [process.execPath, '--eval', 'process.exit(0)'], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    await waitForRunnerRegistrations(calls, 1)

    const disposal = session.dispose()
    child.close()
    await expect(disposal).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxUnavailable })
    await expect(execution).resolves.toMatchObject({ status: 'aborted' })
    await expect(session.execute({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })).resolves.toMatchObject({ status: 'unavailable', error: { code: SANDBOX_ERROR_CODES.unavailable } })
  })

  it('attempts every active child and awaits every cleanup before rejecting disposal', async () => {
    const firstChild = new InjectedChild()
    const secondChild = new InjectedChild()
    let firstKillAttempts = 0
    firstChild.kill = (): boolean => { firstKillAttempts += 1; throw new Error('kill failed') }
    const children = [firstChild, secondChild]
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      (command, args, options) => {
        calls.push({ command, args: [...args], options: { ...options } })
        return children.shift() as unknown as ChildProcess
      },
    )
    const sessionPolicy = { ...policy, workspaceRoot: process.cwd(), requiredCapabilities: { filesystem: 'full' as const } }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const firstExecution = session.execute({ argv: [process.execPath, '--eval', 'process.exit(0)'], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    const secondExecution = session.execute({ argv: [process.execPath, '--eval', 'process.exit(0)'], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    await waitForRunnerRegistrations(calls, 2)

    const disposal = session.dispose()
    expect(firstKillAttempts).toBe(1)
    expect(secondChild.killed).toBe(true)
    let settled = false
    void disposal.finally(() => { settled = true }).catch(() => undefined)
    firstChild.close()
    await Promise.resolve()
    expect(settled).toBe(false)
    secondChild.close()

    await expect(disposal).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxUnavailable })
    await expect(firstExecution).resolves.toMatchObject({ status: 'aborted' })
    await expect(secondExecution).resolves.toMatchObject({ status: 'aborted' })
  })

  it('invalidates the session when active child cleanup rejects', async () => {
    const child = new InjectedChild()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider('test-local', { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false }, 'full', 1_000, (request) => request.argv, injectedRunner(child, calls))
    const sessionPolicy = { ...policy, workspaceRoot: process.cwd(), requiredCapabilities: { filesystem: 'full' as const } }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const execution = session.execute({ argv: [process.execPath, '--eval', 'process.exit(0)'], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    await waitForRunnerRegistrations(calls, 1)
    child.emit('error', new Error('cleanup failed'))

    await expect(execution).resolves.toMatchObject({ status: 'failed', error: { code: SANDBOX_ERROR_CODES.runnerFailed } })
    await expect(session.execute({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })).resolves.toMatchObject({ status: 'unavailable', error: { code: SANDBOX_ERROR_CODES.unavailable } })
    expect(calls).toHaveLength(1)
    await expect(session.dispose()).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxUnavailable })
  })

  it('bounds disposal when termination returns false and the child never closes', async () => {
    const child = new InjectedChild()
    child.kill = (): boolean => false
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider('test-local', { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false }, 'full', 10, (request) => request.argv, injectedRunner(child, calls))
    const sessionPolicy = { ...policy, workspaceRoot: process.cwd(), requiredCapabilities: { filesystem: 'full' as const } }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const execution = session.execute({ argv: [process.execPath, '--eval', 'process.exit(0)'], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    await waitForRunnerRegistrations(calls, 1)

    const disposal = session.dispose()
    try {
      await expect(Promise.race([
        execution,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('execute remained pending')), 100)),
      ])).resolves.toMatchObject({ status: 'aborted', error: { code: SANDBOX_ERROR_CODES.aborted } })
      await expect(disposal).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxUnavailable })
      await expect(session.execute({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })).resolves.toMatchObject({ status: 'unavailable', error: { code: SANDBOX_ERROR_CODES.unavailable } })
    } finally {
      await disposal.catch(() => undefined)
    }
  })

  it('settles execute within the cleanup timeout when termination is accepted but the child never closes', async () => {
    const child = new InjectedChild()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const timeoutMs = 10
    const provider = createProvider('test-local', { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false }, 'full', timeoutMs, (request) => request.argv, injectedRunner(child, calls))
    const sessionPolicy = { ...policy, workspaceRoot: process.cwd(), requiredCapabilities: { filesystem: 'full' as const } }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const execution = session.execute({ argv: [process.execPath, '--eval', 'process.exit(0)'], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    await waitForRunnerRegistrations(calls, 1)

    const disposal = session.dispose()
    try {
      expect(calls).toEqual([{ command: process.execPath, args: ['--eval', 'process.exit(0)'], options: expect.objectContaining({ shell: false }) }])
      expect(session.dispose()).toBe(disposal)
      await expect(Promise.race([
        execution,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('execute remained pending')), timeoutMs * 2)),
      ])).resolves.toMatchObject({ status: 'aborted', error: { code: SANDBOX_ERROR_CODES.aborted } })
      await expect(Promise.race([
        disposal,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('disposal remained pending')), timeoutMs * 2)),
      ])).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxUnavailable })
      await expect(session.execute({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })).resolves.toMatchObject({ status: 'unavailable', error: { code: SANDBOX_ERROR_CODES.unavailable } })
    } finally {
      await disposal.catch(() => undefined)
    }
  })

  it('disposes an open stdio child and awaits its close', async () => {
    const child = new InjectedStdioChild()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      injectedRunner(child, calls),
    )
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })

    try {
      await session.openStdio!({ argv: [process.execPath, '--eval', 'process.stdin.resume()'], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
      expect(calls).toEqual([{ command: process.execPath, args: ['--eval', 'process.stdin.resume()'], options: expect.objectContaining({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) }])

      const disposal = session.dispose()
      expect(child.killed).toBe(true)
      let settled = false
      void disposal.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)

      child.close()
      await disposal
    } finally {
      await session.dispose().catch(() => undefined)
    }
  })

  it('rejects an aborted stdio send with the typed sandbox abort error', async () => {
    const child = new InjectedStdioChild()
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      injectedRunner(child, []),
    )
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const channel = await session.openStdio!({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    const controller = new AbortController()
    controller.abort()

    try {
      await expect(channel.sendFrame('hello', controller.signal)).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.aborted })
      expect(child.writes).toEqual([])
    } finally {
      const closing = channel.close()
      child.close()
      await closing
      await session.dispose()
    }
  })

  it('rejects an in-flight backpressured stdio send on abort without leaking its drain waiter', async () => {
    const child = new InjectedStdioChild()
    child.blockWrites = true
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      injectedRunner(child, []),
    )
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const channel = await session.openStdio!({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    const controller = new AbortController()
    const send = channel.sendFrame('hello', controller.signal)
    controller.abort()

    try {
      await expect(send).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.aborted })
      expect(child.writes).toEqual(['hello\n'])
    } finally {
      const closing = channel.close()
      child.close()
      await closing
      await session.dispose()
    }
  })

  it('rejects an aborted stdio receive and leaves the frame for the next waiter', async () => {
    const child = new InjectedStdioChild()
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      injectedRunner(child, []),
    )
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const channel = await session.openStdio!({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    const controller = new AbortController()
    const receive = channel.receiveFrame(controller.signal)
    controller.abort()

    try {
      await expect(receive).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.aborted })
      child.stdout.emit('data', 'late frame\n')
      await expect(Promise.race([
        channel.receiveFrame(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('receive remained pending')), 100)),
      ])).resolves.toBe('late frame')
    } finally {
      const closing = channel.close()
      child.close()
      await closing
      await session.dispose()
    }
  })

  it('removes a closed stdio channel from session ownership', async () => {
    const child = new InjectedStdioChild()
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      injectedRunner(child, []),
    )
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const channel = await session.openStdio!({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })

    const closing = channel.close()
    expect(child.killAttempts).toBe(1)
    child.close()
    await closing
    await session.dispose()

    expect(child.killAttempts).toBe(1)
  })

  it('rejects a pending stdio receive when the child closes with a typed unavailable error', async () => {
    const child = new InjectedStdioChild()
    const provider = createProvider(
      'test-local',
      { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
      (request) => request.argv,
      injectedRunner(child, []),
    )
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const channel = await session.openStdio!({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    const receive = channel.receiveFrame()
    child.close()

    try {
      await expect(receive).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.unavailable })
      await expect(channel.receiveFrame()).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.unavailable })
      await expect(channel.sendFrame('late')).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.unavailable })
    } finally {
      await channel.close()
      await session.dispose()
    }
  })

  it('settles a pending stdio send and normalizes child error cleanup', async () => {
    const child = new InjectedStdioChild()
    child.blockWrites = true
    const provider = createProvider('test-local', { bubblewrap: true, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false }, 'full', 1_000, (request) => request.argv, injectedRunner(child, []))
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: process.cwd() }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    const channel = await session.openStdio!({ argv: [process.execPath], cwd: process.cwd(), environment: {}, policy: sessionPolicy })
    const send = channel.sendFrame('hello')
    child.emit('error', new Error('transport lost'))

    await expect(send).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.unavailable })
    await expect(channel.close()).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxUnavailable })
    await expect(session.dispose()).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxUnavailable })
  })

  it('validates and retains session snapshots instead of silently discarding them', async () => {
    const provider = createProvider(
      'test-local',
      { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false },
      'full',
      1_000,
    )

    await expect(provider.createSession({
      policy: { ...dangerousPolicy, workspaceRoot: '/workspace' },
      snapshots: [{ version: 1, path: '../escape', kind: 'file', digest: 'sha256:escape' }],
    })).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxSnapshotInvalid })
  })
})

  it('constructs a shell-free bubblewrap command with a read-only workspace bind', async () => {
    const { buildBubblewrapArgv } = await import('../src/linux.ts')

    expect(buildBubblewrapArgv({
      argv: ['/usr/bin/node', '--eval', 'process.stdout.write("ok")'],
      cwd: '/workspace/nested',
      environment: { SAFE: 'yes', API_TOKEN: 'must-not-leak' },
      policy: { ...policy, workspaceRoot: '/workspace' },
    })).toEqual([
      'bwrap', '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-net', '--clearenv',
      '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev',
      '--dir', '/tmp', '--tmpfs', '/tmp',
      '--dir', '/usr', '--ro-bind', '/usr', '/usr', '--dir', '/bin', '--ro-bind', '/bin', '/bin',
      '--dir', '/lib', '--ro-bind', '/lib', '/lib', '--dir', '/lib64', '--ro-bind', '/lib64', '/lib64',
      '--dir', '/etc', '--ro-bind', '/etc', '/etc', '--dir', '/workspace', '--ro-bind', '/workspace', '/workspace',
      '--dir', '/workspace/nested', '--chdir', '/workspace/nested', '--setenv', 'SAFE', 'yes',
      '--', '/usr/bin/node', '--eval', 'process.stdout.write("ok")',
    ])
  })

  it('constructs a writable workspace bind only for workspace-write mode', async () => {
    const { buildBubblewrapArgv } = await import('../src/linux.ts')
    const argv = buildBubblewrapArgv({
      argv: ['/bin/true'],
      cwd: '/workspace',
      environment: {},
      policy: { ...policy, mode: 'workspace-write' },
    })

    const workspaceBind = argv.indexOf('--bind')
    expect(argv.slice(workspaceBind, workspaceBind + 3)).toEqual(['--bind', '/workspace', '/workspace'])
  })

  it('creates and restores provider-owned file snapshots', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-snapshot-'))
    const file = join(fixture, 'state.txt')
    const outside = join(fixture, 'outside-snapshot.txt')
    const link = join(fixture, 'linked.txt')
    const provider = createProvider('snapshot-local', { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker: false, jobObjectHelper: false }, 'full', 1_000)
    await writeFile(file, 'before', 'utf8')
    await writeFile(outside, 'outside', 'utf8')
    await symlink(outside, link, process.platform === 'win32' ? 'file' : 'file')
    const sessionPolicy = { ...dangerousPolicy, workspaceRoot: fixture }
    const session = await provider.createSession({ policy: sessionPolicy, snapshots: [] })
    try {
      const [snapshot] = await session.snapshot!(['state.txt'])
      await writeFile(file, 'changed', 'utf8')
      await session.restore!([snapshot!])
      await expect(readFile(file, 'utf8')).resolves.toBe('before')
      await expect(session.restore!([{ ...snapshot!, digest: 'unknown-digest' }])).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.unavailable })
      await expect(session.restore!([{ ...snapshot!, kind: 'directory' }])).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.unavailable })
      await expect(session.snapshot!(['linked.txt'])).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.unavailable })
    } finally {
      await session.dispose()
      await rm(fixture, { recursive: true, force: true })
    }
  })
