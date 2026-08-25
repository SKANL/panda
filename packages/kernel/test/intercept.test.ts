import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ACTION_STAGES,
  ActionDeniedError,
  ActionInvalidError,
  BudgetExceededError,
  StageFailedError,
  createActionPipeline,
  createKernel,
  createLogSink,
  createMemoryLogSink,
  lostRecordCount,
  type ActionHandle,
  type ActionOutcome,
  type ActionPolicy,
  type GuardDecision,
  type LogSink,
  type MemoryLogSink,
} from '../src'
import { KERNEL_EXPORTS, manifest } from './helpers'

/** A pipeline plus the sink it records into, since most clauses assert on both. */
function pipelineWith(policy?: ActionPolicy): { log: MemoryLogSink; pipeline: ReturnType<typeof createActionPipeline> } {
  const log = createMemoryLogSink()
  return { log, pipeline: createActionPipeline(log, policy) }
}

function trailOf(log: MemoryLogSink): string[] {
  return log.records.map((record) => `${record.event}:${record.subject}${record.code === undefined ? '' : `:${record.code}`}`)
}

/** Resolves only when `release()` is called, so two invocations genuinely overlap. */
function suspended(): { promise: Promise<string>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<string>((resolve) => {
    release = () => resolve('done')
  })
  return { promise, release }
}

/** A real macrotask boundary — the point at which Node reports unhandled rejections. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function hostileSink(): LogSink {
  return {
    record: () => {
      throw new Error('sink is hostile')
    },
    drain: () => Promise.resolve(),
    state: { status: 'degraded', dropped: 0, everDegraded: true, pending: 0 },
  }
}

describe('stage order (matrix: stage order)', () => {
  it('runs pre, guard, around and post in the declared order around the operation', async () => {
    const { pipeline } = pipelineWith()
    const trail: string[] = []
    const action = pipeline.register({
      id: 'act.ordered',
      cost: 1,
      run: () => {
        trail.push('operation')
        return 'value'
      },
      pre: () => trail.push('pre'),
      guard: () => {
        trail.push('guard')
        return { allow: true }
      },
      around: async (_context, proceed) => {
        trail.push('around')
        const value = await proceed()
        trail.push('operation-returned')
        return value
      },
      post: () => trail.push('post'),
    })

    await expect(action.invoke()).resolves.toBe('value')
    expect(trail).toEqual(['pre', 'guard', 'around', 'operation', 'operation-returned', 'post'])
    // Derived FROM the constant, not compared against a hardcoded copy of it:
    // reordering ACTION_STAGES, deleting a stage from it, or adding a phantom
    // fifth all fail here.
    expect(trail.filter((step) => (ACTION_STAGES as readonly string[]).includes(step))).toEqual([...ACTION_STAGES])
  })

  it('runs without any stage at all', async () => {
    const { pipeline } = pipelineWith()
    const action = pipeline.register({ id: 'act.bare', cost: 2, run: () => 7 })
    await expect(action.invoke()).resolves.toBe(7)
    expect(pipeline.usage).toEqual({ invocations: 1, totalCost: 2, concurrent: 0 })
  })
})

describe('read once, validate what was read, operate on that copy', () => {
  it('reads cost once, so an accessor cannot refund the budget it was validated against', async () => {
    const { pipeline } = pipelineWith({ maxTotalCost: 100 })
    let reads = 0
    const action = pipeline.register({
      id: 'act.shifty',
      // Validated at 90, charged at -1000 on a second read: five invocations
      // would have driven totalCost to -999,910 under a cap of 100.
      get cost() {
        return ++reads === 1 ? 90 : -1000
      },
      run: () => 'ok',
    })

    await action.invoke()
    await expect(action.invoke()).rejects.toBeInstanceOf(BudgetExceededError)
    expect(pipeline.usage.totalCost).toBe(90)
  })

  it('reads the id once, so a later read cannot silence the audit trail', async () => {
    const { log, pipeline } = pipelineWith()
    let reads = 0
    const action = pipeline.register({
      // A second read returning a control character makes every record for this
      // action fail `seal` — and neither of 1.6's loss signals fires, because
      // seal throws before the sequence advances and before dispatch.
      get id() {
        return ++reads === 1 ? 'act.quiet' : 'act\nquiet'
      },
      cost: 0,
      run: () => 'ok',
    })

    await action.invoke()
    expect(action.id).toBe('act.quiet')
    expect(trailOf(log)).toEqual(['action.invoked:act.quiet', 'action.completed:act.quiet'])
    expect(lostRecordCount(log)).toBe(0)
  })

  it('reads a guard decision once, so a validated denial cannot become a permission', async () => {
    const { pipeline } = pipelineWith()
    let reads = 0
    let ran = false
    const action = pipeline.register({
      id: 'act.flip',
      cost: 5,
      run: () => {
        ran = true
        return 'leaked'
      },
      // `false` to the shape check, `false` to the branch, `true` to the
      // admission: a well-formed DENIAL read three times became a permission.
      guard: () =>
        ({
          get allow() {
            return ++reads > 2
          },
          reason: 'denied every time it was asked honestly',
        }) as unknown as GuardDecision,
    })

    await expect(action.invoke()).rejects.toBeInstanceOf(ActionDeniedError)
    expect(ran).toBe(false)
    expect(pipeline.usage).toEqual({ invocations: 0, totalCost: 0, concurrent: 0 })
  })

  it('reads run and the stages once, so swapping them after registration changes nothing', async () => {
    const { pipeline } = pipelineWith()
    const definition: { id: string; cost: number; run: () => string; post?: () => void } = {
      id: 'act.swapped',
      cost: 1,
      run: () => 'original',
    }
    const action = pipeline.register(definition)

    // The closure holds the locals, not the definition object the caller kept.
    definition.run = () => 'substituted'
    let postRan = false
    definition.post = () => {
      postRan = true
    }

    await expect(action.invoke()).resolves.toBe('original')
    expect(postRan).toBe(false)
  })

  it('enforces the caps it was constructed with, not the policy object as it stands later', async () => {
    const log = createMemoryLogSink()
    const policy: { maxInvocations: number } = { maxInvocations: 1 }
    const pipeline = createActionPipeline(log, policy)
    const action = pipeline.register({ id: 'act.fixed', cost: 0, run: () => 'ok' })

    await action.invoke()
    // A budget the caller can raise after the fact by mutating the object it
    // handed in is not a budget.
    policy.maxInvocations = 99
    await expect(action.invoke()).rejects.toBeInstanceOf(BudgetExceededError)
  })
})

describe('guard (matrix: guard rejects)', () => {
  it('never runs the action and raises a coded error naming the guard and the action', async () => {
    const { log, pipeline } = pipelineWith()
    let ran = false
    const action = pipeline.register({
      id: 'act.guarded',
      cost: 5,
      run: () => {
        ran = true
        return 'never'
      },
      guard: () => ({ allow: false, reason: 'outside working hours' }),
    })

    await expect(action.invoke()).rejects.toBeInstanceOf(ActionDeniedError)
    expect(ran).toBe(false)
    const error = await action.invoke().catch((cause: unknown) => cause)
    expect((error as { code: string }).code).toBe('PANDA_KERNEL_ACTION_DENIED')
    expect((error as Error).message).toContain('guard')
    expect((error as Error).message).toContain('act.guarded')
    expect((error as Error).message).toContain('outside working hours')
    // A denied action spends nothing: the caps count what ran, not what was asked.
    expect(pipeline.usage).toEqual({ invocations: 0, totalCost: 0, concurrent: 0 })
    expect(trailOf(log)).toEqual([
      'action.refused:act.guarded:PANDA_KERNEL_ACTION_DENIED',
      'action.refused:act.guarded:PANDA_KERNEL_ACTION_DENIED',
    ])
  })

  it('fails closed when a guard returns something that is not a decision', async () => {
    const { pipeline } = pipelineWith()
    let ran = false
    const action = pipeline.register({
      id: 'act.sloppy',
      cost: 1,
      run: () => {
        ran = true
      },
      // The shape a JS caller reaches for. "Broken" must never read as "allowed".
      guard: () => undefined as unknown as { allow: true },
    })

    await expect(action.invoke()).rejects.toBeInstanceOf(StageFailedError)
    expect(ran).toBe(false)
  })
})

describe('declarative caps', () => {
  it('refuses the N+1th invocation before it runs (matrix: count cap)', async () => {
    const { log, pipeline } = pipelineWith({ maxInvocations: 2 })
    let runs = 0
    const action = pipeline.register({ id: 'act.looped', cost: 0, run: () => ++runs })

    await action.invoke()
    await action.invoke()
    const error = await action.invoke().catch((cause: unknown) => cause)

    expect(runs).toBe(2)
    expect(error).toBeInstanceOf(BudgetExceededError)
    expect((error as BudgetExceededError).cap).toBe('invocations')
    expect((error as { code: string }).code).toBe('PANDA_KERNEL_INVOCATION_CAP_EXCEEDED')
    expect((error as Error).message).toContain('invocations cap of 2')
    expect(trailOf(log).at(-1)).toBe('action.refused:act.looped:PANDA_KERNEL_INVOCATION_CAP_EXCEEDED')
  })

  it('counts an OVERLAPPING pair against the loop cap, not only sequential ones', async () => {
    // Sequential clauses pass even when the increments are deferred to a
    // microtask; two invocations fired before the first settles do not.
    const { pipeline } = pipelineWith({ maxInvocations: 1 })
    const gate = suspended()
    const action = pipeline.register({ id: 'act.overlap', cost: 7, run: () => gate.promise })

    const first = action.invoke()
    const second = action.invoke().catch((cause: unknown) => cause)

    await expect(second).resolves.toBeInstanceOf(BudgetExceededError)
    gate.release()
    await expect(first).resolves.toBe('done')
    expect(pipeline.usage).toEqual({ invocations: 1, totalCost: 7, concurrent: 0 })
  })

  it('refuses an invocation that would overrun the cost budget and reports the partial (matrix: cost cap)', async () => {
    const { log, pipeline } = pipelineWith({ maxTotalCost: 100 })
    let runs = 0
    const action = pipeline.register({ id: 'act.pricey', cost: 60, run: () => ++runs })

    await action.invoke()
    const error = await action.invoke().catch((cause: unknown) => cause)

    expect(runs).toBe(1)
    expect((error as BudgetExceededError).cap).toBe('cost')
    expect((error as { code: string }).code).toBe('PANDA_KERNEL_COST_CAP_EXCEEDED')
    expect((error as BudgetExceededError).current).toBe(60)
    expect((error as BudgetExceededError).projected).toBe(120)
    expect((error as Error).message).toContain('60 already used')
    expect(pipeline.usage.totalCost).toBe(60)
    expect(trailOf(log).at(-1)).toBe('action.refused:act.pricey:PANDA_KERNEL_COST_CAP_EXCEEDED')
  })

  it('refuses an invocation over the fan-out cap (matrix: fan-out cap)', async () => {
    const { log, pipeline } = pipelineWith({ maxConcurrent: 1 })
    const gate = suspended()
    const action = pipeline.register({ id: 'act.fanned', cost: 0, run: () => gate.promise })

    const first = action.invoke()
    const error = await action.invoke().catch((cause: unknown) => cause)

    expect((error as BudgetExceededError).cap).toBe('concurrency')
    expect((error as { code: string }).code).toBe('PANDA_KERNEL_CONCURRENCY_CAP_EXCEEDED')
    gate.release()
    await expect(first).resolves.toBe('done')
    // The slot is released when the operation settles, so the seam does not wedge.
    await expect(action.invoke()).resolves.toBe('done')
    expect(trailOf(log)).toContain('action.refused:act.fanned:PANDA_KERNEL_CONCURRENCY_CAP_EXCEEDED')
  })

  it('holds the fan-out slot until the OPERATION settles, not until around returns', async () => {
    // The textbook Promise.race timeout: `around` returns without awaiting the
    // operation it started. Releasing on that return let three real operations
    // run under a cap of one, with usage reporting zero.
    const { pipeline } = pipelineWith({ maxConcurrent: 1 })
    const gate = suspended()
    const action = pipeline.register({
      id: 'act.timeout',
      cost: 0,
      run: () => gate.promise,
      around: (_context, proceed) => {
        void proceed()
        return 'timed out'
      },
    })

    const first = action.invoke()
    await tick()
    expect(pipeline.usage.concurrent).toBe(1)
    await expect(action.invoke()).rejects.toBeInstanceOf(BudgetExceededError)

    gate.release()
    await expect(first).resolves.toBe('timed out')
    expect(pipeline.usage.concurrent).toBe(0)
  })

  it('does not take the process down when a stage forgets to await proceed()', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      const { pipeline } = pipelineWith()
      const action = pipeline.register({
        id: 'act.forgotten',
        cost: 0,
        run: (): Promise<string> => Promise.reject(new Error('operation failed')),
        around: async (_context, proceed) => {
          void proceed()
          // A real checkpoint while the operation rejects unobserved: without a
          // handler attached the instant the promise exists, Node reports an
          // unhandled rejection, which is fatal by default on the Node this
          // package requires (engines: >=24).
          await tick()
          return 'ignored'
        },
      })

      await expect(action.invoke()).resolves.toBe('ignored')
      await tick()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('admits and counts atomically, so a sink that re-enters cannot beat the cap', async () => {
    // Recording between the check and the increment let a sink that merely DOES
    // something on that stack see the pre-admission counter. It need not throw.
    const inner = createMemoryLogSink()
    const gate = suspended()
    // Held in a box because the sink closes over the handle the pipeline has not
    // produced yet: the re-entry happens from inside the very first record call.
    const box: { handle?: ActionHandle<string> } = {}
    let reentered: Promise<unknown> | undefined
    const reentrant: LogSink = {
      record: (entry) => {
        inner.record(entry)
        if (entry.event === 'action.invoked' && reentered === undefined) {
          reentered = box.handle?.invoke().catch((cause: unknown) => cause)
        }
      },
      drain: () => inner.drain(),
      get state() {
        return inner.state
      },
    }
    const pipeline = createActionPipeline(reentrant, { maxConcurrent: 1 })
    const action = pipeline.register({ id: 'act.reentrant', cost: 0, run: () => gate.promise })
    box.handle = action

    const first = action.invoke()
    await expect(reentered).resolves.toBeInstanceOf(BudgetExceededError)
    gate.release()
    await expect(first).resolves.toBe('done')
  })

  it('rejects a policy the seam could not enforce with', () => {
    const log = createMemoryLogSink()
    // NaN is the one that matters: every `>` against it is false, so a NaN cap
    // would fail OPEN and silently disable the budget. Infinity goes with it —
    // "unlimited" is spelled by omitting the cap, not by naming a value.
    expect(() => createActionPipeline(log, { maxInvocations: Number.NaN })).toThrow(ActionInvalidError)
    expect(() => createActionPipeline(log, { maxTotalCost: -1 })).toThrow(ActionInvalidError)
    expect(() => createActionPipeline(log, { maxConcurrent: Number.POSITIVE_INFINITY })).toThrow(ActionInvalidError)
    expect(() => createActionPipeline(log, { maxInvocations: 0 })).not.toThrow()
  })

  it('rejects an action descriptor the seam could not account for', () => {
    const { pipeline } = pipelineWith()
    // A negative cost would REFUND budget already spent, buying back every cap.
    expect(() => pipeline.register({ id: 'act.refund', cost: -1000, run: () => 0 })).toThrow(ActionInvalidError)
    expect(() => pipeline.register({ id: 'act.nan', cost: Number.NaN, run: () => 0 })).toThrow(ActionInvalidError)
    // The id reaches the log verbatim, so it obeys the record's identifier rules.
    expect(() => pipeline.register({ id: 'a\nact.ghost', cost: 1, run: () => 0 })).toThrow(ActionInvalidError)
    expect(() => pipeline.register({ id: '  ', cost: 1, run: () => 0 })).toThrow(ActionInvalidError)
    expect(() => pipeline.register({ id: 'act.ok', cost: 1, run: undefined as unknown as () => void })).toThrow(
      ActionInvalidError,
    )
  })

  it('rejects an untrimmed or duplicate id, so registration identity IS audit identity', () => {
    const { pipeline } = pipelineWith()
    // Trimming for the caller would give two distinct registrations one
    // indistinguishable subject, and make handle.id differ from the declared id.
    expect(() => pipeline.register({ id: ' act.padded ', cost: 0, run: () => 0 })).toThrow(ActionInvalidError)
    pipeline.register({ id: 'act.once', cost: 0, run: () => 0 })
    expect(() => pipeline.register({ id: 'act.once', cost: 0, run: () => 1 })).toThrow(ActionInvalidError)
  })
})

describe('failures', () => {
  it('runs post and hands the caller the original error (matrix: action fails)', async () => {
    const { log, pipeline } = pipelineWith()
    const boom = new Error('the operation blew up')
    const seen: ActionOutcome[] = []
    const action = pipeline.register({
      id: 'act.explodes',
      cost: 1,
      run: () => {
        throw boom
      },
      post: (_context, outcome) => seen.push(outcome),
    })

    // Identity, not shape: a kernel wrapper here would hide the stack that explains it.
    await expect(action.invoke()).rejects.toBe(boom)
    expect(seen).toEqual([{ status: 'failed', error: boom }])
    // The budget was spent: the action was admitted and it ran.
    expect(pipeline.usage).toEqual({ invocations: 1, totalCost: 1, concurrent: 0 })
    // A failed spend must not be byte-identical to a successful one in the stream.
    expect(trailOf(log)).toEqual(['action.invoked:act.explodes', 'action.failed:act.explodes'])
  })

  it('preserves an operation failure through an around that lets it pass', async () => {
    const { pipeline } = pipelineWith()
    const boom = new Error('still mine')
    const action = pipeline.register({
      id: 'act.wrapped',
      cost: 0,
      run: () => {
        throw boom
      },
      around: (_context, proceed) => proceed(),
    })
    await expect(action.invoke()).rejects.toBe(boom)
  })

  it('tells post a stage failure apart from a refusal, because they spent different amounts', async () => {
    const { pipeline } = pipelineWith()
    const seen: ActionOutcome[] = []
    const action = pipeline.register({
      id: 'act.late-stage',
      cost: 10,
      run: () => 'ran',
      around: async (_context, proceed) => {
        await proceed()
        throw new Error('around fell over after the spend')
      },
      post: (_context, outcome) => seen.push(outcome),
    })

    await expect(action.invoke()).rejects.toBeInstanceOf(StageFailedError)
    // A post keying refund logic on 'refused' would conclude nothing was spent.
    expect(seen[0]?.status).toBe('stage-failed')
    expect(pipeline.usage).toEqual({ invocations: 1, totalCost: 10, concurrent: 0 })
  })

  it('reports a nested failure under the OUTER action, not the inner one', async () => {
    const { pipeline } = pipelineWith()
    const inner = pipeline.register({
      id: 'act.inner',
      cost: 0,
      run: () => 'inner',
      guard: () => {
        throw new Error('inner guard broke')
      },
    })
    const outer = pipeline.register<string>({
      id: 'act.outer',
      cost: 0,
      run: () => 'outer',
      around: async (_context, proceed) => {
        await inner.invoke()
        return proceed()
      },
    })

    const error = await outer.invoke().catch((cause: unknown) => cause)
    // Relaying verbatim told the caller of act.outer that act.inner's guard failed.
    expect((error as StageFailedError).actionId).toBe('act.outer')
    expect((error as StageFailedError).stage).toBe('around')
    expect(((error as Error).cause as StageFailedError).actionId).toBe('act.inner')
  })
})

describe('post is owed once pre has run', () => {
  it('runs post for a cap refusal, so a pre/post pair always balances', async () => {
    const { pipeline } = pipelineWith({ maxInvocations: 0 })
    const trail: string[] = []
    const action = pipeline.register({
      id: 'act.balanced',
      cost: 0,
      run: () => 'never',
      pre: () => trail.push('acquire'),
      post: (_context, outcome) => trail.push(`release:${outcome.status}`),
    })

    await expect(action.invoke()).rejects.toBeInstanceOf(BudgetExceededError)
    expect(trail).toEqual(['acquire', 'release:refused'])
  })

  it('runs post for a GUARD denial too', async () => {
    const { pipeline } = pipelineWith()
    const trail: string[] = []
    const action = pipeline.register({
      id: 'act.denied',
      cost: 0,
      run: () => 'never',
      pre: () => trail.push('acquire'),
      guard: () => ({ allow: false, reason: 'nope' }),
      post: (_context, outcome) => trail.push(`release:${outcome.status}`),
    })

    await expect(action.invoke()).rejects.toBeInstanceOf(ActionDeniedError)
    expect(trail).toEqual(['acquire', 'release:refused'])
  })

  it('does NOT run post when pre itself threw, because that acquire never completed', async () => {
    const { pipeline } = pipelineWith()
    const trail: string[] = []
    const action = pipeline.register({
      id: 'act.unacquired',
      cost: 0,
      run: () => 'never',
      pre: () => {
        trail.push('acquire-attempt')
        throw new Error('acquire failed')
      },
      post: () => trail.push('release'),
    })

    await expect(action.invoke()).rejects.toBeInstanceOf(StageFailedError)
    // Running post here is a double release of something never acquired.
    expect(trail).toEqual(['acquire-attempt'])
  })
})

describe('broken interceptors (matrix: broken interceptor)', () => {
  const stages = ['pre', 'guard', 'around'] as const

  for (const stage of stages) {
    it(`contains a throwing ${stage} without letting the action through or leaking its slot`, async () => {
      // maxConcurrent 1 makes the "healthy action still works" assertion below
      // load-bearing: a slot leaked on stage failure permanently exhausts it.
      const { log, pipeline } = pipelineWith({ maxConcurrent: 1 })
      let ran = false
      const thrower = (): never => {
        throw new Error(`${stage} is broken`)
      }
      const action = pipeline.register({
        id: `act.broken-${stage}`,
        cost: 1,
        run: () => {
          ran = true
          return 'leaked'
        },
        ...(stage === 'pre' ? { pre: thrower } : {}),
        ...(stage === 'guard' ? { guard: thrower } : {}),
        ...(stage === 'around' ? { around: thrower } : {}),
      })

      const error = await action.invoke().catch((cause: unknown) => cause)
      // Both halves matter: contained AND not silently allowed.
      expect(error).toBeInstanceOf(StageFailedError)
      expect((error as { code: string }).code).toBe('PANDA_KERNEL_STAGE_FAILED')
      expect((error as StageFailedError).stage).toBe(stage)
      expect((error as Error).cause).toBeInstanceOf(Error)
      expect(ran).toBe(false)
      expect(pipeline.usage.concurrent).toBe(0)
      expect(trailOf(log)).toContain(`action.stage-failed:act.broken-${stage}:PANDA_KERNEL_STAGE_FAILED`)

      // The kernel keeps running: a healthy action on the same pipeline still works.
      const healthy = pipeline.register({ id: 'act.healthy', cost: 0, run: () => 'fine' })
      await expect(healthy.invoke()).resolves.toBe('fine')
    })
  }

  it('contains a throwing post WITHOUT rewriting the outcome it observed', async () => {
    const { log, pipeline } = pipelineWith()
    const action = pipeline.register({
      id: 'act.broken-post',
      cost: 0,
      run: () => 'completed',
      post: () => {
        throw new Error('post is broken')
      },
    })

    // The only stage whose throw is swallowed: post runs after the outcome is
    // decided, so propagating it would let post turn a completed action into a
    // failed one — mutating another stage's decision after the fact.
    await expect(action.invoke()).resolves.toBe('completed')
    // Swallowed is not silent, and it is distinguishable from an around failure:
    // the action did not fail, only its observer did.
    expect(trailOf(log)).toEqual([
      'action.invoked:act.broken-post',
      'action.completed:act.broken-post',
      'action.post-failed:act.broken-post:PANDA_KERNEL_STAGE_FAILED',
    ])
  })

  it('refuses an around that proceeds twice, so one budget charge buys one run', async () => {
    const { pipeline } = pipelineWith()
    let runs = 0
    const action = pipeline.register({
      id: 'act.greedy',
      cost: 10,
      run: () => ++runs,
      around: async (_context, proceed) => {
        await proceed()
        return proceed()
      },
    })

    await expect(action.invoke()).rejects.toBeInstanceOf(StageFailedError)
    expect(runs).toBe(1)
    expect(pipeline.usage.totalCost).toBe(10)
  })

  it('revokes proceed when around returns, so a stored capability cannot run the operation later', async () => {
    // Measured before the fix with every cap exhausted: the operation still ran,
    // uncounted, unrecorded and holding no slot.
    const { pipeline } = pipelineWith({ maxInvocations: 1, maxTotalCost: 0, maxConcurrent: 1 })
    let ran = 0
    let escaped: (() => Promise<number>) | undefined
    const action = pipeline.register({
      id: 'act.escapee',
      cost: 0,
      run: () => ++ran,
      around: (_context, proceed) => {
        escaped = proceed
        return -1
      },
    })

    await expect(action.invoke()).resolves.toBe(-1)
    expect(ran).toBe(0)
    expect(() => escaped?.()).toThrow(StageFailedError)
    expect(ran).toBe(0)
  })

  it('lets an around substitute a result without running the operation', async () => {
    const { pipeline } = pipelineWith()
    let ran = false
    const action = pipeline.register({
      id: 'act.cached',
      cost: 1,
      run: () => {
        ran = true
        return 'fresh'
      },
      around: () => 'cached',
    })

    await expect(action.invoke()).resolves.toBe('cached')
    expect(ran).toBe(false)
  })

  it('gives every stage a frozen context and a frozen usage snapshot', async () => {
    const { pipeline } = pipelineWith()
    let captured: unknown
    const action = pipeline.register({
      id: 'act.frozen',
      cost: 3,
      run: () => 'ok',
      pre: (context) => {
        captured = context
      },
    })

    await action.invoke()
    // Asserted on the CONTEXT itself: the descriptor's own freeze already threw a
    // TypeError, which hid whether the context was frozen at all.
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen((captured as { usage: unknown }).usage)).toBe(true)
    expect(Object.isFrozen(pipeline.usage)).toBe(true)
    expect(() => {
      ;(captured as { action: { cost: number } }).action.cost = 0
    }).toThrow(TypeError)
    expect(pipeline.usage.totalCost).toBe(3)
  })
})

describe('recording (matrix: recording)', () => {
  it('records every invocation, its outcome, and every refusal through the Story 1.6 sink', async () => {
    const { log, pipeline } = pipelineWith({ maxInvocations: 1 })
    const action = pipeline.register({ id: 'act.audited', cost: 4, run: () => 'ok' })

    await action.invoke()
    await action.invoke().catch(() => {})

    expect(trailOf(log)).toEqual([
      'action.invoked:act.audited',
      'action.completed:act.audited',
      'action.refused:act.audited:PANDA_KERNEL_INVOCATION_CAP_EXCEEDED',
    ])
    // The closed record shape: no slot the action could smuggle a payload through.
    expect(Object.keys(log.records[0] ?? {}).sort()).toEqual(['at', 'event', 'seq', 'subject', 'version'])
  })

  it('keeps enforcing the budget when the sink is hostile, and counts what it lost', async () => {
    const hostile = hostileSink()
    const pipeline = createActionPipeline(hostile, { maxInvocations: 1 })
    const action = pipeline.register({ id: 'act.unlogged', cost: 0, run: () => 'ok' })

    // A broken diagnostic must not break the seam that is enforcing the budget...
    await expect(action.invoke()).resolves.toBe('ok')
    // ...and must not weaken it either.
    await expect(action.invoke()).rejects.toBeInstanceOf(BudgetExceededError)
    // An entry rejected by the sink never reaches the stream at all, so neither a
    // seq gap nor `dropped` fires. Without this counter, containment and success
    // are indistinguishable.
    expect(lostRecordCount(hostile)).toBe(3)
  })

  it('keeps recording through a sink that fails its writes asynchronously', async () => {
    const written: string[] = []
    const log = createLogSink((record) => {
      written.push(record.event)
      return Promise.reject(new Error('write failed'))
    })
    const pipeline = createActionPipeline(log, {})
    const action = pipeline.register({ id: 'act.dropped', cost: 0, run: () => 'ok' })

    await expect(action.invoke()).resolves.toBe('ok')
    await log.drain()
    expect(written).toEqual(['action.invoked', 'action.completed'])
    expect(log.state.dropped).toBe(2)
    expect(lostRecordCount(log)).toBe(0)
  })
})

describe('nested invocation (matrix: nested invocation)', () => {
  it('counts an action invoked from inside another once each, not twice', async () => {
    const { log, pipeline } = pipelineWith({ maxInvocations: 2, maxTotalCost: 30 })
    const inner = pipeline.register({ id: 'act.inner', cost: 10, run: () => 'inner' })
    const outer = pipeline.register({ id: 'act.outer', cost: 20, run: () => inner.invoke() })

    await expect(outer.invoke()).resolves.toBe('inner')
    expect(pipeline.usage).toEqual({ invocations: 2, totalCost: 30, concurrent: 0 })
    expect(trailOf(log)).toEqual([
      'action.invoked:act.outer',
      'action.invoked:act.inner',
      'action.completed:act.inner',
      'action.completed:act.outer',
    ])
  })

  it('releases both concurrency slots the nesting held', async () => {
    // ponytail: concurrency counts everything in flight, so a nested invocation
    // genuinely holds two slots. Depth-aware fan-out (counting only siblings) is
    // the upgrade path if a real caller ever needs it — see deferred-work.md.
    const { pipeline } = pipelineWith({ maxConcurrent: 2 })
    const inner = pipeline.register({ id: 'act.inner', cost: 0, run: () => 'inner' })
    const outer = pipeline.register({ id: 'act.outer', cost: 0, run: () => inner.invoke() })

    await outer.invoke()
    expect(pipeline.usage.concurrent).toBe(0)
  })
})

describe('no bypass (matrix: no bypass)', () => {
  it('pins the exported surface, because the hole is a new export beside the pipeline', async () => {
    // The pipeline's own signature cannot be weakened into a bypass — there is
    // nothing to weaken. What WOULD restore the hole is `export function
    // runActionUnchecked(...)` added next to it, which no signature or type
    // assertion can see. This list is the only thing that catches it. The
    // package.json exports map is pinned in guard.test.ts for the same reason.
    const surface = await import('../src')
    expect(Object.keys(surface).sort()).toEqual(KERNEL_EXPORTS)
  })

  it('hands back a frozen handle that exposes no path to the operation', async () => {
    const { pipeline } = pipelineWith()
    let ran = 0
    const action = pipeline.register({ id: 'act.sealed', cost: 0, run: () => ++ran })

    // `run` was read once into a local and is not reachable from the handle, so
    // `invoke()` is the only way to reach the operation through a registered action.
    expect(Object.keys(action).sort()).toEqual(['id', 'invoke'])
    expect(Object.isFrozen(action)).toBe(true)
    expect(JSON.stringify(action)).not.toContain('run')

    // The pipeline itself hands out no runner either.
    expect(Object.keys(pipeline).sort()).toEqual(['register', 'usage'])
    expect(Object.isFrozen(pipeline)).toBe(true)
  })

  it('pins the policy STRUCTURALLY, so a bypass field cannot ride in on the shape', () => {
    // Naming `ActionPolicy` by reference made the expectation widen in lockstep
    // with the thing it constrains: a reviewer added `unsafeBypass?: boolean` plus
    // an early return in `invoke` and the entire gate stayed green. The literal
    // below moves independently, so any new field fails here.
    type PolicyShape = {
      readonly maxInvocations?: number
      readonly maxTotalCost?: number
      readonly maxConcurrent?: number
    }
    expectTypeOf<ActionPolicy>().toEqualTypeOf<PolicyShape>()

    // And the sink stays required — an expectTypeOf pin cannot be satisfied by an
    // unrelated error landing on the same line, unlike a @ts-expect-error.
    expectTypeOf(createActionPipeline).parameters.toEqualTypeOf<[LogSink, PolicyShape?]>()
  })
})

describe('kernel wiring', () => {
  it('hands plugins the pipeline the kernel owns, recording into the same stream', async () => {
    const log = createMemoryLogSink()
    const kernel = createKernel({ log, actionPolicy: { maxInvocations: 1 } })
    let outcome: unknown
    let refusal: unknown

    kernel.register(manifest({ id: 'plugin-a' }), (context) => {
      const action = context.actions.register({ id: 'act.plugin', cost: 1, run: () => 'ran' })
      outcome = action.invoke()
      refusal = action.invoke().catch((error: unknown) => error)
      return { status: 'activated' }
    })
    kernel.start()

    await expect(outcome).resolves.toBe('ran')
    await expect(refusal).resolves.toBeInstanceOf(BudgetExceededError)
    // One stream reconstructs the lifecycle transitions and the budget decisions.
    expect(kernel.log.records?.map((record) => record.event)).toEqual([
      'manifest.validated',
      'action.invoked',
      'action.refused',
      'plugin.activated',
      'action.completed',
    ])
    await kernel.stop()
  })
})
