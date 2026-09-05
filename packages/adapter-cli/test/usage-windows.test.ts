import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { USAGE_ABSENCE_REASONS } from '@skanl/panda-contracts'
import type { RunRequest, UsageReport, WorkspaceHandle } from '@skanl/panda-contracts'
import { createCliExecutorAdapter } from '../src/traits.ts'
import type { ExecutorTraits } from '../src/traits.ts'
import { CLAUDE_CODE_TRAITS } from '../src/executors/claude-code.ts'
import { CODEX_TRAITS } from '../src/executors/codex.ts'
import { OPENCODE_TRAITS } from '../src/executors/opencode.ts'
import { FakeSpawner } from './fake-spawner.ts'

// The vendor's own quota surface, read out of the stream (Story M15.A).
//
// PROVENANCE OF THE FIXTURE, because it decides what these clauses are worth:
// `RATE_LIMIT_LINE` is one line of REAL stdout, copied byte for byte out of
// `claude --print --output-format stream-json --verbose` on 2.1.260, run on
// 2026-09-03. It is not a shape anybody wrote down from a document. The
// `system/init` line of that same capture is deliberately NOT here — it carries
// the machine's own paths, plugin list and shell — and `test/stream-mode-live.test.ts`
// is the clause that drives the whole thing against the binary instead.
//
// What these clauses can and cannot prove: they exercise the PARSER over bytes
// the vendor really emitted, once, cheaply, on every run of the suite. What only
// the live suite can prove is that the vendor still emits them.

const RATE_LIMIT_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788491400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.13,"resetsAt":1788491400},"seven_day":{"utilization":0.22,"resetsAt":1788728400}}},"uuid":"b295ba9b-fd19-475a-8940-e556b380ba33","session_id":"19cad68a-e422-4907-a11b-75638899e5ac"}'

// The terminal event, with the fields M4 measured on it and nothing invented.
const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_api_ms: 1736,
  stop_reason: 'end_turn',
  session_id: '19cad68a-e422-4907-a11b-75638899e5ac',
  total_cost_usd: 0.448086,
  usage: { input_tokens: 2, output_tokens: 4, cache_creation_input_tokens: 44211, cache_read_input_tokens: 11732 },
  result: 'ok',
})

// The event types that really precede them, in the order the capture had them.
const SYSTEM_LINES = [
  JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'a-hook', session_id: 's' }),
  JSON.stringify({ type: 'system', subtype: 'hook_response', exit_code: 0, session_id: 's' }),
  JSON.stringify({ type: 'system', subtype: 'informational', level: 'info', content: 'something', session_id: 's' }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant' }, session_id: 's' }),
]

function stream(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}

const FULL_STREAM = stream(...SYSTEM_LINES, RATE_LIMIT_LINE, RESULT_LINE)

function probeRequest(): RunRequest {
  const workspace: WorkspaceHandle = {
    id: 'usage-windows',
    rootPath: join(tmpdir(), 'panda-usage-windows'),
    capabilities: ['read', 'write'],
  }
  return { prompt: 'say ok', workspace }
}

/** One run of `traits` over `stdout`, returning the envelope and every report. */
async function run(traits: ExecutorTraits, stdout: string, exitCode: number | null = 0) {
  const reports: UsageReport[] = []
  const adapter = createCliExecutorAdapter(traits, {
    spawner: new FakeSpawner({ exitCode, stdout, stderr: '' }),
    onUsageObservation: (report) => reports.push(report),
  })
  return { envelope: await adapter.run(probeRequest()), reports }
}

describe("claude's own quota surface, read out of its stream", () => {
  it('reports the windows the VENDOR named, with the vendor\'s own numbers (E1)', async () => {
    const before = Date.now()
    const { envelope, reports } = await run(CLAUDE_CODE_TRAITS, FULL_STREAM)

    expect(envelope.status).toBe('ok')
    expect(reports).toHaveLength(1)
    const report = reports[0]
    if (report?.kind !== 'observed') throw new Error(`expected an observation, got ${JSON.stringify(report)}`)
    // Verbatim, and asserted as a whole rather than field by field: a clause
    // that checked only the names could not see a scaled utilisation, and one
    // that checked only the numbers could not see a renamed window.
    expect(report.windows).toEqual([
      { name: 'five_hour', utilization: 0.13, resetsAt: 1788491400 },
      { name: 'seven_day', utilization: 0.22, resetsAt: 1788728400 },
    ])
    expect(report.executorId).toBe('claude-code')
    // D7: the reading carries WHEN it was taken, and the instant is real.
    expect(Date.parse(report.observedAt)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(report.observedAt)).toBeLessThanOrEqual(Date.now())
  })

  it('derives NOTHING the vendor did not state (D5)', async () => {
    const { reports } = await run(CLAUDE_CODE_TRAITS, FULL_STREAM)
    const report = reports[0]
    if (report?.kind !== 'observed') throw new Error('expected an observation')

    // The plausible derivations, each one refused. `0.13` must not have become
    // 13 (a percentage), `0.87` (a remaining figure), or `0.175` (an average of
    // the two windows) — and the reset must still be the vendor's own instant
    // rather than a duration measured from now.
    const utilizations = report.windows.map((window) => window.utilization)
    expect(utilizations).toEqual([0.13, 0.22])
    expect(utilizations).not.toContain(13)
    expect(utilizations).not.toContain(0.87)
    expect(utilizations).not.toContain(0.175)
    expect(report.windows.map((window) => window.resetsAt)).toEqual([1788491400, 1788728400])
    // And no window panda made up: exactly the two names the vendor used.
    expect(report.windows.map((window) => window.name)).toEqual(['five_hour', 'seven_day'])
  })

  it('reports typed absence, never a zero, when the run carried no surface (E2)', async () => {
    const { envelope, reports } = await run(CLAUDE_CODE_TRAITS, stream(...SYSTEM_LINES, RESULT_LINE))

    expect(envelope.status).toBe('ok')
    expect(reports).toHaveLength(1)
    const report = reports[0]
    if (report?.kind !== 'absent') throw new Error('expected typed absence')
    expect(report.reason).toBe(USAGE_ABSENCE_REASONS.notReported)
    expect(report.detail).toContain('rate_limit_info.unifiedWindows')
    // The whole point of D4: absence is absence, not a measurement of nothing.
    expect(JSON.stringify(report)).not.toContain('utilization')
    expect(Object.hasOwn(report, 'windows')).toBe(false)
  })

  it('keeps the reading a CANCELLED run already paid for', async () => {
    // The child printed its quota before it was cut off, and those bytes are in
    // hand. Discarding them would make cancelling a way to lose a reading panda
    // has already been charged for — the same hole `usage` was fixed for.
    //
    // `FakeSpawner` cannot express this: its `killTree` settles with an EMPTY
    // stdout, where the real spawner settles through `close` carrying everything
    // the child had already printed. So this clause brings its own child, which
    // models the real one on exactly that point and on nothing else.
    const controller = new AbortController()
    const reports: UsageReport[] = []
    let settle: (outcome: { exitCode: number | null; stdout: string; stderr: string }) => void = () => {}
    const done = new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
      settle = resolve
    })
    const adapter = createCliExecutorAdapter(CLAUDE_CODE_TRAITS, {
      onUsageObservation: (report) => reports.push(report),
      spawner: {
        spawn: () => ({
          pid: 99,
          settled: false,
          writeStdin() {},
          endStdin() {},
          killTree() {
            settle({ exitCode: null, stdout: FULL_STREAM, stderr: '' })
          },
          done,
        }),
      },
    })
    const settledRun = adapter.run({ ...probeRequest(), signal: controller.signal })
    controller.abort()
    const envelope = await settledRun

    expect(envelope.status).toBe('cancelled')
    expect(reports[0]?.kind).toBe('observed')
  })

  it('takes the LAST reading when a stream carries two', async () => {
    const later = RATE_LIMIT_LINE.replace('"utilization":0.13', '"utilization":0.41')
    const { reports } = await run(CLAUDE_CODE_TRAITS, stream(RATE_LIMIT_LINE, later, RESULT_LINE))
    const report = reports[0]
    if (report?.kind !== 'observed') throw new Error('expected an observation')
    expect(report.windows[0]).toEqual({ name: 'five_hour', utilization: 0.41, resetsAt: 1788491400 })
  })
})

describe('the stream is read without changing what the run means', () => {
  it('keeps a completed run when a malformed line lands mid-stream, and counts it (E6)', async () => {
    // PLANTED between the quota event and the result — the position that
    // matters. A parser that gave up here would throw away a run the vendor
    // completed AND the reading it had already delivered.
    const planted = stream(...SYSTEM_LINES, RATE_LIMIT_LINE, '{"type":"result", oh no', RESULT_LINE)
    const { envelope, reports } = await run(CLAUDE_CODE_TRAITS, planted)

    expect(envelope.status).toBe('ok')
    expect(envelope.summary).toBe('ok')
    expect(envelope.data).toMatchObject({ result: 'ok', session_id: '19cad68a-e422-4907-a11b-75638899e5ac' })
    expect((envelope.data as Record<string, unknown>)['malformedStreamLines']).toBe(1)
    expect(reports[0]?.kind).toBe('observed')
  })

  it('fails with a coded reason naming what was missing when no result arrives (E5)', async () => {
    // A stream that ended early is not a run that FAILED: the executor never
    // said anything about the task. The envelope has to be able to say which.
    const { envelope } = await run(CLAUDE_CODE_TRAITS, stream(...SYSTEM_LINES, RATE_LIMIT_LINE))

    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe('PANDA_EXECUTOR_RUN_FAILED')
    // It names the thing that was missing — the `result` the traits look for —
    // rather than reporting the run as one the executor failed.
    expect(envelope.errors?.[0]?.message).toContain("without a usable 'result' result")

    // And the OTHER half of E5, where not one line parsed at all: a different
    // sentence, because "the stream ended early" and "the stream was garbage"
    // are different problems with different fixes.
    const garbage = await run(CLAUDE_CODE_TRAITS, 'not json\nstill not json\n')
    expect(garbage.envelope.status).toBe('failed')
    expect(garbage.envelope.errors?.[0]?.message).toContain("no JSON event carrying a 'result' result")
    expect((garbage.envelope.data as Record<string, unknown>)['malformedStreamLines']).toBe(2)
  })

  it("reads Claude's failure vocabulary off the RESULT and off nothing else", async () => {
    // The widening `failureWhen` exists to prevent, planted: a `system` event
    // whose own subtype begins with `error`. Under the single-object mode there
    // was one record and this could not arise; in a stream it can, and without
    // the discriminator this run would come out FAILED while the vendor
    // delivered a successful result.
    const noise = JSON.stringify({ type: 'system', subtype: 'error_hook_timeout', session_id: 's' })
    const { envelope } = await run(CLAUDE_CODE_TRAITS, stream(noise, RATE_LIMIT_LINE, RESULT_LINE))

    expect(envelope.status).toBe('ok')
    expect(envelope.summary).toBe('ok')
  })

  it('still fails when the RESULT itself reports the failure', async () => {
    // The control for the clause above: narrowing the scan must not have made
    // the failure path unreachable.
    const failed = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'gave up' })
    const { envelope } = await run(CLAUDE_CODE_TRAITS, stream(RATE_LIMIT_LINE, failed))

    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.message).toContain('error_max_turns')
  })
})

describe('an executor that publishes no usage surface reports nothing at all', () => {
  // NOT a zero and NOT an error: the adapter stays silent, and `panda status`
  // states the absence from the catalogue instead — an answer that is a property
  // of the executor rather than of any one run (E3).
  for (const traits of [CODEX_TRAITS, OPENCODE_TRAITS]) {
    it(`${traits.executorId} declares no window surface and emits no report`, async () => {
      expect(traits.output.usageWindows).toBeUndefined()
      // Driven with a stream that DOES carry claude's quota event, so this is a
      // refusal to read a surface that is present rather than an absence of one.
      const ok =
        traits.executorId === 'codex'
          ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })
          : JSON.stringify({ type: 'text', part: { type: 'text', text: 'done' } })
      const { envelope, reports } = await run(traits, stream(RATE_LIMIT_LINE, ok))

      expect(envelope.status).toBe('ok')
      expect(reports).toEqual([])
    })
  }
})

describe('the trait record refuses a quota surface that could never fire', () => {
  const base = { ...CLAUDE_CODE_TRAITS.output.usageWindows! }
  const withWindows = (overrides: Partial<typeof base>): ExecutorTraits => ({
    ...CLAUDE_CODE_TRAITS,
    output: { ...CLAUDE_CODE_TRAITS.output, usageWindows: { ...base, ...overrides } },
  })

  it.each([
    ['an empty discriminator path', withWindows({ when: { path: [], equals: 'rate_limit_event' } })],
    ['an empty window path', withWindows({ path: [] })],
    ['an empty utilization key', withWindows({ utilizationKey: '' })],
    ['an empty resetsAt key', withWindows({ resetsAtKey: '' })],
  ])('rejects %s at construction', (_label, traits) => {
    // Each of these builds an adapter that reports "no quota, ever" while
    // looking configured — the inert shape AD-5 forbids dressing as absence.
    expect(() => createCliExecutorAdapter(traits)).toThrow(/usageWindows/)
  })

  it('accepts the shipped record, so the rejections above are not rejecting everything', () => {
    expect(() => createCliExecutorAdapter(CLAUDE_CODE_TRAITS)).not.toThrow()
  })
})
