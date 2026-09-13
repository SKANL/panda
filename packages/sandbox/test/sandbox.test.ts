import { describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@skanl/panda-contracts'
import { createSandboxProviderResolver } from '../src/index.ts'
import type {
  SandboxCapabilityFacts,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxProvider,
  SandboxSession,
  SandboxSessionRequest,
} from '@skanl/panda-contracts'

const policy = {
  version: 1 as const,
  mode: 'read-only' as const,
  workspaceRoot: '/workspace',
  requiredCapabilities: { filesystem: 'full' as const, network: 'full' as const },
}

const request = {
  argv: ['git', 'status'] as [string, ...string[]],
  cwd: '/workspace',
  environment: { LANG: 'C' },
  policy,
}

function facts(id: string, controls: Partial<SandboxCapabilityFacts['controls']> = {}): SandboxCapabilityFacts {
  return {
    version: 1,
    providerId: id,
    enforcement: 'os',
    controls: { filesystem: 'full', network: 'full', process: 'full', resources: 'full', ...controls },
  }
}

class FakeProvider implements SandboxProvider {
  readonly calls: { sessions: SandboxSessionRequest[]; executions: SandboxExecutionRequest[]; stdio: SandboxExecutionRequest[]; disposals: number[] } = {
    sessions: [],
    executions: [],
    stdio: [],
    disposals: [],
  }

  constructor(readonly id: string, readonly capabilities: SandboxCapabilityFacts, private readonly disposeFailure?: Error) {}

  async createSession(value: SandboxSessionRequest): Promise<SandboxSession> {
    this.calls.sessions.push(value)
    const calls = this.calls
    const disposeFailure = this.disposeFailure
    const providerId = this.id
    return {
      id: `${this.id}-session`,
      async execute(execution: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
        calls.executions.push(execution)
        return { status: 'ok', stdout: '', stderr: '', exitCode: 0, enforcement: facts(providerId) }
      },
      async openStdio(execution: SandboxExecutionRequest) {
        calls.stdio.push(execution)
        return { sendFrame: async () => {}, receiveFrame: async () => 'frame', close: async () => {} }
      },
      async dispose(): Promise<void> {
        calls.disposals.push(Date.now())
        if (disposeFailure) throw disposeFailure
      },
    }
  }
}

function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  return expect(action()).rejects.toMatchObject({ code })
}

describe('@skanl/panda-sandbox', () => {
  it('selects the first provider that proves every requested control', async () => {
    const partial = new FakeProvider('partial', facts('partial', { network: 'partial' }))
    const full = new FakeProvider('full', facts('full'))
    const resolver = createSandboxProviderResolver([partial, full])

    expect(resolver.select(policy)).toBe(full)
    const session = await resolver.createSession({ policy, snapshots: [] })
    expect(session.providerId).toBe('full')
    expect(partial.calls.sessions).toEqual([])
    await session.dispose()
  })

  it('rejects unavailable and partially evidenced controls without falling back to a downgrade', async () => {
    const partial = new FakeProvider('partial', facts('partial', { network: 'partial' }))
    const resolver = createSandboxProviderResolver([partial])

    expect(() => resolver.select(policy)).toThrowError(expect.objectContaining({ code: PANDA_ERROR_CODES.sandboxCapabilityUnavailable }))
    await expectCode(() => resolver.createSession({ policy, snapshots: [] }), PANDA_ERROR_CODES.sandboxCapabilityUnavailable)
    expect(() => createSandboxProviderResolver([]).select(policy)).toThrowError(
      expect.objectContaining({ code: PANDA_ERROR_CODES.sandboxUnavailable }),
    )
  })

  it('forwards the validated session and execution requests without adding, removing, or changing fields', async () => {
    const provider = new FakeProvider('full', facts('full'))
    const resolver = createSandboxProviderResolver([provider])
    const sessionRequest = { policy, snapshots: [{ version: 1 as const, path: 'src', kind: 'directory' as const, digest: 'sha256:src' }] }
    const session = await resolver.createSession(sessionRequest)

    await session.execute(request)
    expect(provider.calls.sessions).toEqual([sessionRequest])
    expect(provider.calls.executions).toEqual([request])
    await session.dispose()
  })

  it('validates and policy-checks stdio before forwarding the exact request', async () => {
    const provider = new FakeProvider('full', facts('full'))
    const session = await createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] })

    await session.openStdio!(request)
    expect(provider.calls.stdio).toEqual([request])
    await expectCode(() => session.openStdio!({ ...request, argv: [] as unknown as [string, ...string[]] }), PANDA_ERROR_CODES.sandboxRequestInvalid)
    await expectCode(() => session.openStdio!({ ...request, policy: { ...policy, workspaceRoot: '/other' } }), PANDA_ERROR_CODES.sandboxRequestInvalid)
    expect(provider.calls.stdio).toHaveLength(1)
    await session.dispose()
  })

  it('makes teardown idempotent and refuses reuse after teardown begins', async () => {
    const provider = new FakeProvider('full', facts('full'))
    const session = await createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] })

    await Promise.all([session.dispose(), session.dispose()])
    expect(provider.calls.disposals).toHaveLength(1)
    await expectCode(() => session.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)
  })

  it('treats a failed teardown as uncertain and permanently refuses reuse', async () => {
    const provider = new FakeProvider('full', facts('full'), new Error('transport lost'))
    const session = await createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] })

    await expectCode(() => session.dispose(), PANDA_ERROR_CODES.sandboxUnavailable)
    await expectCode(() => session.dispose(), PANDA_ERROR_CODES.sandboxUnavailable)
    expect(provider.calls.disposals).toHaveLength(1)
    await expectCode(() => session.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)
  })

  it('rejects execution evidence from a provider other than the selected provider and invalidates the session', async () => {
    const provider: SandboxProvider = {
      id: 'full',
      capabilities: facts('full'),
      async createSession(): Promise<SandboxSession> {
        return {
          id: 'full-session',
          async execute(): Promise<SandboxExecutionResult> {
            return { status: 'ok', stdout: '', stderr: '', exitCode: 0, enforcement: facts('different-provider') }
          },
          async dispose(): Promise<void> {},
        }
      },
    }
    const session = await createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] })

    await expectCode(() => session.execute(request), PANDA_ERROR_CODES.sandboxResponseInvalid)
    await expectCode(() => session.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)
  })

  it('invalidates after malformed or under-enforced execution results', async () => {
    const malformed: SandboxProvider = {
      id: 'malformed',
      capabilities: facts('malformed'),
      async createSession(): Promise<SandboxSession> {
        return {
          id: 'malformed-session',
          async execute(): Promise<SandboxExecutionResult> {
            return { status: 'ok' } as SandboxExecutionResult
          },
          async dispose(): Promise<void> {},
        }
      },
    }
    const underEnforced: SandboxProvider = {
      id: 'under-enforced',
      capabilities: facts('under-enforced'),
      async createSession(): Promise<SandboxSession> {
        return {
          id: 'under-enforced-session',
          async execute(): Promise<SandboxExecutionResult> {
            return { status: 'ok', stdout: '', stderr: '', exitCode: 0, enforcement: facts('under-enforced', { network: 'none' }) }
          },
          async dispose(): Promise<void> {},
        }
      },
    }

    const malformedSession = await createSandboxProviderResolver([malformed]).createSession({ policy, snapshots: [] })
    await expectCode(() => malformedSession.execute(request), PANDA_ERROR_CODES.sandboxResponseInvalid)
    await expectCode(() => malformedSession.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)

    const underEnforcedSession = await createSandboxProviderResolver([underEnforced]).createSession({ policy, snapshots: [] })
    await expectCode(() => underEnforcedSession.execute(request), PANDA_ERROR_CODES.sandboxCapabilityUnavailable)
    await expectCode(() => underEnforcedSession.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)
  })

  it('normalizes provider execution failures without invalidating locally rejected requests', async () => {
    let executions = 0
    const provider: SandboxProvider = {
      id: 'full',
      capabilities: facts('full'),
      async createSession(): Promise<SandboxSession> {
        return {
          id: 'full-session',
          async execute(): Promise<SandboxExecutionResult> {
            executions += 1
            throw new PandaError(PANDA_ERROR_CODES.executorRunFailed, 'provider error')
          },
          async dispose(): Promise<void> {},
        }
      },
    }
    const session = await createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] })

    await expectCode(() => session.execute({ ...request, argv: [] as unknown as [string, ...string[]] }), PANDA_ERROR_CODES.sandboxRequestInvalid)
    expect(executions).toBe(0)
    await expectCode(() => session.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)
    await expectCode(() => session.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)

    const createFailure: SandboxProvider = {
      id: 'create-failure',
      capabilities: facts('create-failure'),
      async createSession(): Promise<SandboxSession> {
        throw new PandaError(PANDA_ERROR_CODES.executorRunFailed, 'provider error')
      },
    }
    await expectCode(() => createSandboxProviderResolver([createFailure]).createSession({ policy, snapshots: [] }), PANDA_ERROR_CODES.sandboxUnavailable)
  })

  it('attributes a created session to the provider identity selected before creation mutates it', async () => {
    const provider: SandboxProvider & { id: string } = {
      id: 'selected-provider',
      capabilities: facts('selected-provider'),
      async createSession(): Promise<SandboxSession> {
        this.id = 'mutated-provider'
        return {
          id: 'session',
          async execute(): Promise<SandboxExecutionResult> {
            return { status: 'ok', stdout: '', stderr: '', exitCode: 0, enforcement: facts('selected-provider') }
          },
          async dispose(): Promise<void> {},
        }
      },
    }

    const session = await createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] })

    expect(session.providerId).toBe('selected-provider')
    await session.dispose()
  })

  it('uses the provider identity captured during selection after the provider id getter becomes hostile', async () => {
    let idReads = 0
    const provider: SandboxProvider = {
      get id(): string {
        idReads += 1
        if (idReads > 1) throw new Error('provider id was re-read')
        return 'selected-provider'
      },
      capabilities: facts('selected-provider'),
      async createSession(): Promise<SandboxSession> {
        return {
          id: 'session',
          async execute(): Promise<SandboxExecutionResult> {
            return { status: 'ok', stdout: '', stderr: '', exitCode: 0, enforcement: facts('selected-provider') }
          },
          async dispose(): Promise<void> {},
        }
      },
    }

    const session = await createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] })

    expect(session.providerId).toBe('selected-provider')
    await expect(session.execute(request)).resolves.toMatchObject({ status: 'ok' })
    expect(idReads).toBe(1)
    await session.dispose()
  })

  it('uses captured capabilities when selection falls back to a canonical capability rejection', async () => {
    let capabilityReads = 0
    const provider: SandboxProvider = {
      id: 'partial',
      get capabilities(): SandboxCapabilityFacts {
        capabilityReads += 1
        if (capabilityReads > 1) throw new Error('provider capabilities were re-read')
        return facts('partial', { network: 'partial' })
      },
      async createSession(): Promise<SandboxSession> {
        throw new Error('must not create a session')
      },
    }

    await expectCode(() => createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] }), PANDA_ERROR_CODES.sandboxCapabilityUnavailable)
    expect(capabilityReads).toBe(1)
  })

  it.each([
    new PandaError(PANDA_ERROR_CODES.executorRunFailed, 'provider PandaError'),
    new Error('provider Error'),
  ])('normalizes a hostile provider execution-result getter that throws %s', async (getterError) => {
    const provider: SandboxProvider = {
      id: 'full',
      capabilities: facts('full'),
      async createSession(): Promise<SandboxSession> {
        return {
          id: 'full-session',
          async execute(): Promise<SandboxExecutionResult> {
            const result = { status: 'ok', stderr: '', enforcement: facts('full') }
            Object.defineProperty(result, 'stdout', {
              get(): never {
                throw getterError
              },
            })
            return result as SandboxExecutionResult
          },
          async dispose(): Promise<void> {},
        }
      },
    }
    const session = await createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] })

    await expectCode(() => session.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)
    await expectCode(() => session.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)
  })

  it.each(['id', 'execute', 'dispose'] as const)('normalizes a provider session %s getter failure during creation', async (property) => {
    const provider: SandboxProvider = {
      id: 'full',
      capabilities: facts('full'),
      async createSession(): Promise<SandboxSession> {
        const session = {
          id: 'session',
          async execute(): Promise<SandboxExecutionResult> {
            return { status: 'ok', stdout: '', stderr: '', exitCode: 0, enforcement: facts('full') }
          },
          async dispose(): Promise<void> {},
        }
        Object.defineProperty(session, property, {
          get(): never {
            throw new Error('provider getter failed')
          },
        })
        return session as SandboxSession
      },
    }

    await expectCode(() => createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] }), PANDA_ERROR_CODES.sandboxUnavailable)
  })

  it('turns a synchronous provider disposal failure into one reusable unavailable rejection', async () => {
    let disposals = 0
    const provider: SandboxProvider = {
      id: 'full',
      capabilities: facts('full'),
      async createSession(): Promise<SandboxSession> {
        return {
          id: 'full-session',
          async execute(): Promise<SandboxExecutionResult> {
            return { status: 'ok', stdout: '', stderr: '', exitCode: 0, enforcement: facts('full') }
          },
          dispose(): Promise<void> {
            disposals += 1
            throw new Error('transport lost')
          },
        }
      },
    }
    const session = await createSandboxProviderResolver([provider]).createSession({ policy, snapshots: [] })

    const first = session.dispose()
    const second = session.dispose()
    expect(second).toBe(first)
    await expectCode(() => first, PANDA_ERROR_CODES.sandboxUnavailable)
    await expectCode(() => second, PANDA_ERROR_CODES.sandboxUnavailable)
    expect(disposals).toBe(1)
    await expectCode(() => session.execute(request), PANDA_ERROR_CODES.sandboxUnavailable)
  })
})

