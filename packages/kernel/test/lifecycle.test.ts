import { describe, expect, it } from 'vitest'
import {
  PluginInactiveError,
  PluginStartFailedError,
  ServiceConflictError,
  SwapRejectedError,
  createKernel,
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

describe('lifecycle: chained teardown ordering', () => {
  it('disposes in exact reverse activation order across a hard-dependency chain', () => {
    const log: string[] = []
    const kernel = createKernel({ orderLog: log })
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

    const stopped = kernel.stop()
    expect(stopped).toEqual({ disposed: ['c', 'b', 'a'], disposalErrors: [] })
    expect(log).toEqual(['activate:a', 'activate:b', 'activate:c', 'dispose:c', 'dispose:b', 'dispose:a'])
  })
})

describe('lifecycle: disposal idempotence', () => {
  it('treats a second stop as a no-op with no duplicate log entries', () => {
    const log: string[] = []
    const kernel = createKernel({ orderLog: log })
    const a = provider('a', 'svc.a', 1)
    kernel.register(a.input, a.factory)
    kernel.start()
    kernel.stop()

    const afterFirstStop = [...log]
    expect(kernel.stop()).toEqual({ disposed: [], disposalErrors: [] })
    expect(log).toEqual(afterFirstStop)
  })
})

describe('lifecycle: per-plugin dispose', () => {
  it('runs the disposer once, is a no-op when repeated, and blocks further lookups', () => {
    let disposals = 0
    const { kernel } = startWith(provider('p', 'svc.p', 42, () => {
      disposals += 1
    }))
    kernel.start()

    kernel.dispose('p')
    expect(disposals).toBe(1)
    expect(() => kernel.getService('svc.p')).toThrow(PluginInactiveError)

    kernel.dispose('p')
    expect(disposals).toBe(1)
  })

  it('is a no-op for unknown plugin ids', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 1))
    expect(() => kernel.dispose('ghost')).not.toThrow()
  })
})

describe('lifecycle: post-dispose use', () => {
  it('raises a typed inactive error naming the plugin when a disposed service is requested', () => {
    const { kernel } = startWith(provider('provider', 'svc.p', 42))
    kernel.stop()

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
    expect(kernel.getService('svc.never')).toEqual({ kind: 'absent' })
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

  it('rejects swaps targeting plugins that are not active', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 'old'))
    expect(() => kernel.swap('ghost', () => ({ status: 'activated' }))).toThrow(PluginInactiveError)

    kernel.stop()
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

  it('runs the superseded disposer at commit and only the current one at stop', () => {
    const disposed: string[] = []
    const { kernel } = startWith(provider('p', 'svc.p', 'old', () => disposed.push('old')))
    kernel.swap('p', () => ({ status: 'activated', services: { 'svc.p': 'new' }, dispose: () => disposed.push('new') }))
    expect(disposed).toEqual(['old'])

    const stopped = kernel.stop()
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
  it('runs every disposer despite throws and collects per-plugin errors', () => {
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
    const stopped = kernel.stop()

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
  it('rejects register and start on a stopped kernel with typed errors naming the kernel', () => {
    const { kernel } = startWith(provider('p', 'svc.p', 1))
    kernel.stop()

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

describe('lifecycle: order log discipline', () => {
  it('keeps swap events out of the ordering log', () => {
    const log: string[] = []
    const kernel = createKernel({ orderLog: log })
    const p = provider('p', 'svc.p', 'old', () => {})
    kernel.register(p.input, p.factory)
    kernel.start()
    kernel.swap('p', () => ({ status: 'activated', services: { 'svc.p': 'new' }, dispose: () => {} }))
    kernel.stop()

    expect(log).toEqual(['activate:p', 'dispose:p'])
  })

  it('never lets a throwing diagnostic abort activation or teardown', () => {
    const hostileLog = {
      push: () => {
        throw new Error('log exploded')
      },
    } as unknown as string[]
    const kernel = createKernel({ orderLog: hostileLog })
    const p = provider('p', 'svc.p', 1, () => {})
    kernel.register(p.input, p.factory)

    expect(() => {
      kernel.start()
      kernel.stop()
    }).not.toThrow()
  })
})
