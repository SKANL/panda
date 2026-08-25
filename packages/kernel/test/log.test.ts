import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  LogRecordInvalidError,
  createKernel,
  createLogSink,
  createMemoryLogSink,
  loadPlugins,
  type LogEntry,
  type LogRecord,
  type LogSink,
} from '../src'
import { KERNEL_EXPORTS, manifest } from './helpers'

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return { event: 'manifest.validated', subject: 'plugin-a', ...overrides }
}

/** Asserts `first` really is in the trail before asserting it precedes `second`. */
function precedes(trail: readonly string[], first: string, second: string): void {
  expect(trail).toContain(first)
  expect(trail).toContain(second)
  expect(trail.indexOf(first)).toBeLessThan(trail.indexOf(second))
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A thenable that is NOT a native promise — structurally valid for `LogWrite`. */
function foreignThenable(run: (settle: () => void, fail: () => void) => void): Promise<void> {
  return {
    then(onFulfilled?: (() => void) | null, onRejected?: ((reason: unknown) => void) | null) {
      run(
        () => onFulfilled?.(),
        () => onRejected?.(new Error('foreign write failed')),
      )
      return undefined as never
    },
  } as unknown as Promise<void>
}

describe('record shape', () => {
  it('seals an entry into a versioned, ordered record', () => {
    const log = createMemoryLogSink()
    log.record(entry({ subject: 'a' }))
    log.record(entry({ subject: 'b' }))

    expect(log.records.map((record) => record.seq)).toEqual([1, 2])
    expect(log.records[0]?.version).toBe(1)
    expect(typeof log.records[0]?.at).toBe('number')
  })

  it('has no free-form slot a secret could occupy (matrix: secrets)', () => {
    const log = createMemoryLogSink()
    log.record(entry())
    log.record({ event: 'service.resolved', subject: 'a', service: 'svc.db' })

    // Pinning the exact key set is the point: every field is an enumeration or an
    // identifier the kernel already holds. A credential has nowhere to be written.
    expect(Object.keys(log.records[0] ?? {}).sort()).toEqual(['at', 'event', 'seq', 'subject', 'version'])
    expect(Object.keys(log.records[1] ?? {}).sort()).toEqual(['at', 'event', 'seq', 'service', 'subject', 'version'])
  })

  it('builds the record from named fields, so an unknown one cannot reach it even unreported', () => {
    const log = createMemoryLogSink()
    // The throw below is a diagnostic for the caller. What actually protects the
    // record is that `seal` copies named fields only — proven here by a key the
    // unknown-field scan cannot see (Object.keys skips inherited and symbol keys)
    // yet which still never lands.
    const inherited = Object.create({ payload: 'sk-live-inherited' }) as Record<string, unknown>
    inherited['event'] = 'manifest.validated'
    inherited['subject'] = 'a'
    log.record(inherited as unknown as LogEntry)

    expect(Object.keys(log.records[0] ?? {}).sort()).toEqual(['at', 'event', 'seq', 'subject', 'version'])
    expect(JSON.stringify(log.records)).not.toContain('sk-live-inherited')
  })

  it('rejects an unknown field with a coded error naming it (matrix: closed record shape)', () => {
    const log = createMemoryLogSink()
    const smuggled = { ...entry(), payload: 'sk-live-supersecret' } as unknown as LogEntry

    expect(() => log.record(smuggled)).toThrow(LogRecordInvalidError)
    try {
      log.record(smuggled)
      expect.unreachable()
    } catch (error) {
      expect((error as { code: string }).code).toBe('PANDA_KERNEL_LOG_RECORD_INVALID')
      expect((error as LogRecordInvalidError).field).toBe('payload')
      expect((error as Error).message).toContain('payload')
    }
    expect(log.records).toEqual([])
  })

  it('rejects an unknown event, an empty subject, an unknown code, and a stray service', () => {
    const log = createMemoryLogSink()

    expect(() => log.record(entry({ event: 'plugin.exploded' as LogEntry['event'] }))).toThrow(LogRecordInvalidError)
    expect(() => log.record(entry({ subject: '  ' }))).toThrow(LogRecordInvalidError)
    expect(() => log.record(entry({ code: 'PANDA_REGISTRY_INACTIVE' as LogEntry['code'] }))).toThrow(LogRecordInvalidError)
    // `service` on a non-service event would turn it into a second free-form string slot.
    expect(() => log.record(entry({ service: 'svc.db' }))).toThrow(LogRecordInvalidError)
    expect(log.records).toEqual([])
  })

  it('rejects an identifier that could forge a second record or exhaust the sink', () => {
    const log = createMemoryLogSink()
    // Readers join fields into one line, so a newline in a plugin id would print
    // as an extra record that the kernel never wrote.
    expect(() => log.record(entry({ subject: 'a\nplugin.activated:ghost' }))).toThrow(LogRecordInvalidError)
    expect(() => log.record(entry({ subject: 'a\u0000b' }))).toThrow(LogRecordInvalidError)
    expect(() => log.record(entry({ subject: 'x'.repeat(201) }))).toThrow(LogRecordInvalidError)
    expect(() => log.record({ event: 'service.resolved', subject: 'a', service: 'svc\r\n.db' })).toThrow(
      LogRecordInvalidError,
    )
    expect(log.records).toEqual([])

    // The boundary itself is accepted, and the stored value is trimmed.
    log.record(entry({ subject: `  ${'x'.repeat(200)}  ` }))
    expect(log.records[0]?.subject).toBe('x'.repeat(200))
  })

  it('is append-only at runtime, not only in the type (matrix: never mutated or reordered)', () => {
    const log = createMemoryLogSink()
    log.record(entry({ subject: 'a' }))
    log.record(entry({ subject: 'b' }))

    // `readonly` is erased at runtime, so the sink hands out a copy...
    const stolen = log.records as LogRecord[]
    stolen.reverse()
    stolen.length = 0
    stolen.push({ ...entry({ subject: 'forged' }), version: 1, seq: 99, at: 0 })
    expect(log.records.map((record) => record.subject)).toEqual(['a', 'b'])

    // ...and each record is frozen, so a held reference cannot be rewritten.
    const record = log.records[0] as { subject: string }
    expect(() => {
      record.subject = 'rewritten'
    }).toThrow(TypeError)
    expect(log.records[0]?.subject).toBe('a')
  })

  it('does not advance the sequence for a rejected entry, so a gap always means a lost write', () => {
    const log = createMemoryLogSink()
    expect(() => log.record(entry({ subject: '' }))).toThrow(LogRecordInvalidError)
    log.record(entry())
    expect(log.records[0]?.seq).toBe(1)
  })
})

describe('ordering guarantee (matrix: the log exists before any plugin loads)', () => {
  it('pins the load path to exactly two parameters, the second a sink', () => {
    // The type-level pin is the guarantee. Unlike a @ts-expect-error directive it
    // cannot be satisfied by an unrelated error appearing on the same line, and it
    // fails whether the sink is made optional, defaulted, or removed.
    expectTypeOf(loadPlugins).parameters.toEqualTypeOf<[readonly unknown[], LogSink]>()
  })

  it('has no overload that loads without a log', () => {
    // Kept alongside the pin above: this is the exact shape a future contributor
    // reaches for, and TS2578 catches `log?: LogSink` and `log: LogSink = ...` too.
    // @ts-expect-error the sink is a required parameter of the load path (AD-4).
    const omitted = () => loadPlugins([manifest()])
    expect(omitted).toBeTypeOf('function')
  })

  it('pins the exported surface so a second load entry point cannot slip in', async () => {
    // The parameter pins guard ONE function's arity. Adding `loadPluginsUnlogged`
    // beside it, or re-exporting a lower-level loader, would satisfy every
    // assertion above while restoring exactly the hole AD-4 closes.
    const surface = await import('../src')
    expect(Object.keys(surface).sort()).toEqual(KERNEL_EXPORTS)
  })

  it('records the first manifest validation before anything else happens', () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'a' }), () => ({ status: 'activated' }))
    kernel.start()

    expect(log.records[0]).toMatchObject({ seq: 1, event: 'manifest.validated', subject: 'a' })
  })

  it('records a rejected manifest by position when its id is not trustworthy', () => {
    const log = createMemoryLogSink()
    expect(() => loadPlugins([manifest({ id: 'good' }), { nonsense: true }], log)).toThrow()

    expect(log.records.map((record) => `${record.event}:${record.subject}`)).toEqual([
      'manifest.validated:good',
      'manifest.rejected:#1',
      'load.rejected:kernel',
    ])
    expect(log.records[1]?.code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
  })

  it('locates a manifest by position when its id would itself be unrecordable', () => {
    const log = createMemoryLogSink()
    // A hostile id must not make its own rejection record vanish.
    expect(() => loadPlugins([{ id: 'a\nplugin.activated:ghost' }], log)).toThrow()

    expect(log.records.map((record) => `${record.event}:${record.subject}`)).toEqual([
      'manifest.rejected:#0',
      'load.rejected:kernel',
    ])
  })

  it('records the code that was actually thrown, not an assumed one', () => {
    const log = createMemoryLogSink()
    const hostile = {
      get id(): string {
        throw new RangeError('exploding getter')
      },
    }
    expect(() => loadPlugins([hostile], log)).toThrow(RangeError)

    // A RangeError is not a validation failure; recording it as one would put a
    // rejection in the stream that never happened.
    expect(log.records[0]).toMatchObject({ event: 'manifest.rejected', subject: '#0' })
    expect(log.records[0]?.code).toBeUndefined()
  })

  it('records a load rejected for a service conflict', () => {
    const log = createMemoryLogSink()
    expect(() =>
      loadPlugins([manifest({ id: 'first', provides: ['svc.dup'] }), manifest({ id: 'second', provides: ['svc.dup'] })], log),
    ).toThrow()

    expect(log.records.at(-1)).toMatchObject({
      event: 'load.rejected',
      subject: 'kernel',
      code: 'PANDA_KERNEL_SERVICE_CONFLICT',
    })
  })

  it('records service resolution outcomes and exactly one unready record', () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'provider', provides: ['svc.db'] }), () => ({
      status: 'activated',
      services: { 'svc.db': 1 },
      dispose: () => {},
    }))
    kernel.register(
      manifest({
        id: 'consumer',
        consumes: [
          { service: 'svc.db', mode: 'hard' },
          { service: 'svc.gone', mode: 'hard' },
        ],
      }),
      () => ({ status: 'activated' }),
    )
    kernel.start()

    expect(log.records.map((record) => `${record.event}:${record.subject}:${record.service ?? ''}`)).toEqual([
      'manifest.validated:provider:',
      'manifest.validated:consumer:',
      'service.resolved:consumer:svc.db',
      'service.unresolved:consumer:svc.gone',
      // Exactly one: the loader decides readiness, so start() must not record it
      // a second time and make the stream claim the plugin failed twice.
      'plugin.unready:consumer:',
      'plugin.activated:provider:',
    ])
  })

  it('does not duplicate load records when start is called again', () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'a', consumes: [{ service: 'svc.gone', mode: 'soft' }] }), () => ({
      status: 'activated',
    }))

    kernel.start()
    kernel.start()

    // start() is legally repeatable and re-runs the load path, but a reader must
    // not see the same manifest validated twice for one plugin.
    const counted = (event: string) => log.records.filter((record) => record.event === event).length
    expect(counted('manifest.validated')).toBe(1)
    expect(counted('service.unresolved')).toBe(1)
    expect(counted('plugin.activated')).toBe(1)
  })

  it('records a registration rejected before it can ever reach the load path', () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })

    expect(() => kernel.register({ id: 'broken' }, () => ({ status: 'activated' }))).toThrow()

    // The manifest never reaches loadPlugins, so without this the rejected
    // registration would reconstruct as "nothing happened".
    expect(log.records).toHaveLength(1)
    expect(log.records[0]).toMatchObject({ event: 'manifest.rejected', subject: 'broken' })
    expect(log.records[0]?.code).toBe('PANDA_KERNEL_MANIFEST_INVALID')
  })
})

describe('lifecycle reconstruction (matrix: records alone reproduce the transition order)', () => {
  it('reproduces load, activation and disposal order from the records alone', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'provider', provides: ['svc.db'] }), () => ({
      status: 'activated',
      services: { 'svc.db': {} },
      dispose: () => {},
    }))
    kernel.register(manifest({ id: 'consumer', consumes: [{ service: 'svc.db', mode: 'hard' }] }), () => ({
      status: 'activated',
    }))

    kernel.start()
    await kernel.stop()
    await log.drain()

    expect(log.records.map((record) => `${record.event}:${record.subject}`)).toEqual([
      'manifest.validated:provider',
      'manifest.validated:consumer',
      'service.resolved:consumer',
      'plugin.activated:provider',
      'plugin.activated:consumer',
      // Reverse activation order, exactly as AD-8 requires of teardown.
      'plugin.disposed:consumer',
      'plugin.disposed:provider',
      'kernel.stopped:kernel',
    ])
    expect(log.records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('records a contained activation failure and a swap', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'ok', provides: ['svc.a'] }), () => ({
      status: 'activated',
      services: { 'svc.a': 1 },
      dispose: () => {},
    }))
    kernel.register(manifest({ id: 'broken' }), () => {
      throw new Error('boom')
    })

    kernel.start()
    kernel.swap('ok', () => ({ status: 'activated', services: { 'svc.a': 2 }, dispose: () => {} }))
    await kernel.stop()

    const transitions = log.records
      .filter((record) => record.event.startsWith('plugin.') || record.event === 'kernel.stopped')
      .map((record) => `${record.event}:${record.subject}`)
    expect(transitions).toEqual([
      'plugin.activated:ok',
      'plugin.start-failed:broken',
      'plugin.swapped:ok',
      'plugin.disposed:ok',
      'kernel.stopped:kernel',
    ])
    expect(log.records.find((record) => record.event === 'plugin.start-failed')?.code).toBe(
      'PANDA_KERNEL_PLUGIN_START_FAILED',
    )
  })

  it('records a rejected swap and never a plugin.swapped for it', () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'p', provides: ['svc.p'] }), () => ({
      status: 'activated',
      services: { 'svc.p': 1 },
      dispose: () => {},
    }))
    kernel.start()

    expect(() => kernel.swap('p', () => ({ status: 'rejected', issues: ['nope'] }))).toThrow()
    expect(() => kernel.swap('ghost', () => ({ status: 'activated' }))).toThrow()

    const swaps = log.records.filter((record) => record.event.startsWith('plugin.swap'))
    expect(swaps.map((record) => `${record.event}:${record.subject}:${record.code ?? ''}`)).toEqual([
      'plugin.swap-rejected:p:PANDA_KERNEL_SWAP_REJECTED',
      'plugin.swap-rejected:ghost:PANDA_KERNEL_PLUGIN_INACTIVE',
    ])
    // The previous implementation is still serving; nothing swapped.
    expect(log.records.some((record) => record.event === 'plugin.swapped')).toBe(false)
  })

  it('distinguishes a disposer that threw from one that did not', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'clean', provides: ['svc.a'] }), () => ({
      status: 'activated',
      services: { 'svc.a': 1 },
      dispose: () => {},
    }))
    kernel.register(manifest({ id: 'angry', provides: ['svc.b'] }), () => ({
      status: 'activated',
      services: { 'svc.b': 1 },
      dispose: () => {
        throw new Error('teardown exploded')
      },
    }))
    kernel.start()

    const stopped = await kernel.stop()
    expect(stopped.disposalErrors.map((failure) => failure.pluginId)).toEqual(['angry'])
    // Recording `plugin.disposed` for a disposer that threw would make the stream
    // assert something the result object contradicts.
    expect(log.records.filter((record) => record.event.startsWith('plugin.dispos')).map((r) => `${r.event}:${r.subject}`)).toEqual([
      'plugin.disposal-failed:angry',
      'plugin.disposed:clean',
    ])
  })
})

describe('failure policy (matrix: sink write fails / degraded then recovered)', () => {
  it('degrades, counts every drop exactly, and keeps the kernel running', async () => {
    const log = createLogSink(() => {
      throw new Error('disk full')
    })
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'a' }), () => ({ status: 'activated' }))

    expect(kernel.start().started).toEqual(['a'])
    // Exact, not `> 0`: manifest.validated + plugin.activated. A count that only
    // has to be positive is satisfied by a boolean wearing a number's clothes.
    expect(log.state).toEqual({ status: 'degraded', dropped: 2, everDegraded: true, pending: 0 })

    await kernel.stop()
    // + plugin.disposed + kernel.stopped. Every record the run produced is
    // accounted for, which is the difference between a count and a flag.
    expect(log.state.dropped).toBe(4)
  })

  it('counts each of many drops (a boolean could not)', () => {
    const log = createLogSink(() => {
      throw new Error('disk full')
    })
    for (let index = 0; index < 5; index += 1) log.record(entry({ subject: `p-${index}` }))
    expect(log.state.dropped).toBe(5)
  })

  it('never throws a write failure at the caller, sync or async', async () => {
    const sync = createLogSink(() => {
      throw new Error('nope')
    })
    const deferred = createLogSink(() => Promise.reject(new Error('nope')))

    expect(() => sync.record(entry())).not.toThrow()
    expect(() => deferred.record(entry())).not.toThrow()
    await expect(deferred.drain()).resolves.toBeUndefined()
    expect(deferred.state.dropped).toBe(1)
  })

  it('reports recovery without erasing that it degraded', () => {
    const written: LogRecord[] = []
    let failing = true
    const log = createLogSink((record) => {
      if (failing) throw new Error('disk full')
      written.push(record)
    })

    log.record(entry({ subject: 'lost' }))
    expect(log.state).toEqual({ status: 'degraded', dropped: 1, everDegraded: true, pending: 0 })

    failing = false
    log.record(entry({ subject: 'kept' }))
    expect(log.state).toEqual({ status: 'healthy', dropped: 1, everDegraded: true, pending: 0 })
    expect(written.map((record) => record.subject)).toEqual(['kept'])
    // The gap in seq is the loss signal that survives the process, since `dropped`
    // lives only in memory.
    expect(written.map((record) => record.seq)).toEqual([2])
  })

  it('reports pending so a caller can tell "nothing lost" from "not settled yet"', async () => {
    const log = createLogSink(() => Promise.reject(new Error('disk full')))
    log.record(entry({ subject: 'a' }))
    log.record(entry({ subject: 'b' }))

    // Before settlement the two records are neither written nor counted; `pending`
    // is what stops the state from reading as a clean bill of health.
    expect(log.state).toMatchObject({ status: 'healthy', dropped: 0, pending: 2 })

    await log.drain()
    expect(log.state).toEqual({ status: 'degraded', dropped: 2, everDegraded: true, pending: 0 })
  })
})

describe('serialised writes (matrix: concurrent records)', () => {
  it('lands both records in emission order without interleaving them', async () => {
    const steps: string[] = []
    const log = createLogSink(async (record) => {
      steps.push(`start:${record.seq}`)
      // The first write is deliberately the slow one: without serialisation the
      // second would open before the first closed.
      await new Promise((resolve) => setTimeout(resolve, record.seq === 1 ? 20 : 0))
      steps.push(`end:${record.seq}`)
    })

    log.record(entry({ subject: 'a' }))
    log.record(entry({ subject: 'b' }))
    await log.drain()

    expect(steps).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
  })

  it('serialises, counts and drains a thenable that is not a native promise', async () => {
    const steps: string[] = []
    const pendingSettlers: (() => void)[] = []
    const log = createLogSink((record) =>
      foreignThenable((settle, fail) => {
        steps.push(`start:${record.seq}`)
        pendingSettlers.push(record.seq === 1 ? fail : settle)
      }),
    )

    log.record(entry({ subject: 'a' }))
    log.record(entry({ subject: 'b' }))
    // Both writes are already queued; adopting a foreign thenable is scheduled,
    // so the first one opens on the next tick rather than synchronously.
    expect(log.state.pending).toBe(2)
    await tick()

    // `instanceof Promise` here would treat both writes as completed synchronous
    // ones: they would run concurrently, drain would claim quiescence, and a
    // failure would leave the state reading healthy with nothing dropped.
    expect(steps).toEqual(['start:1'])

    pendingSettlers.shift()?.()
    await tick()
    expect(steps).toEqual(['start:1', 'start:2'])
    pendingSettlers.shift()?.()
    await log.drain()

    expect(log.state).toEqual({ status: 'healthy', dropped: 1, everDegraded: true, pending: 0 })
  })

  it('drains records emitted while a drain is already running', async () => {
    const written: number[] = []
    const log = createLogSink(async (record) => {
      await Promise.resolve()
      written.push(record.seq)
    })

    log.record(entry())
    const draining = log.drain()
    log.record(entry())
    await draining

    expect(written).toEqual([1, 2])
  })
})

describe('disposal (matrix: pending record writes drain before disposers run)', () => {
  it('settles every pending write before the first disposer executes', async () => {
    const steps: string[] = []
    const log = createLogSink(async (record) => {
      await Promise.resolve()
      steps.push(`record:${record.event}:${record.subject}`)
    })
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'a', provides: ['svc.a'] }), () => ({
      status: 'activated',
      services: { 'svc.a': 1 },
      dispose: () => steps.push('dispose:a'),
    }))

    kernel.start()
    await kernel.stop()

    precedes(steps, 'record:plugin.activated:a', 'dispose:a')
    // stop() resolves quiescent: the teardown records are already written.
    expect(steps.at(-1)).toBe('record:kernel.stopped:kernel')
    expect(kernel.log.state.pending).toBe(0)
  })

  it('applies the same rule to a single-plugin dispose and lands its record', async () => {
    const steps: string[] = []
    const log = createLogSink(async (record) => {
      await Promise.resolve()
      steps.push(`record:${record.event}`)
    })
    const kernel = createKernel({ log })
    kernel.register(manifest({ id: 'a', provides: ['svc.a'] }), () => ({
      status: 'activated',
      services: { 'svc.a': 1 },
      dispose: () => steps.push('dispose:a'),
    }))

    kernel.start()
    await kernel.dispose('a')

    precedes(steps, 'record:plugin.activated', 'dispose:a')
    // dispose() resolves with its own record already written, exactly as stop() does.
    expect(steps.at(-1)).toBe('record:plugin.disposed')
    expect(log.state.pending).toBe(0)
  })

  it('contains a throwing disposer so the plugin is not disposed twice', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log })
    let disposals = 0
    kernel.register(manifest({ id: 'a', provides: ['svc.a'] }), () => ({
      status: 'activated',
      services: { 'svc.a': 1 },
      dispose: () => {
        disposals += 1
        throw new Error('teardown exploded')
      },
    }))
    kernel.start()

    await expect(kernel.dispose('a')).resolves.toBeUndefined()
    await kernel.stop()

    expect(disposals).toBe(1)
    expect(log.records.filter((record) => record.event.startsWith('plugin.dispos'))).toHaveLength(1)
    expect(log.records.find((record) => record.event.startsWith('plugin.dispos'))?.event).toBe('plugin.disposal-failed')
  })
})

describe('kernel ownership of the stream', () => {
  it('hands out the records without the write end', () => {
    const kernel = createKernel()
    kernel.register(manifest({ id: 'a' }), () => ({ status: 'activated' }))
    kernel.start()

    // A plugin holding the kernel must not be able to append `plugin.activated`
    // for a plugin that never loaded — the reconstruction claim depends on the
    // kernel being the only writer.
    expect((kernel.log as Partial<LogSink>).record).toBeUndefined()
    expect(kernel.log.records?.map((record) => record.event)).toEqual(['manifest.validated', 'plugin.activated'])
  })
})
