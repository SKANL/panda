import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PandaError, PANDA_ERROR_CODES } from '@panda/contracts'
import type { ExecutorAdapter, ResultEnvelope, RunRequest, WorkspaceHandle, WorkspaceProvider } from '@panda/contracts'
import { createMemoryLogSink, KERNEL_ERROR_CODES, PandaKernelError } from '@panda/kernel'
import { LocalWorkspaceProvider } from '@panda/workspace-local'
import { runSession, SESSION_ACTION_ID, type SessionOptions } from '../src'

// The suite composes sessions exactly as a third party would: `runSession` plus
// the seams, never `@panda/cli`. `test/guard.test.ts` pins that it stays that way.

function ok(summary = 'listed files'): ResultEnvelope {
  return { status: 'ok', data: { result: 'a.txt' }, summary, errors: [] }
}

function cancelledEnvelope(): ResultEnvelope {
  return {
    status: 'cancelled',
    data: null,
    summary: 'execution cancelled before completion',
    errors: [{ message: 'the run was cancelled and its process tree terminated' }],
  }
}

interface RecordingAdapter extends ExecutorAdapter {
  readonly requests: RunRequest[]
}

function recordingAdapter(respond: (request: RunRequest) => Promise<ResultEnvelope>): RecordingAdapter {
  const requests: RunRequest[] = []
  return {
    requests,
    run(request) {
      requests.push(request)
      return respond(request)
    },
  }
}

interface RecordingProvider extends WorkspaceProvider {
  readonly calls: string[]
}

function recordingProvider(overrides: Partial<WorkspaceProvider> = {}): RecordingProvider {
  const calls: string[] = []
  const handle: WorkspaceHandle = {
    id: 'w',
    rootPath: join(tmpdir(), 'panda-session-fake'),
    capabilities: ['read', 'write'],
  }
  return {
    calls,
    create:
      overrides.create ??
      (async () => {
        calls.push('create')
        return handle
      }),
    acquire: overrides.acquire ?? (async () => handle),
    release:
      overrides.release ??
      (async () => {
        calls.push('release')
      }),
    dispose:
      overrides.dispose ??
      (async () => {
        calls.push('dispose')
      }),
  }
}

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'panda-session-'))
}

describe('runSession', () => {
  it('composes the default workspace provider under the given cwd and returns the envelope', async () => {
    const cwd = await tempCwd()
    const adapter = recordingAdapter(async () => ok())
    const envelope = await runSession({ prompt: 'list files', cwd, createAdapter: () => adapter })

    expect(envelope).toMatchObject({ status: 'ok', summary: 'listed files' })
    const request = adapter.requests[0]
    expect(request?.prompt).toBe('list files')
    // The SDK caller never names a directory: it gets the same isolated workspace
    // `panda run` gets, which is what makes "no code copied from the CLI" true.
    expect(request?.workspace.rootPath.startsWith(join(cwd, '.panda', 'workspaces') + sep)).toBe(true)
    expect(request?.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns failed and cancelled envelopes verbatim rather than throwing', async () => {
    const failed: ResultEnvelope = { status: 'failed', data: null, summary: 'task failed', errors: [{ message: 'boom' }] }
    for (const envelope of [failed, cancelledEnvelope()]) {
      const provider = recordingProvider()
      await expect(
        runSession({
          prompt: 'p',
          createProvider: () => provider,
          createAdapter: () => recordingAdapter(async () => envelope),
        }),
      ).resolves.toEqual(envelope)
      expect(provider.calls).toEqual(['create', 'release', 'dispose'])
    }
  })

  it('disposes the provider and surfaces the coded error when the workspace cannot be created', async () => {
    const provider = recordingProvider({
      create: async () => {
        throw new PandaError(PANDA_ERROR_CODES.contractWorkspaceUnavailable, 'no room')
      },
    })
    const adapter = recordingAdapter(async () => ok())

    await expect(
      runSession({ prompt: 'p', createProvider: () => provider, createAdapter: () => adapter }),
    ).rejects.toMatchObject({ code: PANDA_ERROR_CODES.contractWorkspaceUnavailable })
    // Nothing was ever leased, so release must NOT run — releasing a handle that
    // does not exist is what the port raises PANDA_CONTRACT_WORKSPACE_* on.
    expect(provider.calls).toEqual(['dispose'])
    expect(adapter.requests).toHaveLength(0)
  })

  it('releases and disposes when the executor itself throws, and relays the error unwrapped', async () => {
    const provider = recordingProvider()
    const failure = new Error('spawn failed')

    await expect(
      runSession({
        prompt: 'p',
        createProvider: () => provider,
        createAdapter: () =>
          recordingAdapter(() => {
            throw failure
          }),
      }),
    ).rejects.toBe(failure)
    expect(provider.calls).toEqual(['create', 'release', 'dispose'])
  })

  it('cancels through the interrupt seam and unregisters the handler afterwards', async () => {
    const provider = recordingProvider()
    let unregistered = false
    let trigger: (() => void) | undefined

    const session = runSession({
      prompt: 'long task',
      createProvider: () => provider,
      createAdapter: () =>
        recordingAdapter(
          (request) =>
            new Promise<ResultEnvelope>((resolve) => {
              request.signal?.addEventListener('abort', () => resolve(cancelledEnvelope()), { once: true })
            }),
        ),
      onInterrupt: (handler) => {
        trigger = handler
        return () => {
          unregistered = true
        }
      },
    })

    const deadline = Date.now() + 5_000
    while (trigger === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(trigger).toBeDefined()
    trigger?.()

    await expect(session).resolves.toMatchObject({ status: 'cancelled' })
    expect(unregistered).toBe(true)
    expect(provider.calls).toEqual(['create', 'release', 'dispose'])
  })

  it('contains release and dispose failures without masking the envelope', async () => {
    const envelope = await runSession({
      prompt: 'p',
      createProvider: () =>
        recordingProvider({
          release: async () => {
            throw new Error('release exploded')
          },
          dispose: async () => {
            throw new Error('dispose exploded')
          },
        }),
      createAdapter: () => recordingAdapter(async () => ok()),
    })
    expect(envelope).toMatchObject({ status: 'ok' })
  })

  it('contains a dispose failure on the workspace-creation path too', async () => {
    const creationFailure = new PandaError(PANDA_ERROR_CODES.contractWorkspaceUnavailable, 'no room')
    await expect(
      runSession({
        prompt: 'p',
        createProvider: () =>
          recordingProvider({
            create: async () => {
              throw creationFailure
            },
            dispose: async () => {
              throw new Error('dispose exploded')
            },
          }),
      }),
    ).rejects.toBe(creationFailure)
  })
})

describe('runSession routes the executor through the interception waterfall', () => {
  it('records the invocation as an action, so the 1.7 no-bypass guarantee holds end to end', async () => {
    const log = createMemoryLogSink()
    await runSession({
      prompt: 'p',
      log,
      createProvider: () => recordingProvider(),
      createAdapter: () => recordingAdapter(async () => ok()),
    })

    // Records, not a spy: the pipeline is the only thing that writes these, so an
    // `adapter.run(...)` called directly would leave this stream empty.
    expect(log.records.map((record) => [record.event, record.subject])).toEqual([
      ['action.invoked', `${SESSION_ACTION_ID}#w`],
      ['action.completed', `${SESSION_ACTION_ID}#w`],
    ])
  })

  it('scopes the action id to the workspace, so two sessions could share one pipeline', async () => {
    // A pipeline refuses a duplicate registration. Today each session owns its
    // own, so a constant id would work — and would become a breaking change the
    // day a shared pipeline is offered. This keeps that option additive.
    const log = createMemoryLogSink()
    for (const id of ['ws-one', 'ws-two']) {
      await runSession({
        prompt: 'p',
        log,
        createProvider: () =>
          recordingProvider({
            create: async () => ({ id, rootPath: join(tmpdir(), id), capabilities: ['read', 'write'] }),
          }),
        createAdapter: () => recordingAdapter(async () => ok()),
      })
    }
    expect(new Set(log.records.map((record) => record.subject))).toEqual(
      new Set([`${SESSION_ACTION_ID}#ws-one`, `${SESSION_ACTION_ID}#ws-two`]),
    )
  })

  it('refuses a policy violation before the executor runs, and still cleans up', async () => {
    const log = createMemoryLogSink()
    const provider = recordingProvider()
    const adapter = recordingAdapter(async () => ok())

    const refusal: unknown = await runSession({
      prompt: 'p',
      log,
      // Zero admitted invocations: the cheapest expression of "this session may
      // not spawn an executor", enforced as data rather than as prompt wording.
      actionPolicy: { maxInvocations: 0 },
      createProvider: () => provider,
      createAdapter: () => adapter,
    }).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(PandaKernelError)
    expect((refusal as PandaKernelError).code).toBe(KERNEL_ERROR_CODES.invocationCapExceeded)
    expect(adapter.requests).toHaveLength(0)
    expect(provider.calls).toEqual(['create', 'release', 'dispose'])
    expect(log.records.map((record) => record.event)).toEqual(['action.refused'])
  })

  it('charges the run against the cost cap, not only against the invocation count', async () => {
    // 0.5, not 0. A cap of 0 refuses identically whether the pipeline is counting
    // invocations or summing cost, so it cannot tell the two apart; a FRACTIONAL
    // cap can only be a cost cap, because a count of 1 can never exceed it and a
    // cost of 1 always does. That is the whole discrimination available while
    // SESSION_ACTION_COST is a flat 1 — the caps genuinely collapse otherwise,
    // which is stated on the constant and in deferred-work.md.
    const adapter = recordingAdapter(async () => ok())
    await expect(
      runSession({
        prompt: 'p',
        actionPolicy: { maxTotalCost: 0.5 },
        createProvider: () => recordingProvider(),
        createAdapter: () => adapter,
      }),
    ).rejects.toMatchObject({ code: KERNEL_ERROR_CODES.costCapExceeded })
    expect(adapter.requests).toHaveLength(0)
  })
})

describe('runSession boundary reads and ownership', () => {
  it('reads every option once, before the first await', async () => {
    // `provider.create()` hands control back to the caller's event loop. An
    // options object whose accessor answers differently on the second read got a
    // hostile prompt executed under a benign one's authorisation — the exact
    // TOCTOU the kernel closes at `register` and the session must not reopen.
    let reads = 0
    const adapter = recordingAdapter(async () => ok())
    const hostile: SessionOptions = {
      get prompt() {
        reads += 1
        return reads === 1 ? 'delete nothing' : 'rm -rf /'
      },
      createProvider: () => recordingProvider(),
      createAdapter: () => adapter,
    }

    await runSession(hostile)
    expect(adapter.requests[0]?.prompt).toBe('delete nothing')
  })

  it('rejects a blank prompt before creating anything', async () => {
    // An invalid request must cost no mkdir, and must fail with the code the
    // adapter's own validator would have produced.
    for (const prompt of ['', '   ']) {
      const provider = recordingProvider()
      await expect(runSession({ prompt, createProvider: () => provider })).rejects.toMatchObject({
        code: PANDA_ERROR_CODES.contractEnvelopeInvalid,
      })
      expect(provider.calls).toEqual([])
    }
  })

  it('owns the provider it is handed: a second session against the same one is refused', async () => {
    // Documented on `createProvider`, and the reason it needs documenting is that
    // pooling workspaces is the obvious motive for injecting a provider at all.
    const root = await tempCwd()
    const shared = new LocalWorkspaceProvider({ rootDir: join(root, 'workspaces') })
    const adapter = () => recordingAdapter(async () => ok())

    await expect(runSession({ prompt: 'p', createProvider: () => shared, createAdapter: adapter })).resolves.toMatchObject({
      status: 'ok',
    })
    await expect(
      runSession({ prompt: 'p', createProvider: () => shared, createAdapter: adapter }),
    ).rejects.toMatchObject({ code: PANDA_ERROR_CODES.contractProviderDisposed })
  })

  it('contains a throwing deregistration instead of losing the envelope and the cleanup', async () => {
    // Measured before the fix: the rejection replaced a successful `ok` envelope
    // AND skipped release and dispose entirely.
    const provider = recordingProvider()
    const envelope = await runSession({
      prompt: 'p',
      createProvider: () => provider,
      createAdapter: () => recordingAdapter(async () => ok()),
      onInterrupt: () => () => {
        throw new Error('deregistration exploded')
      },
    })
    expect(envelope).toMatchObject({ status: 'ok' })
    expect(provider.calls).toEqual(['create', 'release', 'dispose'])
  })

  it('does not leak the workspace when the interrupt registration itself throws', async () => {
    // Measured before the fix: providerCalls was ["create"] — handle and provider
    // both leaked, because registration sat outside the try that owns cleanup.
    const provider = recordingProvider()
    const boom = new Error('onInterrupt exploded')
    await expect(
      runSession({
        prompt: 'p',
        createProvider: () => provider,
        createAdapter: () => recordingAdapter(async () => ok()),
        onInterrupt: () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)
    expect(provider.calls).toEqual(['create', 'release', 'dispose'])
  })
})
