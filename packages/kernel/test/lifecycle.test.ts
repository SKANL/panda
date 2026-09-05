import { describe, expect, it } from 'vitest'
import {
  PluginInactiveError,
  PluginStartFailedError,
  ServiceConflictError,
  SwapRejectedError,
  createKernel,
  createLogSink,
  createMemoryLogSink,
  type PandaKernel,
  type PluginFactory,
} from '../src'
import { manifest } from './helpers'

function provider(
  id: string,
  service: string,
  value: unknown,
  dispose?: () => void,
): { input: unknown; factory: PluginFactory } {
  return {
    input: manifest({ id, provides: [service] }),
    // Every providing plugin pairs a disposer (frozen constraint); tests pass one only to observe it.
    factory: () => ({ status: 'activated', services: { [service]: value }, dispose: dispose ?? (() => {}) }),
  }
}

function startWith(...registrations: { input: unknown; factory: PluginFactory }[]): {
  kernel: PandaKernel
  result: ReturnType<PandaKernel['start']>
} {
  const kernel = createKernel()
  for (const registration of registrations) kernel.register(registration.input, registration.factory)
  return { kernel, result: kernel.start() }
}

/** The plugin-level transitions in the order the records carry them. */
function lifecycleTrail(log: { readonly records: readonly { event: string; subject: string }[] }): string[] {
  return log.records.filter((r) => r.event.startsWith('plugin.')).map((r) => `${r.event}:${r.subject}`)
}

describe('lifecycle: chained teardown ordering', () => {
  it('disposes in exact reverse activation order across a hard-dependency chain', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'a', provides: ['svc.a'] }), () => ({
      status: 'activated',
      dispose: () => {},
      services: { 'svc.a': 1 },
    }))
    kernel.register(
      manifest({ id: 'b', provides: ['svc.b'], consumes: [{ service: 'svc.a', mode: 'hard' }] }),
      () => ({ status: 'activated', dispose: () => {}, services: { 'svc.b': 2 } }),
    )
    kernel.register(manifest({ id: 'c', consumes: [{ service: 'svc.b', mode: 'hard' }] }), () => ({
      status: 'activated',
      dispose: () => {},
    }))

    const result = kernel.start()
    expect(result.started).toEqual(['a', 'b', 'c'])
    expect(result.failures).toEqual([])

    const stopped = await kernel.stop()
    expect(stopped).toEqual({
      disposed: ['c', 'b', 'a'],
      disposalErrors: [],
      handlerFailures: [],
    })
    expect(lifecycleTrail(log)).toEqual([
      'plugin.activated:a',
      'plugin.activated:b',
      'plugin.activated:c',
      'plugin.disposed:c',
      'plugin.disposed:b',
      'plugin.disposed:a',
    ])
  })
})

describe('lifecycle: disposal idempotence', () => {
  it('treats a second stop as a no-op with no duplicate log entries', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    const a = provider('a', 'svc.a', 1)
    kernel.register(a.input, a.factory)
    kernel.start()
    await kernel.stop()

    // Byte-identical, not merely same-length: a second stop must append nothing,
    // including a second `kernel.stopped`.
    const afterFirstStop = JSON.stringify(log.records)
    expect(afterFirstStop).toContain('kernel.stopped')
    expect(await kernel.stop()).toEqual({ disposed: [], disposalErrors: [], handlerFailures: [] })
    expect(JSON.stringify(log.records)).toBe(afterFirstStop)
  })
})

describe('lifecycle: per-plugin dispose', () => {
  it('runs the disposer once, is a no-op when repeated, and blocks further lookups', async () => {
    let disposals = 0
    const { kernel } = startWith(provider('p', 'svc.p', 42, () => {
      disposals += 1
    }))
    kernel.start()

    await kernel.dispose('p')
    expect(disposals).toBe(1)
    expect(() => kernel.getService('svc.p')).toThrow(PluginInactiveError)

    await kernel.dispose('p')
    expect(disposals).toBe(1)
  })

  it('drains pending bus continuations before running the plugin’s disposer', async () => {
    const observations: string[] = []
    const { kernel } = startWith(provider('p', 'svc.p', 1, () => {
      observations.push(`disposed (pending=${kernel.bus.pendingCount})`)
    }))
    kernel.start()

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    kernel.bus.subscribe('global', async () => {
      await gate
      observations.push('continuation settled')
    })
    kernel.bus.emit('e')

    release?.()
    const run = kernel.dispose('p')
    expect(observations).toEqual([])
    await run

    expect(observations).toEqual(['continuation settled', 'disposed (pending=0)'])
  })

  it('is a no-op for unknown plugin ids', async () => {
    const { kernel } = startWith(provider('p', 'svc.p', 1))
    await expect(kernel.dispose('ghost')).resolves.toBeUndefined()
  })
})

describe('lifecycle: post-dispose use', () => {
  it('raises a typed inactive error naming the plugin when a disposed service is requested', async () => {
    const { kernel } = startWith(provider('provider', 'svc.p', 42))
    await kernel.stop()

    expect(() => kernel.getService('svc.p')).toThrow(PluginInactiveError)
    try {
      kernel.getService('svc.p')
      expect.unreachable()
    } catch (error) {
      expect((error as PluginInactiveError).code).toBe('PANDA_KERNEL_PLUGIN_INACTIVE')
      expect((error as PluginInactiveError).pluginId).toBe('provider')
      expect((error as PluginInactiveError).message).toContain("'provider'")
    }
  })

  it('resolves never-provided services to typed absent, not undefined', () => {
    const { kernel } = startWith(provider('a', 'svc.a', 1))
    // The reason is asserted rather than ignored: M7.B widened this additively,
    // and an exact-equality assertion is what forced the widening to be noticed.
    expect(kernel.getService('svc.never')).toEqual({ kind: 'absent', reason: 'no-provider' })
  })
})

describe('lifecycle: service coverage invariant', () => {
  it('contains activations whose services miss declared provides', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'incomplete', provides: ['svc.a', 'svc.b'] }), () => ({
      status: 'activated',
      services: { 'svc.a': 1 },
    }))

    const result = kernel.start()
    expect(result.started).toEqual([])
    expect(result.failures[0]?.pluginId).toBe('incomplete')
    expect(result.failures[0]?.error).toBeInstanceOf(PluginStartFailedError)
    expect(result.failures[0]?.error.message).toContain("'svc.b'")
  })

  it('rejects undefined-valued services that would masquerade as provided', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'hole', provides: ['svc.hole'] }), () => ({
      status: 'activated',
      services: { 'svc.hole': undefined },
      dispose: () => {},
    }))

    const result = kernel.start()
    expect(result.started).toEqual([])
    expect(result.failures[0]?.error.message).toContain("'svc.hole'")
  })

  it('names each mismatched service in a rejected swap and keeps the previous implementation', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 'old'))

    const candidate: PluginFactory = () => ({
      status: 'activated',
      services: { 'svc.other': 'x' },
      dispose: () => {},
    })
    expect(() => kernel.swap('p', candidate)).toThrow(SwapRejectedError)
    try {
      kernel.swap('p', candidate)
      expect.unreachable()
    } catch (error) {
      expect((error as SwapRejectedError).issues).toEqual([
        "provided service 'svc.p' missing from activated services",
        "service 'svc.other' is not declared in provides",
      ])
    }
    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'old' })
  })

  it('rebuilds service lookups through the committed implementation after a swap', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 'old'))
    kernel.swap('p', () => ({ status: 'activated', services: { 'svc.p': 'new' }, dispose: () => {} }))
    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'new' })
  })
})

describe('lifecycle: disposer pairing invariant', () => {
  it('fails activation when a providing plugin pairs no disposer', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'undisposed', provides: ['svc.u'] }), () => ({
      status: 'activated',
      services: { 'svc.u': 1 },
    }))

    const result = kernel.start()
    expect(result.started).toEqual([])
    expect(result.failures[0]?.error).toBeInstanceOf(PluginStartFailedError)
    expect(result.failures[0]?.error.message).toContain('pairs no disposer')
    expect(result.failures[0]?.error.message).toContain("'undisposed'")
  })

  it('rejects a swap candidate that provides services but no disposer, keeping the old one serving', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 'old'))
    const candidate: PluginFactory = () => ({ status: 'activated', services: { 'svc.p': 'new' } })
    expect(() => kernel.swap('p', candidate)).toThrow(PluginStartFailedError)
    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'old' })
  })
})

describe('lifecycle: invalid swap', () => {
  it('keeps the previous implementation serving and names each validation failure', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 'old'))

    const rejected: PluginFactory = () => ({ status: 'rejected', issues: ['config invalid', 'missing dependency'] })
    expect(() => kernel.swap('p', rejected)).toThrow(SwapRejectedError)
    try {
      kernel.swap('p', rejected)
      expect.unreachable()
    } catch (error) {
      expect((error as SwapRejectedError).code).toBe('PANDA_KERNEL_SWAP_REJECTED')
      expect((error as SwapRejectedError).issues).toEqual(['config invalid', 'missing dependency'])
    }

    const thrown: PluginFactory = () => {
      throw new Error('exploded during validation')
    }
    expect(() => kernel.swap('p', thrown)).toThrow(SwapRejectedError)

    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'old' })
  })

  it('preserves the candidate throw as cause on the rejection', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 'old'))
    const original = new Error('exploded during validation')
    const thrown: PluginFactory = () => {
      throw original
    }
    try {
      kernel.swap('p', thrown)
      expect.unreachable()
    } catch (error) {
      expect((error as SwapRejectedError).cause).toBe(original)
    }
  })

  it('rejects swaps targeting plugins that are not active', async () => {
    const { kernel } = startWith(provider('p', 'svc.p', 'old'))
    expect(() => kernel.swap('ghost', () => ({ status: 'activated' }))).toThrow(PluginInactiveError)

    await kernel.stop()
    expect(() => kernel.swap('p', () => ({ status: 'activated' }))).toThrow(PluginInactiveError)
  })
})

describe('lifecycle: valid swap', () => {
  it('serves the new implementation immediately and runs the old disposer after commit', () => {
    const observations: string[] = []
    let oldDisposedAfterCommit = false
    const { kernel } = startWith(
      provider('p', 'svc.p', 'old', () => {
        observations.push(`old disposer sees: ${JSON.stringify(kernel.getService('svc.p'))}`)
        oldDisposedAfterCommit = true
      }),
    )

    const result = kernel.swap('p', () => ({
      status: 'activated',
      services: { 'svc.p': 'new' },
      dispose: () => {},
    }))

    expect(result.disposalError).toBeUndefined()
    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'new' })
    expect(oldDisposedAfterCommit).toBe(true)
    expect(observations).toEqual(['old disposer sees: {"kind":"provided","pluginId":"p","value":"new"}'])
  })

  it('runs the superseded disposer at commit and only the current one at stop', async () => {
    const disposed: string[] = []
    const { kernel } = startWith(provider('p', 'svc.p', 'old', () => disposed.push('old')))
    kernel.swap('p', () => ({ status: 'activated', services: { 'svc.p': 'new' }, dispose: () => disposed.push('new') }))
    expect(disposed).toEqual(['old'])

    const stopped = await kernel.stop()
    expect(stopped.disposed).toEqual(['p'])
    expect(disposed).toEqual(['old', 'new'])
  })

  it('contains an old-disposer throw after commit instead of failing the swap', () => {
    const boom = new Error('old disposer exploded')
    const { kernel } = startWith(
      provider('p', 'svc.p', 'old', () => {
        throw boom
      }),
    )

    const result = kernel.swap('p', () => ({
      status: 'activated',
      services: { 'svc.p': 'new' },
      dispose: () => {},
    }))

    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'new' })
    expect(result.disposalError).toEqual({ pluginId: 'p', error: boom })
  })
})

describe('lifecycle: disposer exception containment at stop', () => {
  it('runs every disposer despite throws and collects per-plugin errors', async () => {
    const disposed: string[] = []
    const boom = new Error('b exploded')
    const kernel = createKernel()
    const a = provider('a', 'svc.a', 1, () => disposed.push('a'))
    const b = {
      input: manifest({ id: 'b', provides: ['svc.b'], consumes: [{ service: 'svc.a', mode: 'hard' }] }),
      factory: (): { status: 'activated'; services: Record<string, unknown>; dispose: () => void } => ({
        status: 'activated',
        services: { 'svc.b': 2 },
        dispose: () => {
          throw boom
        },
      }),
    }
    kernel.register(a.input, a.factory)
    kernel.register(b.input, b.factory)
    kernel.register(manifest({ id: 'd', consumes: [{ service: 'svc.b', mode: 'hard' }] }), () => ({
      status: 'activated',
      dispose: () => disposed.push('d'),
    }))

    kernel.start()
    const stopped = await kernel.stop()

    expect(disposed).toEqual(['d', 'a'])
    expect(stopped.disposed).toEqual(['d', 'b', 'a'])
    expect(stopped.disposalErrors).toEqual([{ pluginId: 'b', error: boom }])
  })
})

describe('lifecycle: activation failure containment', () => {
  it('records the failed plugin while every other plugin activates and serves', () => {
    const failing: PluginFactory = () => {
      throw new Error('startup exploded')
    }
    const { kernel, result } = startWith(
      provider('x', 'svc.x', 'x-value'),
      { input: manifest({ id: 'y' }), factory: failing },
      provider('z', 'svc.z', 'z-value'),
    )

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.pluginId).toBe('y')
    expect(result.failures[0]?.error).toBeInstanceOf(PluginStartFailedError)
    expect(result.failures[0]?.error.code).toBe('PANDA_KERNEL_PLUGIN_START_FAILED')
    expect((result.failures[0]?.error as PluginStartFailedError).cause).toBeInstanceOf(Error)
    expect(result.started).toEqual(['x', 'z'])
    expect(kernel.getService('svc.x')).toEqual({ kind: 'provided', pluginId: 'x', value: 'x-value' })
    expect(kernel.getService('svc.z')).toEqual({ kind: 'provided', pluginId: 'z', value: 'z-value' })
  })

  it('never activates plugins whose hard-consumed services are absent, surfacing the loader failure', () => {
    const activated: string[] = []
    const kernel = createKernel()
    kernel.register(manifest({ id: 'dependent', consumes: [{ service: 'svc.gone', mode: 'hard' }] }), () => {
      activated.push('dependent')
      return { status: 'activated' }
    })

    const result = kernel.start()
    expect(activated).toEqual([])
    expect(result.failures[0]?.pluginId).toBe('dependent')
    expect(result.failures[0]?.error.code).toBe('PANDA_KERNEL_SERVICE_NOT_PROVIDED')
  })

  it('activates each plugin once and reports each failure once across repeated starts', () => {
    const activations: string[] = []
    const kernel = createKernel()
    kernel.register(manifest({ id: 'ok', provides: ['svc.ok'] }), () => {
      activations.push('ok')
      return { status: 'activated', services: { 'svc.ok': 1 }, dispose: () => {} }
    })
    kernel.register(manifest({ id: 'bad' }), () => {
      activations.push('bad')
      throw new Error('nope')
    })

    const first = kernel.start()
    const second = kernel.start()

    expect(first.started).toEqual(['ok'])
    expect(first.failures.map((failure) => failure.pluginId)).toEqual(['bad'])
    expect(second.started).toEqual([])
    expect(second.failures).toEqual([])
    expect(activations).toEqual(['ok', 'bad'])
  })
})

describe('lifecycle: terminal state', () => {
  it('rejects register and start on a stopped kernel with typed errors naming the kernel', async () => {
    const { kernel } = startWith(provider('p', 'svc.p', 1))
    await kernel.stop()

    expect(() =>
      kernel.register(manifest({ id: 'late' }), () => ({ status: 'activated' })),
    ).toThrow(PluginInactiveError)
    expect(() => kernel.start()).toThrow(PluginInactiveError)
    try {
      kernel.start()
      expect.unreachable()
    } catch (error) {
      expect((error as PluginInactiveError).code).toBe('PANDA_KERNEL_PLUGIN_INACTIVE')
      expect((error as PluginInactiveError).message).toContain("'kernel'")
    }
  })
})

describe('lifecycle: composition with the loader', () => {
  it('propagates loader rejections for invalid manifests, conflicts, and cycles', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'first', provides: ['svc.dup'] }), () => ({ status: 'activated' }))
    kernel.register(manifest({ id: 'second', provides: ['svc.dup'] }), () => ({ status: 'activated' }))
    expect(() => kernel.start()).toThrow(ServiceConflictError)
  })

  it('activates providers before consumers regardless of registration order', () => {
    const kernel = createKernel()
    kernel.register(
      manifest({ id: 'b', provides: ['svc.b'], consumes: [{ service: 'svc.a', mode: 'hard' }] }),
      () => ({ status: 'activated', services: { 'svc.b': 1 }, dispose: () => {} }),
    )
    kernel.register(manifest({ id: 'a', provides: ['svc.a'] }), () => ({
      status: 'activated',
      services: { 'svc.a': 1 },
      dispose: () => {},
    }))
    expect(kernel.start().started).toEqual(['a', 'b'])
  })
})

describe('lifecycle: drained shutdown', () => {
  it('drains pending event-handler continuations before any disposer runs, with the bus quiescent', async () => {
    const observations: string[] = []
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), () => ({
      status: 'activated',
      services: { 'svc.p': 1 },
      dispose: () => {
        // A disposer must never observe a half-drained bus.
        observations.push(`disposed (pending=${kernel.bus.pendingCount})`)
      },
    }))
    kernel.start()

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    kernel.bus.subscribe('global', async (event) => {
      await gate
      observations.push(`handler finished:${String(event.payload)}`)
    })
    kernel.bus.emit('task.progress', 'tick')

    release?.()
    const stopped = await kernel.stop()

    expect(observations).toEqual(['handler finished:tick', 'disposed (pending=0)'])
    expect(stopped.disposed).toEqual(['p'])
  })

  it('surfaces rejected handler continuations in the stop result', async () => {
    const boom = new Error('continuation exploded')
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { kernel } = startWith(provider('p', 'svc.p', 1))
    kernel.bus.subscribe('global', async () => {
      await gate
      throw boom
    })
    kernel.bus.emit('e')

    release?.()
    const stopped = await kernel.stop()

    expect(stopped.handlerFailures).toHaveLength(1)
    expect(stopped.handlerFailures[0]?.listenerId).toBe('listener-0')
    expect(stopped.handlerFailures[0]?.error).toBe(boom)
  })

  it('returns empty handlerFailures when no continuation failed', async () => {
    const { kernel } = startWith(provider('p', 'svc.p', 1))
    kernel.bus.subscribe('global', async () => {})
    kernel.bus.emit('e')

    const stopped = await kernel.stop()
    expect(stopped.handlerFailures).toEqual([])
  })

  it('shares one in-flight result across concurrent stop calls', async () => {
    let disposals = 0
    const { kernel } = startWith(provider('p', 'svc.p', 1, () => {
      disposals += 1
    }))

    const [first, second] = await Promise.all([kernel.stop(), kernel.stop()])

    expect(first).toBe(second)
    expect(disposals).toBe(1)
    expect(first.disposed).toEqual(['p'])

    const third = await kernel.stop()
    expect(third).toEqual({ disposed: [], disposalErrors: [], handlerFailures: [] })
  })

  it('rejects emit and subscribe on the bus once stop has completed', async () => {
    const { kernel } = startWith(provider('p', 'svc.p', 1))

    const stopped = await kernel.stop()
    expect(() => kernel.bus.emit('late')).toThrow(PluginInactiveError)
    expect(() => kernel.bus.subscribe('global', () => {})).toThrow(PluginInactiveError)
    try {
      kernel.bus.emit('late')
      expect.unreachable()
    } catch (error) {
      expect((error as PluginInactiveError).code).toBe('PANDA_KERNEL_PLUGIN_INACTIVE')
      expect((error as PluginInactiveError).message).toContain("'kernel'")
    }
    expect(stopped.handlerFailures).toEqual([])
  })

  it('lets plugins subscribe and read config through the activation context', () => {
    const observed: string[] = []
    const kernel = createKernel()
    kernel.register(manifest({ id: 'wired', provides: ['level'] }), (context) => ({
      status: 'activated',
      services: { level: (context.config.resolve() as { level?: string }).level },
      dispose: () => {},
    }))
    kernel.register(
      manifest({ id: 'listener', consumes: [{ service: 'level', mode: 'hard' }] }),
      (context) => {
        context.bus.subscribe('agent', 'a', (event) => {
          observed.push(`${event.type}:${String(event.payload)}`)
        })
        return { status: 'activated' }
      },
    )
    kernel.config.setLayer('defaults', { level: 'info' })
    kernel.start()

    kernel.bus.emit('task.started', 'tick', { agentId: 'a' })
    kernel.bus.emit('task.started', 'tock', { agentId: 'b' })

    expect(observed).toEqual(['task.started:tick'])
  })

  it('exposes the scoped event bus and layered config as kernel-owned services', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 1))
    const seen: string[] = []
    kernel.bus.subscribe('agent', 'a', (event) => {
      seen.push(String(event.payload))
    })
    kernel.config.setLayer('defaults', { level: 'info' })

    kernel.bus.emit('e', 'only-agent-a', { agentId: 'a' })
    kernel.bus.emit('e', 'not-for-agent-b', { agentId: 'b' })

    expect(seen).toEqual(['only-agent-a'])
    expect(kernel.config.resolve()).toEqual({ level: 'info' })
  })
})

describe('lifecycle: record stream discipline', () => {
  it('records a swap as its own transition, between activation and disposal', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    const p = provider('p', 'svc.p', 'old', () => {})
    kernel.register(p.input, p.factory)
    kernel.start()
    kernel.swap('p', () => ({ status: 'activated', services: { 'svc.p': 'new' }, dispose: () => {} }))
    await kernel.stop()

    expect(lifecycleTrail(log)).toEqual(['plugin.activated:p', 'plugin.swapped:p', 'plugin.disposed:p'])
  })

  it('never lets a throwing sink abort activation or teardown', async () => {
    const hostileSink = createLogSink(() => {})
    const kernel = createKernel({
      log: {
        ...hostileSink,
        record: () => {
          throw new Error('sink exploded')
        },
      },
    })
    const p = provider('p', 'svc.p', 1, () => {})
    kernel.register(p.input, p.factory)

    let disposed = false
    kernel.register(manifest({ id: 'q', provides: ['svc.q'] }), () => ({
      status: 'activated',
      services: { 'svc.q': 1 },
      dispose: () => {
        disposed = true
      },
    }))

    expect(kernel.start().started).toEqual(['p', 'q'])
    // The disposers still run: a broken diagnostic must not skip teardown.
    await expect(kernel.stop()).resolves.toMatchObject({ disposed: ['q', 'p'] })
    expect(disposed).toBe(true)
  })

  it('never lets a rejecting drain skip the disposers or crash the process', async () => {
    const base = createLogSink(() => {})
    const disposals: string[] = []
    const kernel = createKernel({
      log: { ...base, drain: () => Promise.reject(new Error('drain exploded')) },
    })
    const p = provider('p', 'svc.p', 1, () => disposals.push('p'))
    kernel.register(p.input, p.factory)
    kernel.start()

    await expect(kernel.stop()).resolves.toMatchObject({ disposed: ['p'] })
    expect(disposals).toEqual(['p'])
  })
})

// --- M7.A: teardown does what the kernel says it does ------------------------

describe('M7.A rows 1-4: a rejected candidate is torn down, not stranded', () => {
  // The factory RAN. It opened whatever it opened and handed back a disposer.
  // Rejecting it for coverage and dropping that disposer strands the resources
  // permanently — nothing in the kernel ever holds a reference to it again.
  it('runs the disposer of a candidate rejected for coverage, exactly once', () => {
    let disposed = 0
    const kernel = createKernel()
    kernel.register(manifest({ id: 'hole', provides: ['svc.hole'] }), () => ({
      status: 'activated',
      services: { 'svc.hole': undefined },
      dispose: () => {
        disposed += 1
      },
    }))

    const result = kernel.start()

    expect(result.started).toEqual([])
    expect(result.failures[0]?.error.message).toContain("'svc.hole'")
    expect(disposed).toBe(1)
  })

  it('reports a teardown failure BESIDE the coverage issues, never instead of them', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'both', provides: ['svc.both'] }), () => ({
      status: 'activated',
      services: { 'svc.other': 1 },
      dispose: () => {
        throw new Error('cleanup exploded')
      },
    }))

    const result = kernel.start()

    const message = result.failures[0]?.error.message ?? ''
    // The author needs BOTH facts: their services did not match, and their
    // cleanup then failed. The second must not hide the first.
    expect(message).toContain("'svc.both'")
    expect(message).toContain('cleanup exploded')
  })

  it('runs the disposer of a candidate a SWAP rejected, while the previous keeps serving', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 'old'))
    let disposed = 0

    const candidate: PluginFactory = () => ({
      status: 'activated',
      services: { 'svc.other': 'x' },
      dispose: () => {
        disposed += 1
      },
    })

    expect(() => kernel.swap('p', candidate)).toThrow(SwapRejectedError)
    expect(disposed).toBe(1)
    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'old' })
  })

  it('leaves a pairing rejection alone, because there is nothing to call', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'nodisposer', provides: ['svc.x'] }), () => ({
      status: 'activated',
      services: { 'svc.x': 1 },
    }))

    const result = kernel.start()

    expect(result.failures[0]?.error.message).toContain('pairs no disposer')
  })
})

describe('M7.A rows 5-9: disposal may be asynchronous, and stop() waits for it', () => {
  it('does not resolve stop() until an async disposer has settled', async () => {
    let released!: () => void
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })
    let finished = false

    const kernel = createKernel()
    kernel.register(manifest({ id: 'slow', provides: ['svc.slow'] }), () => ({
      status: 'activated',
      services: { 'svc.slow': 1 },
      dispose: async () => {
        await gate
        finished = true
      },
    }))
    kernel.start()

    let stopResolved = false
    const stopping = kernel.stop().then(() => {
      stopResolved = true
    })

    // The assertion that DISCRIMINATES. Asserting `finished === false` here
    // passes with or without the fix — the disposer is gated either way — so it
    // proves nothing. What proves it is that `stop()` is STILL PENDING while the
    // gate is shut. `setImmediate` drains the whole microtask queue first, so a
    // stop() that did not await the disposer has already resolved by this line.
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopResolved, 'stop() resolved while a disposer was still running').toBe(false)
    expect(finished).toBe(false)

    released()
    await stopping
    expect(finished).toBe(true)
  })

  it('contains a REJECTING async disposer as a DisposalFailure instead of an unhandled rejection', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'boom', provides: ['svc.boom'] }), () => ({
      status: 'activated',
      services: { 'svc.boom': 1 },
      dispose: () => Promise.reject(new Error('flush failed')),
    }))
    kernel.start()

    const stopped = await kernel.stop()

    expect(stopped.disposalErrors).toHaveLength(1)
    expect(stopped.disposalErrors[0]?.pluginId).toBe('boom')
    expect((stopped.disposalErrors[0]?.error as Error).message).toBe('flush failed')
    expect(lifecycleTrail(log)).toContain('plugin.disposal-failed:boom')
  })

  it('contains the same rejection through dispose(pluginId)', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'one', provides: ['svc.one'] }), () => ({
      status: 'activated',
      services: { 'svc.one': 1 },
      dispose: () => Promise.reject(new Error('nope')),
    }))
    kernel.start()

    await kernel.dispose('one')

    // A disposed plugin's service THROWS rather than reading absent — that is
    // the existing contract, pinned above; the point of this row is that the
    // rejecting async disposer was contained on the way there.
    expect(() => kernel.getService('svc.one')).toThrow(PluginInactiveError)
    expect(lifecycleTrail(log)).toContain('plugin.disposal-failed:one')
  })

  // ROW 9, the one that would be silent. A `Promise.all` over the disposal loop
  // passes every row above and destroys reverse order, so the ordering has to be
  // asserted against an ASYNC disposer that yields the microtask queue.
  it('keeps reverse activation order exact when a disposer is asynchronous', async () => {
    const order: string[] = []
    const kernel = createKernel()
    kernel.register(manifest({ id: 'first', provides: ['svc.first'] }), () => ({
      status: 'activated',
      services: { 'svc.first': 1 },
      dispose: () => {
        order.push('first')
      },
    }))
    kernel.register(manifest({ id: 'second', consumes: [{ service: 'svc.first', mode: 'hard' }] }), () => ({
      status: 'activated',
      dispose: async () => {
        await Promise.resolve()
        order.push('second')
      },
    }))
    kernel.start()

    await kernel.stop()

    // `second` activated last, so it tears down first — and its async body must
    // FINISH before `first` begins, not merely be started before it.
    expect(order).toEqual(['second', 'first'])
  })
})

describe('M7.A rows 10-11: the window around the disposer loop', () => {
  it('drains listener continuations a disposer started, so their failures are reported', async () => {
    const kernel = createKernel()
    kernel.bus.subscribe('global', async () => {
      await Promise.resolve()
      throw new Error('from a disposer-triggered listener')
    })
    kernel.register(manifest({ id: 'emitter', provides: ['svc.emitter'] }), (context) => ({
      status: 'activated',
      services: { 'svc.emitter': 1 },
      dispose: () => {
        context.bus.emit('teardown')
      },
    }))
    kernel.start()

    const stopped = await kernel.stop()

    expect(stopped.handlerFailures.length).toBeGreaterThan(0)
  })

  it('records a rejecting previous disposer on swap instead of letting it float', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), () => ({
      status: 'activated',
      services: { 'svc.p': 'old' },
      dispose: () => Promise.reject(new Error('async teardown failed')),
    }))
    kernel.start()

    // swap() is synchronous by design and does not await; the guarantee here is
    // only that the rejection is CONTAINED rather than becoming an unhandled one.
    kernel.swap('p', () => ({ status: 'activated', services: { 'svc.p': 'new' }, dispose: () => {} }))
    await Promise.resolve()
    await Promise.resolve()

    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'new' })
    expect(lifecycleTrail(log)).toContain('plugin.disposal-failed:p')
  })
})

describe('M7.B rows 10-14: typed absence says WHICH absence', () => {
  it('names a service no plugin provides', () => {
    const { kernel } = startWith(provider('a', 'svc.a', 1))
    expect(kernel.getService('svc.never')).toEqual({ kind: 'absent', reason: 'no-provider' })
  })

  // ROW 11. A constant `reason` passes row 10, so this is the row that
  // discriminates: the provider EXISTS and is parked, which is a different
  // problem with a different fix from a misspelled service name.
  it('distinguishes a provider that never became ready', () => {
    const kernel = createKernel()
    // `blocked` hard-consumes a service nothing provides, so it stays unready —
    // and `svc.blocked` therefore has a registered provider that is not active.
    kernel.register(
      manifest({ id: 'blocked', provides: ['svc.blocked'], consumes: [{ service: 'svc.missing', mode: 'hard' }] }),
      () => ({ status: 'activated', services: { 'svc.blocked': 1 }, dispose: () => {} }),
    )
    kernel.start()

    expect(kernel.getService('svc.blocked')).toEqual({ kind: 'absent', reason: 'provider-unready' })
    // And the two answers are genuinely different, which is the whole point.
    expect(kernel.getService('svc.missing')).toEqual({ kind: 'absent', reason: 'no-provider' })
  })

  it('distinguishes a provider whose activation failed', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'broken', provides: ['svc.broken'] }), () => {
      throw new Error('activation exploded')
    })
    kernel.start()

    expect(kernel.getService('svc.broken')).toEqual({ kind: 'absent', reason: 'provider-failed' })
  })

  it('still THROWS for a provider that was disposed, rather than reporting absence', async () => {
    const { kernel } = startWith(provider('p', 'svc.p', 1))
    await kernel.stop()

    expect(() => kernel.getService('svc.p')).toThrow(PluginInactiveError)
  })

  it('leaves a consumer that only checks the kind working unchanged', () => {
    const { kernel } = startWith(provider('a', 'svc.a', 1))
    const resolution = kernel.getService('svc.never')

    // The field is ADDITIVE: every existing `kind === 'absent'` check still
    // compiles and still means exactly what it meant.
    expect(resolution.kind).toBe('absent')
    if (resolution.kind === 'absent') expect(typeof resolution.reason).toBe('string')
  })
})

// --- M7.C: a required field the kernel actually applies ----------------------

type SchemaResult = { value: unknown } | { issues: { message: string; path?: readonly (string | number)[] }[] }

/** A plugin's own schema, so a test can make it default, accept, or reject. */
function subtreeSchema(validate: (value: unknown) => SchemaResult): unknown {
  return { '~standard': { version: 1, validate } }
}

describe('M7.C rows 1-4: the kernel applies the schema BEFORE the factory', () => {
  it('hands the factory its own validated subtree', () => {
    let seen: unknown
    const kernel = createKernel()
    kernel.register(manifest({ id: 'cfg', configSchema: subtreeSchema((value) => ({ value })) }), (context) => {
      seen = context.settings
      return { status: 'activated' }
    })
    kernel.config.setLayer('defaults', { cfg: { depth: 3 } })

    kernel.start()

    expect(seen).toEqual({ depth: 3 })
  })

  it('gives the factory the schema-applied DEFAULT when the subtree is absent', () => {
    let seen: unknown
    const kernel = createKernel()
    kernel.register(
      manifest({ id: 'cfg', configSchema: subtreeSchema((value) => ({ value: value ?? { depth: 1 } })) }),
      (context) => {
        seen = context.settings
        return { status: 'activated' }
      },
    )

    kernel.start()

    // Validation that discarded `result.value` would hand the factory
    // `undefined` here, and the default the author wrote would never arrive.
    expect(seen).toEqual({ depth: 1 })
  })

  it('fails the plugin to start when its own subtree violates its own schema', () => {
    const kernel = createKernel()
    kernel.register(
      manifest({
        id: 'cfg',
        configSchema: subtreeSchema(() => ({ issues: [{ message: "'depth' must be a number" }] })),
      }),
      () => ({ status: 'activated' }),
    )

    const result = kernel.start()

    expect(result.started).toEqual([])
    expect(result.failures[0]?.error).toBeInstanceOf(PluginStartFailedError)
    expect(result.failures[0]?.error.message).toContain("'depth' must be a number")
  })

  // ROW 4, the discriminating one. Validating and then calling the factory
  // ANYWAY passes every other row here: the rejection is still reported and the
  // issues are still named. What it loses is the point — a factory that already
  // opened resources and is then told its configuration was invalid is the leak
  // M7.A closed by another route.
  it('never runs the factory of a plugin whose configuration was rejected', () => {
    let calls = 0
    const kernel = createKernel()
    kernel.register(
      manifest({ id: 'cfg', configSchema: subtreeSchema(() => ({ issues: [{ message: 'no' }] })) }),
      () => {
        calls += 1
        return { status: 'activated' }
      },
    )

    kernel.start()

    expect(calls).toBe(0)
  })
})

describe('M7.C rows 5-9: what the schema decides, and what the message shows', () => {
  it('lets a lenient schema accept an absent subtree', () => {
    const kernel = createKernel()
    kernel.register(
      manifest({ id: 'lenient', configSchema: subtreeSchema((value) => ({ value: value ?? {} })) }),
      () => ({ status: 'activated' }),
    )

    expect(kernel.start().started).toEqual(['lenient'])
  })

  // The regression this story most had to not cause: `workspace-local` tolerates
  // a forward-looking key on purpose, and that leniency lives in ITS schema. A
  // kernel that imposed strictness of its own would break `panda run` for a user
  // with an unknown key while every kernel-level row above still passed.
  it('lets a lenient schema accept unknown keys, so leniency stays the plugin decision', () => {
    const kernel = createKernel()
    kernel.register(
      manifest({ id: 'lenient', configSchema: subtreeSchema((value) => ({ value })) }),
      () => ({ status: 'activated' }),
    )
    kernel.config.setLayer('defaults', { lenient: { forwardLooking: true } })

    expect(kernel.start().started).toEqual(['lenient'])
  })

  it('contains a schema that THROWS instead of returning issues', () => {
    const kernel = createKernel()
    kernel.register(
      manifest({
        id: 'thrower',
        configSchema: subtreeSchema((value) => {
          // The manifest probe passes a symbol, so registration succeeds and
          // activation is where this lands.
          if (typeof value === 'symbol') return { value }
          throw new Error('schema exploded')
        }),
      }),
      () => ({ status: 'activated' }),
    )

    const result = kernel.start()

    expect(result.started).toEqual([])
    expect(result.failures[0]?.error).toBeInstanceOf(PluginStartFailedError)
    expect(result.failures[0]?.error.message).toContain('schema exploded')
  })

  it('renders the coordinate of an issue that carries a path', () => {
    const kernel = createKernel()
    kernel.register(
      manifest({
        id: 'cfg',
        configSchema: subtreeSchema(() => ({
          issues: [{ message: 'expected number', path: ['retry', 'attempts'] }],
        })),
      }),
      () => ({ status: 'activated' }),
    )

    const message = kernel.start().failures[0]?.error.message ?? ''
    expect(message).toContain('expected number')
    expect(message).toContain('retry.attempts')
  })

  it('leaves a pathless issue reading exactly as it does today', () => {
    const kernel = createKernel()
    kernel.register(
      manifest({ id: 'cfg', configSchema: subtreeSchema(() => ({ issues: [{ message: 'plain' }] })) }),
      () => ({ status: 'activated' }),
    )

    const message = kernel.start().failures[0]?.error.message ?? ''
    expect(message).toContain('plain')
    expect(message).not.toContain('(at ')
  })
})

describe('M7.C rows 10 and 12: swap, and the config that stays', () => {
  it('validates a swap candidate through the same path, and keeps the previous serving when it fails', () => {
    let reject = false
    const kernel = createKernel()
    kernel.register(
      manifest({
        id: 'p',
        provides: ['svc.p'],
        configSchema: subtreeSchema((value) =>
          reject ? { issues: [{ message: 'candidate config is invalid' }] } : { value },
        ),
      }),
      () => ({ status: 'activated', services: { 'svc.p': 'old' }, dispose: () => {} }),
    )
    kernel.start()

    reject = true
    expect(() =>
      kernel.swap('p', () => ({ status: 'activated', services: { 'svc.p': 'new' }, dispose: () => {} })),
    // SwapRejectedError, not PluginStartFailedError: nothing changed and the
    // previous implementation is still serving, which is exactly what that error
    // means — and it carries the issues, where the start failure carries prose.
    ).toThrow(SwapRejectedError)
    expect(kernel.getService('svc.p')).toEqual({ kind: 'provided', pluginId: 'p', value: 'old' })
  })

  it('still hands the factory the whole composed document through context.config', () => {
    let composed: unknown
    const kernel = createKernel()
    kernel.register(manifest({ id: 'cfg', configSchema: subtreeSchema((value) => ({ value })) }), (context) => {
      composed = context.config.resolve()
      return { status: 'activated' }
    })
    kernel.config.setLayer('defaults', { cfg: { a: 1 }, somethingElse: { b: 2 } })

    kernel.start()

    // `settings` is the plugin's own slice; `config` remains the whole document,
    // which `@skanl/panda-session` and the executor selection both still read.
    expect(composed).toEqual({ cfg: { a: 1 }, somethingElse: { b: 2 } })
  })
})
