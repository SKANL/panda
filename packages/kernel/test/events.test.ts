import { describe, expect, it } from 'vitest'
import {
  InvalidScopeError,
  PandaKernelError,
  ReemitDuringFanoutError,
  createEventBus,
  type BusEvent,
  type DispatchFailure,
} from '../src'

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('events: agent isolation', () => {
  it('delivers interleaved emissions to exactly each agent-scoped listener, in order', () => {
    const bus = createEventBus()
    const alphaSeen: string[] = []
    const betaSeen: string[] = []
    bus.subscribe('agent', 'alpha', (event) => {
      alphaSeen.push(`${event.type}:${String(event.payload)}`)
    })
    bus.subscribe('agent', 'beta', (event) => {
      betaSeen.push(`${event.type}:${String(event.payload)}`)
    })

    bus.emit('task.started', 'a1', { projectId: 'p1', agentId: 'alpha' })
    bus.emit('task.started', 'b1', { projectId: 'p1', agentId: 'beta' })
    bus.emit('task.finished', 'a2', { projectId: 'p2', agentId: 'alpha' })
    bus.emit('task.finished', 'b2', { projectId: 'p2', agentId: 'beta' })

    expect(alphaSeen).toEqual(['task.started:a1', 'task.finished:a2'])
    expect(betaSeen).toEqual(['task.started:b1', 'task.finished:b2'])
  })
})

describe('events: scope visibility', () => {
  it('lets a global listener observe every event including every agent’s', () => {
    const bus = createEventBus()
    const seen: BusEvent[] = []
    bus.subscribe('global', (event) => {
      seen.push(event)
    })

    bus.emit('e.one', 1, { projectId: 'p1', agentId: 'alpha' })
    bus.emit('e.two', 2, { projectId: 'p1' })
    bus.emit('e.three', 3)

    expect(seen.map((event) => event.type)).toEqual(['e.one', 'e.two', 'e.three'])
  })

  it('scopes project listeners to their own project, agents included', () => {
    const bus = createEventBus()
    const homeSeen: string[] = []
    bus.subscribe('project', 'home', (event) => {
      homeSeen.push(String(event.payload))
    })

    bus.emit('e', 'home-agent', { projectId: 'home', agentId: 'a' })
    bus.emit('e', 'away', { projectId: 'away' })

    expect(homeSeen).toEqual(['home-agent'])
  })
})

describe('events: ordered fan-out', () => {
  it('runs listeners in subscription order within a scope', () => {
    const bus = createEventBus()
    const calls: string[] = []
    bus.subscribe('global', () => {
      calls.push('first')
    })
    bus.subscribe('global', () => {
      calls.push('second')
    })

    const result = bus.emit('e')

    expect(result).toEqual({ delivered: 2, failures: [] })
    expect(calls).toEqual(['first', 'second'])
  })

  it('stops delivering after unsubscribe and counts only actual deliveries', () => {
    const bus = createEventBus()
    const seen: number[] = []
    const unsubscribe = bus.subscribe<number>('global', (event) => {
      seen.push(event.payload)
    })

    bus.emit('e', 1)
    unsubscribe()
    unsubscribe()
    bus.emit('e', 2)

    expect(seen).toEqual([1])
    expect(bus.emit('e', 3).delivered).toBe(0)
  })
})

describe('events: per-listener containment', () => {
  it('runs sibling listeners when one throws mid-fan-out and contains the error', () => {
    const bus = createEventBus()
    const boom = new Error('listener exploded')
    const seen: string[] = []
    bus.subscribe<BusEvent>('global', (event) => {
      seen.push(`before:${event.type}`)
    })
    bus.subscribe('global', () => {
      throw boom
    })
    bus.subscribe<BusEvent>('global', (event) => {
      seen.push(`after:${event.type}`)
    })

    const result = bus.emit('e.tick')

    expect(seen).toEqual(['before:e.tick', 'after:e.tick'])
    expect(result.delivered).toBe(3)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.event).toEqual({ type: 'e.tick', payload: undefined, origin: {} })
    expect(result.failures[0]?.listenerId).toBe('listener-1')
    expect(result.failures[0]?.error).toBe(boom)
  })

  it('contains async handler rejections until drain instead of surfacing them as unhandled', async () => {
    const bus = createEventBus()
    const boom = new Error('continuation exploded')
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    bus.subscribe('global', async () => {
      await gate
      throw boom
    })

    expect(bus.emit('e').failures).toEqual([])
    release?.()

    const failures = await bus.drain()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.error).toBe(boom)
  })
})

describe('events: re-emit guard', () => {
  it('rejects synchronous re-emission during fan-out with a typed coded error contained per-listener', () => {
    const bus = createEventBus()
    const seen: string[] = []
    bus.subscribe('global', () => {
      bus.emit('inner')
    })
    bus.subscribe<DispatchFailure>('global', () => {
      seen.push('sibling survived')
    })

    const result = bus.emit('outer')

    expect(result.failures).toHaveLength(1)
    const failure = result.failures[0]
    expect(failure?.error).toBeInstanceOf(ReemitDuringFanoutError)
    expect((failure?.error as PandaKernelError).code).toBe('PANDA_KERNEL_REEMIT_DURING_FANOUT')
    expect((failure?.error as Error).message).toContain('must not synchronously re-emit')
    // The typed rejection stayed inside the offending listener; its sibling still ran.
    expect(seen).toEqual(['sibling survived'])
    expect(result.delivered).toBe(2)
  })

  it('allows asynchronous follow-up emission after fan-out completes', async () => {
    const bus = createEventBus()
    const seen: string[] = []
    bus.subscribe('global', (event) => {
      seen.push(event.type)
    })
    bus.subscribe<string>('global', async (event) => {
      // Follow-up emissions are legal once fan-out has drained; only synchronous
      // re-emission is forbidden. Guarded so this fires exactly once.
      if (event.type !== 'initial') return
      await flush()
      bus.emit('follow-up')
    })

    bus.emit('initial')
    await bus.drain()

    expect(seen).toEqual(['initial', 'follow-up'])
  })

  it('reports nothing left pending when drain runs on an idle bus', async () => {
    const bus = createEventBus()
    await expect(bus.drain()).resolves.toEqual([])
    expect(bus.pendingCount).toBe(0)
  })

  it('shares one in-flight drain across concurrent callers', async () => {
    const bus = createEventBus()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    bus.subscribe('global', async () => {
      await gate
    })
    bus.emit('e')

    const first = bus.drain()
    const second = bus.drain()
    expect(first).toBe(second)

    release?.()
    await Promise.all([first, second])
    expect(bus.pendingCount).toBe(0)
  })
})

describe('events: fan-out mutation guards', () => {
  it('rejects subscribing during fan-out with a typed coded error contained per-listener', () => {
    const bus = createEventBus()
    const seen: string[] = []
    bus.subscribe('global', () => {
      seen.push('original')
      bus.subscribe('global', () => {
        seen.push('latecomer')
      })
    })

    const result = bus.emit('outer')

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.error).toBeInstanceOf(ReemitDuringFanoutError)
    expect((result.failures[0]?.error as PandaKernelError).code).toBe('PANDA_KERNEL_REEMIT_DURING_FANOUT')
    // The latecomer never joined this or any later fan-out; only the original listener remains.
    expect(bus.emit('next').delivered).toBe(1)
    expect(seen).toEqual(['original', 'original'])
  })

  it('lets unsubscribes during fan-out take effect only after the current event', () => {
    const bus = createEventBus()
    const seen: string[] = []
    const unsubscribeUnsubscriber = bus.subscribe<string>('global', (event) => {
      seen.push(`unsubscriber:${event.payload}`)
      unsubscribeVictim()
    })
    const unsubscribeVictim = bus.subscribe<string>('global', (event) => {
      seen.push(`victim:${event.payload}`)
    })

    bus.emit('e', 'first')
    bus.emit('e', 'second')

    expect(seen).toEqual(['unsubscriber:first', 'victim:first', 'unsubscriber:second'])
    unsubscribeUnsubscriber()
  })
})

describe('events: emission input validation', () => {
  it('rejects non-string event types and wrong-typed origin ids with coded errors', () => {
    const bus = createEventBus()

    expect(() => bus.emit(42 as never)).toThrow(InvalidScopeError)
    expect(() => bus.emit('e', undefined, { projectId: 7 as never })).toThrow(InvalidScopeError)
    try {
      bus.emit('e', undefined, { agentId: true as never })
      expect.unreachable()
    } catch (error) {
      expect((error as InvalidScopeError).code).toBe('PANDA_KERNEL_INVALID_SCOPE')
      expect((error as InvalidScopeError).message).toContain('agentId')
    }
    try {
      bus.emit('e', undefined, { projectId: null as never })
      expect.unreachable()
    } catch (error) {
      expect((error as InvalidScopeError).message).toContain('projectId')
    }
  })
})

describe('events: invalid subscriptions', () => {
  it('rejects unknown scopes and wildcard agent bindings with typed coded errors', () => {
    const bus = createEventBus()
    const handler = () => {}

    expect(() => bus.subscribe('tenant' as never, handler)).toThrow(InvalidScopeError)
    expect(() => bus.subscribe('agent', '' as never, handler)).toThrow(InvalidScopeError)
    try {
      bus.subscribe('agent', undefined as never, handler)
      expect.unreachable()
    } catch (error) {
      expect((error as InvalidScopeError).code).toBe('PANDA_KERNEL_INVALID_SCOPE')
      expect((error as InvalidScopeError).message).toContain('no wildcards')
    }
  })
})

describe('events: drain fixed point', () => {
  it('keeps draining while continuations schedule more continuations', async () => {
    const bus = createEventBus()
    const seen: number[] = []
    bus.subscribe<number>('global', async (event) => {
      seen.push(event.payload)
      if (event.payload < 3) {
        await flush()
        bus.emit('chain', event.payload + 1)
      }
    })

    bus.emit('chain', 1)
    await bus.drain()

    expect(seen).toEqual([1, 2, 3])
  })
})
