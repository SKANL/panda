import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, SANDBOX_ERROR_CODES } from '@skanl/panda-contracts'
import type { SandboxPolicy } from '@skanl/panda-contracts'
import { createRemoteSandboxProvider } from '../src/index.ts'
import type { RemoteSandboxTransport } from '../src/index.ts'

const policy = Object.freeze({
  version: 1 as const,
  mode: 'workspace-write' as const,
  workspaceRoot: '/workspace',
  requiredCapabilities: Object.freeze({ filesystem: 'full' as const, network: 'partial' as const }),
})
const capabilities = Object.freeze({
  version: 1 as const,
  providerId: 'remote-test',
  enforcement: 'remote' as const,
  controls: Object.freeze({ filesystem: 'full' as const, network: 'partial' as const, process: 'none' as const, resources: 'none' as const }),
})

function matchingSession(session: { readonly id: string; readonly providerId: string; readonly policy: SandboxPolicy }) {
  return { id: session.id, providerId: session.providerId, policy: session.policy }
}

function matchingResult() {
  return { status: 'ok' as const, stdout: 'ok', stderr: '', exitCode: 0, enforcement: capabilities }
}

function transport(overrides: Partial<RemoteSandboxTransport> = {}): RemoteSandboxTransport {
  return {
    createSession: async (request) => ({ session: matchingSession(request.session), capabilities }),
    execute: async (request) => ({ session: matchingSession(request.session), result: matchingResult() }),
    destroy: async () => undefined,
    ...overrides,
  }
}

function settlesWithin<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`execution did not settle within ${timeoutMs}ms`)), timeoutMs)
    void promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('@skanl/panda-sandbox-remote', () => {
  it('imports its TypeScript source with Node panda-source conditions', () => {
    const source = new URL('../src/index.ts', import.meta.url)

    expect(() => execFileSync(process.execPath, [
      '--conditions=panda-source',
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(source.href)})`,
    ], { encoding: 'utf8' })).not.toThrow()
  })

  it('forwards immutable session identity, policy, and exact argv to its injected transport', async () => {
    const calls: unknown[] = []
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, transport: transport({
      createSession: async (request) => { calls.push(request); return { session: matchingSession(request.session), capabilities } },
      execute: async (request) => { calls.push(request); return { session: matchingSession(request.session), result: matchingResult() } },
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })
    const argv = ['node', '--eval', 'process.exit(0)'] as const
    await session.execute({ argv, cwd: '/workspace', environment: { SAFE: '1' }, policy })

    expect(calls).toEqual([
      { session: { id: 'session-1', providerId: 'remote-test', policy, snapshots: [] }, signal: undefined },
      { session: { id: 'session-1', providerId: 'remote-test', policy }, argv, cwd: '/workspace', environment: { SAFE: '1' }, snapshots: undefined, signal: expect.any(AbortSignal) },
    ])
    expect(Object.isFrozen((calls[0] as { session: object }).session)).toBe(true)
    expect(Object.isFrozen((calls[1] as { argv: object }).argv)).toBe(true)
  })

  it('rejects unsupported remote capability evidence before using a session', async () => {
    const weak = { ...capabilities, controls: { ...capabilities.controls, network: 'none' as const } }
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, transport: transport({
      createSession: async (request) => ({ session: matchingSession(request.session), capabilities: weak }),
    }), createSessionId: () => 'session-1' })

    await expect(provider.createSession({ policy, snapshots: [] })).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxCapabilityUnavailable })
  })

  it('rejects remote enforcement evidence for another provider identity', async () => {
    const other = { ...capabilities, providerId: 'other-provider' }
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, transport: transport({
      execute: async (request) => ({ session: matchingSession(request.session), result: { ...matchingResult(), enforcement: other } }),
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })

    await expect(session.execute({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy })).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxResponseInvalid })
  })

  it('fails closed when the remote response is malformed', async () => {
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, transport: transport({
      execute: async () => ({ broken: true }),
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })

    await expect(session.execute({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy })).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxResponseInvalid })
  })

  it('fails closed when the injected transport is unavailable', async () => {
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, transport: transport({
      execute: async () => { throw new Error('network unavailable') },
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })

    await expect(session.execute({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy })).rejects.toMatchObject({ code: PANDA_ERROR_CODES.sandboxUnavailable })
  })

  it('returns a typed timeout when an injected transport ignores its timeout signal and never settles', async () => {
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, timeoutMs: 5, transport: transport({
      execute: async () => new Promise<never>(() => undefined),
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })

    await expect(settlesWithin(session.execute({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy }))).resolves.toMatchObject({
      status: 'timed-out',
      error: { code: SANDBOX_ERROR_CODES.timedOut },
    })
  })

  it('returns a typed aborted result when an injected transport ignores caller cancellation and never settles', async () => {
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, transport: transport({
      execute: async () => new Promise<never>(() => undefined),
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })
    const controller = new AbortController()
    const execution = session.execute({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy, signal: controller.signal })
    controller.abort('cancelled')

    await expect(settlesWithin(execution)).resolves.toMatchObject({
      status: 'aborted',
      error: { code: SANDBOX_ERROR_CODES.aborted },
    })
  })

  it('does not invoke remote stdio transport for a pre-aborted request', async () => {
    let openCalls = 0
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, transport: transport({
      openStdio: async () => {
        openCalls += 1
        throw new Error('transport should not be invoked')
      },
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })
    const controller = new AbortController()
    controller.abort('cancelled')

    await expect(session.openStdio!({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy, signal: controller.signal })).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.aborted,
    })
    expect(openCalls).toBe(0)
  })

  it.each(['\n', '\r'])('rejects stdio frames containing %j before transport dispatch', async (lineBreak) => {
    let sendCalls = 0
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, transport: transport({
      openStdio: async (request) => ({
        session: matchingSession(request.session),
        stdio: {
          sendFrame: async () => { sendCalls += 1 },
          receiveFrame: async () => 'response',
          close: async () => undefined,
        },
      }),
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })
    const stdio = await session.openStdio!({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy })

    await expect(stdio.sendFrame(`frame${lineBreak}injection`)).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.sandboxRequestInvalid,
    })
    expect(sendCalls).toBe(0)
  })

  it('preserves a typed timeout and closes a channel that opens after the watchdog wins', async () => {
    const opening = deferred<unknown>()
    const transportStarted = deferred<void>()
    const closeCompleted = deferred<void>()
    let closeCalls = 0
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, timeoutMs: 5, transport: transport({
      openStdio: async () => {
        transportStarted.resolve()
        return opening.promise
      },
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })
    const request = session.openStdio!({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy })
    await transportStarted.promise

    await expect(settlesWithin(request)).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.timedOut })
    opening.resolve({
      session: { id: 'session-1', providerId: 'remote-test', policy },
      stdio: {
        sendFrame: async () => undefined,
        receiveFrame: async () => 'response',
        close: async () => { closeCalls += 1; closeCompleted.resolve() },
      },
    })

    await settlesWithin(closeCompleted.promise)
    expect(closeCalls).toBe(1)
  })

  it('preserves a typed abort and closes a channel that opens after caller cancellation', async () => {
    const opening = deferred<unknown>()
    const transportStarted = deferred<void>()
    const closeCompleted = deferred<void>()
    let closeCalls = 0
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, transport: transport({
      openStdio: async () => {
        transportStarted.resolve()
        return opening.promise
      },
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })
    const controller = new AbortController()
    const request = session.openStdio!({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy, signal: controller.signal })
    await transportStarted.promise
    controller.abort('cancelled')

    await expect(settlesWithin(request)).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.aborted })
    opening.resolve({
      session: { id: 'session-1', providerId: 'remote-test', policy },
      stdio: {
        sendFrame: async () => undefined,
        receiveFrame: async () => 'response',
        close: async () => { closeCalls += 1; closeCompleted.resolve() },
      },
    })

    await settlesWithin(closeCompleted.promise)
    expect(closeCalls).toBe(1)
  })

  it('propagates cancellation and timeout and destroys a session once', async () => {
    let destroyCalls = 0
    const signals: AbortSignal[] = []
    const provider = createRemoteSandboxProvider({ id: 'remote-test', capabilities, timeoutMs: 5, transport: transport({
      execute: async (request) => {
        signals.push(request.signal)
        if (!request.signal.aborted) await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
        const timedOut = request.signal.reason instanceof Error
        return {
          session: matchingSession(request.session),
          result: timedOut
            ? { status: 'timed-out' as const, stdout: '', stderr: '', enforcement: capabilities, error: { code: SANDBOX_ERROR_CODES.timedOut, message: 'timed out' } }
            : { status: 'aborted' as const, stdout: '', stderr: '', enforcement: capabilities, error: { code: SANDBOX_ERROR_CODES.aborted, message: 'aborted' } },
        }
      },
      destroy: async () => { destroyCalls += 1 },
    }), createSessionId: () => 'session-1' })
    const session = await provider.createSession({ policy, snapshots: [] })
    const controller = new AbortController()
    controller.abort('cancel')
    const cancelled = await session.execute({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy, signal: controller.signal })
    const timedOut = await session.execute({ argv: ['node'] as const, cwd: '/workspace', environment: {}, policy })
    await Promise.all([session.dispose(), session.dispose()])

    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(cancelled.status).toBe('aborted')
    expect(timedOut.status).toBe('timed-out')
    expect(destroyCalls).toBe(1)
  })
})



