import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES } from '@skanl/panda-contracts'
import type { ResultEnvelope, RunRequest, WorkspaceHandle } from '@skanl/panda-contracts'
import type { ChildProcessSpawner, SpawnedChild, SpawnOutcome } from '../src/spawn-seam.ts'
import { createKernel, createMemoryLogSink } from '@skanl/panda-kernel'
import type { MemoryLogSink } from '@skanl/panda-kernel'
import { createCliExecutorAdapter } from '../src/traits.ts'
import type { ExecutorTraits } from '../src/traits.ts'
import { CLAUDE_CODE_TRAITS } from '../src/executors/claude-code.ts'
import { CODEX_TRAITS } from '../src/executors/codex.ts'
import { OPENCODE_TRAITS } from '../src/executors/opencode.ts'
import { createExecutorPlugin, EXECUTOR_SERVICE } from '../src/plugin.ts'
import type { ExecutorService } from '../src/plugin.ts'
import { FakeSpawner } from './fake-spawner.ts'

// The usage channel (Story M3.C): a NUMBER the vendor reported reaches
// `envelope.data.usage`, and the executor plugin settles the kernel's budget
// against it.
//
// The payload fixtures below are TRIMMED COPIES of what the real binaries printed
// while this story was written — the field names and the arithmetic are the
// vendors', not panda's. `usage-live.test.ts` is what re-checks them against the
// binaries themselves; this file is the fast half that runs everywhere.

function request(): RunRequest {
  const workspace: WorkspaceHandle = {
    id: 'usage-probe',
    rootPath: join(tmpdir(), 'panda-usage-probe'),
    capabilities: ['read', 'write'],
  }
  return { prompt: 'say ok', workspace }
}

async function runWith(traits: ExecutorTraits, stdout: string, exitCode = 0): Promise<ResultEnvelope> {
  const spawner = new FakeSpawner({ exitCode, stdout, stderr: '' })
  return await createCliExecutorAdapter(traits, { spawner }).run(request())
}

function jsonl(...events: readonly unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

// Observed verbatim on claude 2.1.246 for a one-word task. The four fields are
// disjoint, which is the whole reason all four are summed: `input_tokens` alone
// would have priced this run at 2.
const CLAUDE_STDOUT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: 's-1',
  usage: {
    input_tokens: 2,
    output_tokens: 4,
    cache_creation_input_tokens: 42_206,
    cache_read_input_tokens: 17_630,
  },
  total_cost_usd: 0.430985,
})

// Observed verbatim on codex-cli 0.149.1. Usage arrives on `turn.completed`,
// AFTER the record that carried the answer.
const CODEX_STDOUT = jsonl(
  { type: 'thread.started', thread_id: 't-1' },
  { type: 'item.completed', item: { id: 'i-1', type: 'agent_message', text: 'ok' } },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 28_451,
      cached_input_tokens: 6912,
      cache_write_input_tokens: 0,
      output_tokens: 61,
      reasoning_output_tokens: 54,
    },
  },
)

// Observed verbatim on opencode 1.18.23. `part.tokens.total` is opencode's own
// sum: 34390 + 17 + 0 + 0 + 8192 = 42599.
const OPENCODE_STDOUT = jsonl(
  { type: 'text', timestamp: 1, sessionID: 's-1', part: { type: 'text', text: 'ok' } },
  {
    type: 'step_finish',
    timestamp: 2,
    sessionID: 's-1',
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: { total: 42_599, input: 34_390, output: 17, reasoning: 0, cache: { write: 0, read: 8192 } },
      cost: 0,
    },
  },
)

// The three-step capture, verbatim from a real `opencode run` over a task that
// wrote two files and read them back. Each `total` equals that step's OWN
// components — 34415+163+8192, 235+80+42560, 236+37+42752 — so the figures are
// per step and never cumulative. This fixture exists because a single-step task
// cannot surface the difference, which is exactly why the defect shipped.
const OPENCODE_MULTI_STEP = jsonl(
  { type: 'step_start', sessionID: 's-1', part: { type: 'step-start' } },
  {
    type: 'step_finish',
    sessionID: 's-1',
    part: {
      type: 'step-finish',
      tokens: { total: 42_770, input: 34_415, output: 163, reasoning: 0, cache: { write: 0, read: 8192 } },
    },
  },
  {
    type: 'step_finish',
    sessionID: 's-1',
    part: {
      type: 'step-finish',
      tokens: { total: 42_875, input: 235, output: 80, reasoning: 0, cache: { write: 0, read: 42_560 } },
    },
  },
  { type: 'text', sessionID: 's-1', part: { type: 'text', text: 'ok' } },
  {
    type: 'step_finish',
    sessionID: 's-1',
    part: {
      type: 'step-finish',
      tokens: { total: 43_025, input: 236, output: 37, reasoning: 0, cache: { write: 0, read: 42_752 } },
    },
  },
)

describe('a number survives the adapter output channel', () => {
  it('reads each shipped vendor figure out of that vendor own field', async () => {
    const claude = await runWith(CLAUDE_CODE_TRAITS, CLAUDE_STDOUT)
    const codex = await runWith(CODEX_TRAITS, CODEX_STDOUT)
    const opencode = await runWith(OPENCODE_TRAITS, OPENCODE_STDOUT)

    // The arithmetic is spelled out here rather than copied from the traits, so a
    // trait that drifts to a different field fails instead of agreeing with itself.
    expect((claude.data as Record<string, unknown>)['usage']).toBe(2 + 4 + 42_206 + 17_630)
    // NOT 28451 + 6912 + 61 + 54: `cached_input_tokens` is a breakdown of the
    // input already counted, and `reasoning_output_tokens` a share of the output.
    expect((codex.data as Record<string, unknown>)['usage']).toBe(28_451 + 61)
    expect((opencode.data as Record<string, unknown>)['usage']).toBe(42_599)
  })

  it('keeps the figure a NUMBER while every other data value stays a string', async () => {
    const envelope = await runWith(CLAUDE_CODE_TRAITS, CLAUDE_STDOUT)
    const data = envelope.data as Record<string, unknown>
    expect(typeof data['usage']).toBe('number')
    // The string-only contract the metadata channel has always had, unchanged:
    // widening it to carry numbers would have made every metadata key numeric-capable.
    expect(Object.entries(data).filter(([key]) => key !== 'usage').map(([, value]) => typeof value)).toEqual([
      'string',
      'string',
      'string',
    ])
    expect(envelope.data).toEqual({ result: 'ok', subtype: 'success', session_id: 's-1', usage: 59_842 })
  })

  it('reads usage off a record that is NOT the result record', async () => {
    // Codex and opencode both report usage on a later event. A channel that could
    // only read the result record would have found nothing on either.
    const codex = await runWith(CODEX_TRAITS, CODEX_STDOUT)
    expect(codex.summary).toBe('ok')
    expect((codex.data as Record<string, unknown>)['usage']).toBe(28_512)
  })

  it('carries the figure on the FAILURE path too, because a failed run still spent it', async () => {
    const failed = await runWith(
      CLAUDE_CODE_TRAITS,
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        result: 'the turn limit was reached',
        usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
      }),
    )
    expect(failed.status).toBe('failed')
    expect((failed.data as Record<string, unknown>)['usage']).toBe(10)
  })

  it('omits the key entirely when the vendor reported nothing', async () => {
    const noUsage = await runWith(
      CLAUDE_CODE_TRAITS,
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
    )
    // Absent, never 0: the plugin reads absence as "nothing observed this run" and
    // charges the estimate, while a 0 would read as a free run.
    expect(Object.hasOwn(noUsage.data as object, 'usage')).toBe(false)
  })

  const partial: readonly (readonly [string, unknown])[] = [
    ['a missing component', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 4 }],
    ['a string component', { input_tokens: '1', output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }],
    ['a negative component', { input_tokens: -1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }],
    ['a NaN component', { input_tokens: Number.NaN, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }],
    ['a nested object instead of a number', { input_tokens: { total: 1 }, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }],
  ]

  it.each(partial)('treats %s as no figure at all rather than a partial sum', async (_label, usage) => {
    const envelope = await runWith(
      CLAUDE_CODE_TRAITS,
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage }),
    )
    // A partial sum is a wrong bill, and a wrong bill is worse than an absent one
    // — absence is a case the pipeline already handles by keeping the estimate.
    expect(Object.hasOwn(envelope.data as object, 'usage')).toBe(false)
  })

  it('SUMS every step a vendor billed, because a step total is not a run total', async () => {
    // Measured on a real three-step opencode run. Taking the last record billed
    // 43025 of 128670, and a run whose final step is a one-line answer bills
    // almost nothing — which a single-step fixture could never have shown.
    const envelope = await runWith(OPENCODE_TRAITS, OPENCODE_MULTI_STEP)
    expect((envelope.data as Record<string, unknown>)['usage']).toBe(42_770 + 42_875 + 43_025)
    expect((envelope.data as Record<string, unknown>)['usage']).not.toBe(43_025)
  })

  it('counts only the records the trait discriminates, so a lookalike cannot join the bill', async () => {
    // Without `usageWhen` a summed figure bills every record that happens to fit
    // the shape. The extra event below carries an identical `part.tokens.total`
    // under a different `type`.
    const envelope = await runWith(
      OPENCODE_TRAITS,
      jsonl(
        { type: 'text', part: { type: 'text', text: 'ok' } },
        { type: 'message_finish', part: { type: 'step-finish', tokens: { total: 999_999 } } },
        { type: 'step_finish', part: { type: 'step-finish', tokens: { total: 10 } } },
      ),
    )
    expect((envelope.data as Record<string, unknown>)['usage']).toBe(10)
  })

  it('VOIDS the whole figure when one billed record cannot be read', async () => {
    // A term the engine cannot read is spend it cannot account for. Skipping that
    // record and summing the rest under-bills silently; reporting nothing charges
    // the estimate, which is a case the pipeline already handles.
    const envelope = await runWith(
      OPENCODE_TRAITS,
      jsonl(
        { type: 'text', part: { type: 'text', text: 'ok' } },
        { type: 'step_finish', part: { type: 'step-finish', tokens: { total: 40_000 } } },
        { type: 'step_finish', part: { type: 'step-finish', tokens: {} } },
      ),
    )
    expect(Object.hasOwn(envelope.data as object, 'usage')).toBe(false)
  })
})

/**
 * A child that, when its tree is killed, settles carrying everything it had
 * already printed — which is what a real OS child does through `close`.
 */
function killCapturingSpawner(stdout: string, onSpawn: () => void): ChildProcessSpawner {
  return {
    spawn(): SpawnedChild {
      let settle!: (outcome: SpawnOutcome) => void
      const done = new Promise<SpawnOutcome>((resolve) => {
        settle = resolve
      })
      const child: SpawnedChild = {
        pid: 1,
        settled: false,
        done,
        writeStdin: () => {},
        endStdin: () => {
          queueMicrotask(onSpawn)
        },
        killTree: () => {
          settle({ exitCode: null, stdout, stderr: '' })
        },
      }
      return child
    },
  }
}

describe('no path throws the vendor figure away (matrix: cancelled or failed run)', () => {
  const spentStdout = jsonl(
    { type: 'text', part: { type: 'text', text: 'partial' } },
    { type: 'step_finish', part: { type: 'step-finish', tokens: { total: 500_000 } } },
  )

  it('charges a CANCELLED run what its own stdout says it spent', async () => {
    // Measured before this: a cancelled run carrying 500,000 reported tokens in
    // captured stdout was charged its estimate of 1. A killed child settles
    // through `close` carrying everything it already printed, which the shared
    // FakeChild deliberately does not model — hence the local double.
    const controller = new AbortController()
    const envelope = await createCliExecutorAdapter(OPENCODE_TRAITS, {
      spawner: killCapturingSpawner(spentStdout, () => controller.abort()),
    }).run({ ...request(), signal: controller.signal })

    expect(envelope.status).toBe('cancelled')
    expect((envelope.data as Record<string, unknown>)['usage']).toBe(500_000)
  })

  const failing: readonly (readonly [string, SpawnOutcome])[] = [
    ['a bare non-zero exit', { exitCode: 3, stdout: spentStdout, stderr: 'boom' }],
    ['a signal-terminated child', { exitCode: null, stdout: spentStdout, stderr: '' }],
    ['a truncated stream', { exitCode: 0, stdout: spentStdout, stderr: '', stdoutTruncated: true }],
    ['a stream error', { exitCode: 0, stdout: spentStdout, stderr: '', streamErrorMessage: 'EPIPE' }],
  ]

  it.each(failing)('charges a run that ended with %s', async (_label, outcome) => {
    const envelope = await createCliExecutorAdapter(OPENCODE_TRAITS, {
      spawner: new FakeSpawner(outcome),
    }).run(request())
    expect(envelope.status).toBe('failed')
    expect((envelope.data as Record<string, unknown>)['usage']).toBe(500_000)
  })

  it('still reports no data when no child ever started', async () => {
    const envelope = await createCliExecutorAdapter(OPENCODE_TRAITS, {
      spawner: new FakeSpawner({ exitCode: null, stdout: '', stderr: '', spawnErrorMessage: 'ENOENT' }),
    }).run(request())
    expect(envelope.status).toBe('failed')
    expect(envelope.data).toBeNull()
  })
})

/** Asserts a trait record was refused at the factory, by CODE rather than by wording. */
function expectTraitsRejected(build: () => unknown): void {
  try {
    build()
    expect.unreachable('the trait record was accepted')
  } catch (error) {
    expect((error as { code?: string }).code).toBe(PANDA_ERROR_CODES.contractEnvelopeInvalid)
  }
}

describe('the usage key is engine-owned', () => {
  const base: ExecutorTraits = {
    executorId: 'usage-guard',
    command: 'usage-guard',
    args: Object.freeze([]),
    promptDelivery: 'stdin',
    output: { payload: 'single-object', resultPath: ['result'] },
  }

  it('rejects a metadata key that would forge the figure a cost cap is enforced on', () => {
    expectTraitsRejected(() =>
      createCliExecutorAdapter({
        ...base,
        output: { payload: 'single-object', resultPath: ['result'], metadata: { usage: ['anything'] } },
      }),
    )
  })

  it('rejects usagePaths that could never produce a figure', () => {
    const reject = (usagePaths: readonly (readonly string[])[]) =>
      expectTraitsRejected(() =>
        createCliExecutorAdapter({ ...base, output: { payload: 'single-object', resultPath: ['result'], usagePaths } }),
      )
    // An empty list declares "this vendor reports usage" and never produces one —
    // the inert shape this story exists to refuse.
    reject([])
    // An empty PATH resolves to the record itself, which is never a number, so it
    // would make every run silently unsettleable.
    reject([[]])
    reject([['usage', 'input_tokens'], []])
  })

  it('refuses usagePaths with no usageWhen, because a summed figure needs bounded records', () => {
    expectTraitsRejected(() =>
      createCliExecutorAdapter({
        ...base,
        output: { payload: 'jsonl', resultPath: ['result'], usagePaths: [['tokens']] },
      }),
    )
    expectTraitsRejected(() =>
      createCliExecutorAdapter({
        ...base,
        output: {
          payload: 'jsonl',
          resultPath: ['result'],
          usageWhen: { path: [], equals: 'x' },
          usagePaths: [['tokens']],
        },
      }),
    )
  })
})

describe('the executor plugin settles the kernel budget against what the vendor reported', () => {
  function mount(
    stdout: string,
    policy?: { readonly maxInvocations?: number; readonly maxTotalCost?: number },
  ): { service: ExecutorService; log: MemoryLogSink; spawner: FakeSpawner; stop: () => Promise<unknown> } {
    const log = createMemoryLogSink()
    const spawner = new FakeSpawner({ exitCode: 0, stdout, stderr: '' })
    const kernel = createKernel({ log, actionPolicy: policy })
    const plugin = createExecutorPlugin({ adapterOptions: { spawner }, cost: 1 })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()
    const resolved = kernel.getService<ExecutorService>(EXECUTOR_SERVICE)
    if (resolved.kind !== 'provided') throw new Error('the executor service did not activate')
    return { service: resolved.value, log, spawner, stop: () => kernel.stop() }
  }

  it('charges the reported figure, not the estimate, and shows both in the record stream', async () => {
    // A budget that never bites: the settlement records exist only where a policy
    // does, so that a `panda run` with no caps keeps the Story 1.7 stream exactly.
    const mounted = mount(CLAUDE_STDOUT, { maxTotalCost: 1_000_000 })
    await expect(mounted.service.run('usage#one', request())).resolves.toMatchObject({ status: 'ok' })

    expect(
      mounted.log.records
        .filter((record) => record.event.startsWith('action.'))
        .map((record) => `${record.event}${record.cost === undefined ? '' : `=${record.cost}`}`),
    ).toEqual(['action.invoked', 'action.estimated=1', 'action.settled=59842', 'action.completed'])
    await mounted.stop()
  })

  it('refuses the NEXT run on the settled total, naming the cost cap', async () => {
    // The end-to-end headline: an estimate of 1 walks under a cap of 1000, the run
    // settles at 59842, and the second run is refused on COST while the invocation
    // count is still 1. Before settlement this was unreachable — with cost fixed at
    // 1, a cost cap and an invocation cap could only ever fire on the same run.
    const mounted = mount(CLAUDE_STDOUT, { maxInvocations: 50, maxTotalCost: 1000 })
    await expect(mounted.service.run('settled#one', request())).resolves.toMatchObject({ status: 'ok' })
    await expect(mounted.service.run('settled#two', request())).rejects.toMatchObject({
      code: 'PANDA_KERNEL_COST_CAP_EXCEEDED',
      cap: 'cost',
    })
    // Refused BEFORE the executor spawned: one child, not two.
    expect(mounted.spawner.children).toHaveLength(1)
    await mounted.stop()
  })

  it('keeps the Story 1.7 stream exactly when no budget is configured', async () => {
    const mounted = mount(CLAUDE_STDOUT)
    await expect(mounted.service.run('silent#one', request())).resolves.toMatchObject({ status: 'ok' })
    expect(mounted.log.records.filter((record) => record.event.startsWith('action.')).map((r) => r.event)).toEqual([
      'action.invoked',
      'action.completed',
    ])
    await mounted.stop()
  })

  it.each([
    ['a negative number', -1_000_000],
    // A NON-number is the case a plugin could quietly swallow by type-checking
    // before forwarding. Measured: filtering non-numbers in the plugin turned this
    // into an ordinary unsettled run and no test noticed, so it gets its own clause.
    ['a string', '0'],
    ['a boolean', false],
    ['NaN', Number.NaN],
  ])('rejects %s from a host-supplied adapter coded, and keeps the estimate charged', async (_label, usage) => {
    // The only way a non-number reaches the settlement is a host-supplied adapter
    // (`createAdapter`), which is a real production seam. It gets the coded
    // rejection rather than a silent zero, and the estimate stands.
    const log = createMemoryLogSink()
    const kernel = createKernel({ log, actionPolicy: { maxTotalCost: 1 } })
    const plugin = createExecutorPlugin({
      cost: 1,
      createAdapter: () => ({
        run: () => Promise.resolve({ status: 'ok', data: { result: 'free!', usage }, summary: 'free!', errors: [] }),
      }),
    })
    kernel.register(plugin.manifest, plugin.factory)
    kernel.start()
    const resolved = kernel.getService<ExecutorService>(EXECUTOR_SERVICE)
    if (resolved.kind !== 'provided') throw new Error('the executor service did not activate')

    await expect(resolved.value.run('hostile#one', request())).resolves.toMatchObject({ status: 'ok' })
    expect(log.records.map((record) => record.event)).toContain('action.settle-rejected')
    // The estimate stood, so the cap of 1 is spent and the next run is refused.
    await expect(resolved.value.run('hostile#two', request())).rejects.toMatchObject({
      code: 'PANDA_KERNEL_COST_CAP_EXCEEDED',
    })
    await kernel.stop()
  })
})
