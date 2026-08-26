import { describe, expect, it } from 'vitest'
import {
  ActionInvalidError,
  BudgetExceededError,
  LogRecordInvalidError,
  createActionPipeline,
  createMemoryLogSink,
} from '../src'
import type { ActionDefinition, ActionPolicy, LogEntry, MemoryLogSink } from '../src'

// Cost settlement (Story M3.C): an action is admitted on a declared estimate and
// reconciled against what its operation turned out to cost, with every later cap
// enforced on the settled total.
//
// The clause that matters most is the FIRST one. Before this story a cost cap and
// an invocation cap could not refuse on different runs — with one action of cost 1
// they were the same cap wearing two names, and a reviewer measured `maxTotalCost`
// of 0 and of 0.5 to be indistinguishable. Everything else here exists to make
// that discrimination trustworthy rather than accidental.

/** A budget that never bites, so the RECORDS can be asserted without a refusal. */
const AUDITED: ActionPolicy = { maxTotalCost: 1_000_000 }

function pipelineWith(policy?: ActionPolicy): {
  log: MemoryLogSink
  pipeline: ReturnType<typeof createActionPipeline>
} {
  const log = createMemoryLogSink()
  return { log, pipeline: createActionPipeline(log, policy) }
}

function trailOf(log: MemoryLogSink): string[] {
  return log.records.map(
    (record) =>
      `${record.event}${record.cost === undefined ? '' : `=${record.cost}`}${record.code === undefined ? '' : `:${record.code}`}`,
  )
}

/** Resolves only when `release()` is called, so two invocations genuinely overlap. */
function suspended<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe('the caps stop being one boolean (matrix: caps stay distinguishable)', () => {
  it('lets a cost cap and an invocation cap refuse on DIFFERENT runs, each naming its own code', async () => {
    // Two pipelines, one policy shape, one action shape. The ONLY difference is
    // what the operation reports having spent — which is exactly the axis that did
    // not exist before settlement, and the reason this is a discrimination rather
    // than a restatement.
    const policy = { maxInvocations: 3, maxTotalCost: 100 }

    const expensive = pipelineWith(policy)
    const cheap = pipelineWith(policy)
    const register = (
      pipeline: ReturnType<typeof createActionPipeline>,
      id: string,
      spend: number,
    ): ReturnType<typeof pipeline.register<number>> =>
      pipeline.register<number>({ id, cost: 1, run: () => spend, settle: (value) => value })

    // Expensive: one run settles past the COST cap while the invocation count is
    // still 1 of 3, so the second run is refused on cost.
    const big = register(expensive.pipeline, 'act.big', 100)
    await expect(big.invoke()).resolves.toBe(100)
    await expect(register(expensive.pipeline, 'act.big-2', 100).invoke()).rejects.toMatchObject({
      code: 'PANDA_KERNEL_COST_CAP_EXCEEDED',
      cap: 'cost',
    })
    expect(expensive.pipeline.usage).toEqual({ invocations: 1, totalCost: 100, concurrent: 0 })

    // Cheap: three runs settle to 1 each, nowhere near the 100-token cost cap, and
    // the fourth is refused on INVOCATIONS. Same policy, different refusal, and
    // the total proves the cost cap was never the one that fired.
    for (const index of [1, 2, 3]) await register(cheap.pipeline, `act.small-${index}`, 1).invoke()
    await expect(register(cheap.pipeline, 'act.small-4', 1).invoke()).rejects.toMatchObject({
      code: 'PANDA_KERNEL_INVOCATION_CAP_EXCEEDED',
      cap: 'invocations',
    })
    expect(cheap.pipeline.usage).toEqual({ invocations: 3, totalCost: 3, concurrent: 0 })
  })

  it('still refuses BEFORE the operation runs, which is what makes a cap a cap', async () => {
    const { pipeline } = pipelineWith({ maxTotalCost: 100 })
    let spawned = 0
    const exhaust = pipeline.register<number>({
      id: 'act.exhaust',
      cost: 1,
      run: () => {
        spawned += 1
        return 100
      },
      settle: (value) => value,
    })
    await exhaust.invoke()
    expect(spawned).toBe(1)

    const next = pipeline.register<number>({
      id: 'act.next',
      cost: 1,
      run: () => {
        spawned += 1
        return 1
      },
      settle: (value) => value,
    })
    await expect(next.invoke()).rejects.toBeInstanceOf(BudgetExceededError)
    // Nothing ran. A budget that admits everything and complains afterwards has
    // capped nothing, so the settled total has to feed the UP-FRONT refusal.
    expect(spawned).toBe(1)
  })
})

describe('settlement changes the total, by execution', () => {
  it('replaces the estimate with the reported figure and records both numbers', async () => {
    const { log, pipeline } = pipelineWith(AUDITED)
    const action = pipeline.register<number>({
      id: 'act.reported',
      cost: 2,
      run: () => 4096,
      settle: (value) => value,
    })

    await action.invoke()

    expect(pipeline.usage.totalCost).toBe(4096)
    expect(trailOf(log)).toEqual([
      'action.invoked',
      'action.estimated=2',
      'action.settled=4096',
      'action.completed',
    ])
  })

  it('charges the estimate exactly once, never the estimate plus the settlement', async () => {
    const { pipeline } = pipelineWith(AUDITED)
    await pipeline.register<number>({ id: 'act.once', cost: 5, run: () => 5, settle: (value) => value }).invoke()
    // 5, not 10. The settlement is a DELTA against what the invocation stands
    // charged; adding it beside the estimate is the double charge the matrix forbids.
    expect(pipeline.usage.totalCost).toBe(5)
  })

  it('leaves the estimate standing when nothing observed the run', async () => {
    const { log, pipeline } = pipelineWith(AUDITED)
    await pipeline
      .register<number>({ id: 'act.unreported', cost: 3, run: () => 1, settle: () => undefined })
      .invoke()

    // Charged its estimate — never silently zero — and the stream says what it was
    // admitted at, so the total is still reconstructable from the records alone.
    expect(pipeline.usage.totalCost).toBe(3)
    expect(trailOf(log)).toEqual(['action.invoked', 'action.estimated=3', 'action.completed'])
  })

  it('reconstructs the total EXACTLY from the record stream alone', async () => {
    // The auditability clause, and it is arithmetic rather than a vibe: a reader
    // takes `action.settled` where a subject has one and `action.estimated` where
    // it does not. Measured before the estimate moved to admission: three actions
    // reconstructed to 59845 against an actual 59852 — the gap was exactly the
    // estimate of the action nothing observed, charged permanently and appearing
    // nowhere in the stream.
    const { log, pipeline } = pipelineWith(AUDITED)
    await pipeline.register<number>({ id: 'act.one', cost: 1, run: () => 59_842, settle: (v) => v }).invoke()
    await pipeline.register<number>({ id: 'act.two', cost: 7, run: () => 1, settle: () => undefined }).invoke()
    await pipeline.register<number>({ id: 'act.three', cost: 3, run: () => 1, settle: () => Number.NaN }).invoke()

    const charged = new Map<string, number>()
    for (const record of log.records) {
      if (record.event === 'action.estimated' && record.cost !== undefined) charged.set(record.subject, record.cost)
      if (record.event === 'action.settled' && record.cost !== undefined) charged.set(record.subject, record.cost)
    }
    expect([...charged.values()].reduce((total, part) => total + part, 0)).toBe(pipeline.usage.totalCost)
    expect(pipeline.usage.totalCost).toBe(59_842 + 7 + 3)
  })

  it('records nothing extra on a pipeline with no budget configured', async () => {
    // Behaviour neutrality, and it is the reason the records are policy-gated:
    // the frozen promise is that a run with no policy set behaves exactly as it
    // did before this story, and three pre-existing clauses pin this exact
    // sequence for an executor run.
    const { log, pipeline } = pipelineWith()
    await pipeline.register<number>({ id: 'act.free', cost: 1, run: () => 4096, settle: (v) => v }).invoke()
    expect(trailOf(log)).toEqual(['action.invoked', 'action.completed'])
    // Silent, but not unaccounted: the charge is still the settled figure.
    expect(pipeline.usage.totalCost).toBe(4096)
  })
})

describe('a settlement may raise a charge and never lower it', () => {
  it('floors an under-report at the estimate, so a reported zero cannot make a run free', async () => {
    // Measured three ways before the floor: 25 runs admitted under
    // `maxTotalCost: 1`; 20 real process spawns under a cap of 2; and the one that
    // makes it urgent — `claude` on an unauthenticated machine prints an all-zero
    // usage object, so a cost cap did not survive a developer being logged out.
    const { pipeline } = pipelineWith({ maxTotalCost: 2 })
    const free = pipeline.register<number>({ id: 'act.free-lunch', cost: 1, run: () => 0, settle: (v) => v })
    await expect(free.invoke()).resolves.toBe(0)
    expect(pipeline.usage.totalCost).toBe(1)

    const second = pipeline.register<number>({ id: 'act.free-lunch-2', cost: 1, run: () => 0, settle: (v) => v })
    await expect(second.invoke()).resolves.toBe(0)
    expect(pipeline.usage.totalCost).toBe(2)

    // The cap is genuinely reached, which a self-zeroing settlement would prevent
    // for ever.
    const third = pipeline.register<number>({ id: 'act.free-lunch-3', cost: 1, run: () => 0, settle: (v) => v })
    await expect(third.invoke()).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('keeps an over-estimate charged at the estimate rather than refunding it', async () => {
    const { log, pipeline } = pipelineWith(AUDITED)
    await pipeline
      .register<number>({ id: 'act.overestimated', cost: 1000, run: () => 7, settle: (value) => value })
      .invoke()
    // 1000, not 7. The estimate is the declarer's own number, so a declarer that
    // wants a low floor declares one honestly; over-charging is the fail-closed
    // direction where under-charging is the hole.
    expect(pipeline.usage.totalCost).toBe(1000)
    expect(trailOf(log)).toContain('action.settled=1000')
  })
})

describe('a cap is not evadable by failing (matrix: cancelled or failed run)', () => {
  it('keeps the estimate charged when the operation throws, and settles nothing', async () => {
    const { log, pipeline } = pipelineWith({ maxTotalCost: 10 })
    const boom = new Error('the executor died')
    const action = pipeline.register<number>({
      id: 'act.doomed',
      cost: 10,
      run: () => {
        throw boom
      },
      settle: () => 0,
    })

    await expect(action.invoke()).rejects.toBe(boom)
    // 10, not 0: `settle` here would gladly price the failure at nothing, and it
    // never gets the chance, because a run that resolved no value produced no
    // figure. Failing is not a discount.
    expect(pipeline.usage.totalCost).toBe(10)
    expect(trailOf(log)).toEqual(['action.invoked', 'action.estimated=10', 'action.failed'])
    await expect(
      pipeline.register<number>({ id: 'act.after', cost: 1, run: () => 1, settle: (value) => value }).invoke(),
    ).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('settles a run that RESOLVED a failure result, because the vendor still spent it', async () => {
    // The executor adapter's failure path resolves an envelope rather than
    // throwing, and that envelope carries whatever the vendor reported spending
    // before it gave up. That spend is real and gets charged.
    const { pipeline } = pipelineWith(AUDITED)
    await pipeline
      .register<{ status: string; spent: number }>({
        id: 'act.failed-envelope',
        cost: 1,
        run: () => ({ status: 'failed', spent: 812 }),
        settle: (value) => value.spent,
      })
      .invoke()
    expect(pipeline.usage.totalCost).toBe(812)
  })
})

describe('junk figures (matrix: vendor figure is junk)', () => {
  const junk: readonly (readonly [string, unknown])[] = [
    ['negative', -1000],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a string', '4096'],
    ['null', null],
    ['an object', { tokens: 4096 }],
    ['absurdly large', Number.MAX_SAFE_INTEGER + 1000],
  ]

  it.each(junk)('rejects %s coded, leaves the estimate standing, and charges nothing twice', async (_label, value) => {
    const { log, pipeline } = pipelineWith(AUDITED)
    const action = pipeline.register<number>({
      id: 'act.junk',
      cost: 6,
      run: () => 1,
      settle: () => value as number | undefined,
    })

    // The RUN still succeeds: the operation already happened, and turning a
    // completed action into a failed one over its accounting loses the work too.
    await expect(action.invoke()).resolves.toBe(1)
    expect(pipeline.usage.totalCost).toBe(6)
    expect(trailOf(log)).toEqual([
      'action.invoked',
      'action.estimated=6',
      'action.settle-rejected:PANDA_KERNEL_SETTLEMENT_INVALID',
      'action.completed',
    ])
  })

  it('contains a settle that throws, and reports it under the same code', async () => {
    const { log, pipeline } = pipelineWith(AUDITED)
    const action = pipeline.register<number>({
      id: 'act.hostile-settle',
      cost: 6,
      run: () => 1,
      settle: () => {
        throw new Error('the observer exploded')
      },
    })

    await expect(action.invoke()).resolves.toBe(1)
    expect(pipeline.usage.totalCost).toBe(6)
    expect(trailOf(log)).toContain('action.settle-rejected:PANDA_KERNEL_SETTLEMENT_INVALID')
  })

  it('rejects a non-function settle at REGISTRATION, not silently at settlement', async () => {
    const { pipeline } = pipelineWith()
    expect(() =>
      pipeline.register({ id: 'act.bad-settle', cost: 1, run: () => 1, settle: 4096 as unknown as () => number }),
    ).toThrow(ActionInvalidError)
  })
})

describe('concurrency (matrix: two in-flight actions settling out of order)', () => {
  it('totals correctly regardless of which one settles first', async () => {
    const { pipeline } = pipelineWith({ maxConcurrent: 2, maxTotalCost: 10_000 })
    const first = suspended<number>()
    const second = suspended<number>()

    const a = pipeline.register<number>({
      id: 'act.a',
      cost: 10,
      run: () => first.promise,
      settle: (value) => value,
    })
    const b = pipeline.register<number>({
      id: 'act.b',
      cost: 10,
      run: () => second.promise,
      settle: (value) => value,
    })

    const runA = a.invoke()
    const runB = b.invoke()
    // Both admitted on their ESTIMATES while both are still in flight, because a
    // figure that does not exist yet cannot be enforced against.
    expect(pipeline.usage).toEqual({ invocations: 2, totalCost: 20, concurrent: 2 })

    // Settle in the REVERSE of the admission order.
    second.release(500)
    await runB
    expect(pipeline.usage.totalCost).toBe(510)

    first.release(25)
    await runA
    // 525, not 510 and not 535: each invocation applied its own delta against its
    // own estimate, and a sum does not care in which order its terms arrive.
    expect(pipeline.usage).toEqual({ invocations: 2, totalCost: 525, concurrent: 0 })
  })

  it('has the settled total in place before the next admission decides', async () => {
    const { pipeline } = pipelineWith({ maxTotalCost: 100 })
    const gate = suspended<number>()
    const heavy = pipeline.register<number>({
      id: 'act.heavy',
      cost: 1,
      run: () => gate.promise,
      settle: (value) => value,
    })
    const next = pipeline.register<number>({ id: 'act.queued', cost: 1, run: () => 1, settle: (value) => value })

    const running = heavy.invoke()
    // Queued behind the settlement: this only refuses if the settled total landed
    // before `admit()` read it, which is why settlement runs before the slot is
    // released rather than after the action resolves to its caller.
    const queued = running.then(() => next.invoke())
    gate.release(100)
    await running
    await expect(queued).rejects.toBeInstanceOf(BudgetExceededError)
  })

  it('refuses an admission re-entered from inside a settlement, against a stale total', async () => {
    // Measured before the guard: cap 100, the outer run settles 100, and an
    // `invoke()` re-entered synchronously from inside `settle` was admitted
    // against the PRE-settlement total, ending at `{invocations: 2, totalCost: 101}`.
    const { pipeline } = pipelineWith({ maxTotalCost: 100 })
    let nested: unknown
    const inner = pipeline.register<number>({ id: 'act.inner', cost: 1, run: () => 1, settle: (v) => v })
    const outer = pipeline.register<number>({
      id: 'act.outer',
      cost: 1,
      run: () => 100,
      settle: (value) => {
        nested = inner.invoke().catch((error: unknown) => error)
        return value
      },
    })

    await outer.invoke()
    await expect(nested).resolves.toMatchObject({ code: 'PANDA_KERNEL_SETTLEMENT_IN_PROGRESS' })
    expect(pipeline.usage).toEqual({ invocations: 1, totalCost: 100, concurrent: 0 })
  })
})

describe('who may settle', () => {
  it('gives the caller of an action no way to price its own run', async () => {
    // The security half, and the same rule M3.B settled for the estimate after a
    // reviewer found the mounting caller could mutate its cost to zero: the
    // DECLARER supplies `cost`, `run` and `settle` together and they are read once
    // at registration; the INVOKER — whose spend is what a cap bounds — is handed
    // a frozen handle with a nullary `invoke` and nothing else.
    const { pipeline } = pipelineWith()
    const handle = pipeline.register<number>({
      id: 'act.frozen-handle',
      cost: 9,
      run: () => 9,
      settle: (value) => value,
    })
    expect(Object.keys(handle).sort()).toEqual(['id', 'invoke'])
    expect(Object.isFrozen(handle)).toBe(true)
    expect(handle.invoke.length).toBe(0)
    expect(JSON.stringify(handle)).toBe('{"id":"act.frozen-handle"}')

    // And a definition object mutated after registration changes nothing, because
    // `settle` was read once alongside `run`.
    const definition = { id: 'act.mutated', cost: 4, run: () => 4, settle: (value: number) => value }
    const mutable = pipeline.register<number>(definition)
    ;(definition as { settle: unknown }).settle = () => 0
    await mutable.invoke()
    expect(pipeline.usage.totalCost).toBe(4)
  })

  it('settles against the OPERATION result, never a value a stage substituted', async () => {
    // The guarantee the source claimed in prose and nothing defended. Planted
    // exactly as a reviewer did: settling against whatever `around` returns lets a
    // cached or substituted answer price a run that really happened, measured at a
    // 5000x undercharge with every other clause green.
    const { pipeline } = pipelineWith(AUDITED)
    const seen: number[] = []
    const action = pipeline.register<number>({
      id: 'act.substituted',
      cost: 1,
      run: () => 5000,
      around: async (_context, proceed) => {
        await proceed()
        return 1
      },
      settle: (value) => {
        seen.push(value)
        return value
      },
    })

    await expect(action.invoke()).resolves.toBe(1)
    expect(seen).toEqual([5000])
    expect(pipeline.usage.totalCost).toBe(5000)
  })

  it('never settles a run whose operation never happened', async () => {
    // The other half: an `around` that substitutes WITHOUT proceeding produced no
    // operation, so there is nothing to reconcile and the estimate stands.
    const { log, pipeline } = pipelineWith(AUDITED)
    let settled = 0
    const action = pipeline.register<number>({
      id: 'act.cached',
      cost: 4,
      run: () => 5000,
      around: () => 1,
      settle: (value) => {
        settled += 1
        return value
      },
    })

    await expect(action.invoke()).resolves.toBe(1)
    expect(settled).toBe(0)
    expect(pipeline.usage.totalCost).toBe(4)
    expect(trailOf(log)).toEqual(['action.invoked', 'action.estimated=4', 'action.completed'])
  })
})

describe('a polluted prototype cannot make spend unlimited', () => {
  const definition = (id: string): ActionDefinition<number> => ({ id, cost: 50, run: () => 1 })

  it('reads only OWN definition fields, so Object.prototype.settle cannot zero every run', async () => {
    // Measured before `Object.hasOwn`: five 50-cost actions all admitted under a
    // cap of 100 with `totalCost` reading 0. `guard` and `around` have been
    // pollutable since 1.7, but those DENY or SUBSTITUTE — `settle` is the first
    // member that makes spend UNLIMITED, which is the one direction a budget seam
    // must never fail.
    const proto = Object.prototype as unknown as Record<string, unknown>
    proto['settle'] = () => 0
    try {
      const { pipeline } = pipelineWith({ maxTotalCost: 100 })
      await pipeline.register(definition('act.polluted-1')).invoke()
      await pipeline.register(definition('act.polluted-2')).invoke()
      expect(pipeline.usage.totalCost).toBe(100)
      await expect(pipeline.register(definition('act.polluted-3')).invoke()).rejects.toBeInstanceOf(
        BudgetExceededError,
      )
    } finally {
      delete proto['settle']
    }
  })

  it('does not let an inherited cost price a definition that declares none', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>
    proto['cost'] = 0
    try {
      const { pipeline } = pipelineWith({ maxTotalCost: 100 })
      // Rejected, not priced at the inherited 0: a definition that omits its price
      // is a caller bug, and inheriting one is a free run.
      expect(() => pipeline.register({ id: 'act.inherited-cost', run: () => 1 } as never)).toThrow(ActionInvalidError)
    } finally {
      delete proto['cost']
    }
  })
})

describe('the cost field stays as closed as the rest of the record shape', () => {
  it('accepts a cost only on the two settlement events that mean one', () => {
    const log = createMemoryLogSink()
    log.record({ event: 'action.estimated', subject: 'act.a', cost: 1 })
    log.record({ event: 'action.settled', subject: 'act.a', cost: 2 })
    expect(log.records.map((record) => record.cost)).toEqual([1, 2])
    // Anywhere else it would be a general-purpose numeric slot on every event,
    // which is the free-form payload channel the closed shape exists to deny.
    expect(() => log.record({ event: 'action.invoked', subject: 'act.a', cost: 1 })).toThrow(LogRecordInvalidError)
    expect(() => log.record({ event: 'plugin.activated', subject: 'p', cost: 1 })).toThrow(LogRecordInvalidError)
  })

  it('refuses a cost that would make every later total unreadable', () => {
    const log = createMemoryLogSink()
    const bad = (cost: unknown) => () =>
      log.record({ event: 'action.settled', subject: 'act.a', cost } as unknown as LogEntry)
    expect(bad(Number.NaN)).toThrow(LogRecordInvalidError)
    expect(bad(Number.POSITIVE_INFINITY)).toThrow(LogRecordInvalidError)
    expect(bad(-1)).toThrow(LogRecordInvalidError)
    expect(bad('4096')).toThrow(LogRecordInvalidError)
    expect(log.records).toEqual([])
  })
})
