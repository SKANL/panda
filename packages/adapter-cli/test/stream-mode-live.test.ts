import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ResultEnvelope, UsageReport, WorkspaceHandle } from '@panda/contracts'
import { createCliExecutorAdapter } from '../src/traits.ts'
import type { ExecutorTraits } from '../src/traits.ts'
import { createNodeChildSpawner } from '../src/node-child-spawner.ts'
import { CLAUDE_CODE_TRAITS } from '../src/executors/claude-code.ts'

// Story M15.A's acceptance criterion 2, and the only place it can be met: THE
// ENVELOPE DID NOT CHANGE, proven against the old mode by running both rather
// than by asserting it.
//
// Two real invocations of `claude`, same prompt, one through the record panda
// shipped before this story and one through the record it ships now. Everything
// a caller can observe about the two envelopes is compared. The old record is
// reproduced here in full ON PURPOSE: a comparison against the current record
// with one field changed would be comparing the new mode with itself.
//
// It costs quota, so it is a `*live.test.ts` and it is skipped, with its reason
// printed, whenever the binary is missing, broken, unauthenticated, or
// PANDA_LIVE_STREAM=0. A provider outage never fails this suite.

const PROBE_TIMEOUT_MS = 20_000
const RUN_TIMEOUT_MS = 180_000

// The record `packages/adapter-cli/src/executors/claude-code.ts` carried at
// `fc6a693`, before this story. Kept as data, not as a git reference, because a
// comparison you cannot run is not a comparison.
const PRE_M15A_CLAUDE_TRAITS: ExecutorTraits = {
  executorId: 'claude-code',
  command: 'claude',
  args: Object.freeze(['--print', '--output-format', 'json', '--no-session-persistence', '--dangerously-skip-permissions']),
  promptDelivery: 'stdin',
  output: {
    payload: 'single-object',
    resultPath: ['result'],
    errorFlagPath: ['is_error'],
    statusPath: ['subtype'],
    errorStatusPrefix: 'error',
    metadata: { subtype: ['subtype'], session_id: ['session_id'] },
    usageWhen: { path: ['type'], equals: 'result' },
    usagePaths: [
      ['usage', 'input_tokens'],
      ['usage', 'output_tokens'],
      ['usage', 'cache_creation_input_tokens'],
      ['usage', 'cache_read_input_tokens'],
    ],
  },
}

const PROMPT = 'Reply with exactly the word ok and nothing else. Do not create or modify any file.'

const workspaces: string[] = []
afterAll(async () => {
  await Promise.all(
    workspaces.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})),
  )
})

interface Availability {
  readonly available: boolean
  readonly reason: string
}

async function probe(): Promise<Availability> {
  if (process.env['PANDA_LIVE_STREAM'] === '0') {
    return { available: false, reason: 'PANDA_LIVE_STREAM=0 explicitly disables the live stream-mode check' }
  }
  const child = createNodeChildSpawner().spawn('claude', ['--version'], { cwd: tmpdir() })
  child.endStdin()
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    child.done,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
  if (outcome === undefined) {
    child.killTree()
    return { available: false, reason: `claude --version exceeded ${PROBE_TIMEOUT_MS}ms` }
  }
  if (outcome.spawnErrorMessage !== undefined) {
    return { available: false, reason: `claude not detected: ${outcome.spawnErrorMessage}` }
  }
  // The EXIT STATUS, because "a process started" is not "the tool works".
  if (outcome.exitCode !== 0) return { available: false, reason: `claude --version exited ${outcome.exitCode}` }
  return { available: true, reason: outcome.stdout.trim() }
}

function looksUnauthenticated(envelope: ResultEnvelope): boolean {
  if (envelope.status !== 'failed') return false
  const message = envelope.errors?.map((error) => error.message).join('; ') ?? ''
  return /invalid api key|api key (is )?(invalid|required|missing)|not authenticated|unauthenticated|(please )?run `?claude login`?|oauth token|insufficient credit|rate limit/i.test(
    message,
  )
}

async function runLive(traits: ExecutorTraits): Promise<{ envelope: ResultEnvelope; reports: UsageReport[] }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'panda-stream-live-'))
  workspaces.push(rootPath)
  const workspace: WorkspaceHandle = { id: 'stream-live', rootPath, capabilities: ['read', 'write'] }
  const reports: UsageReport[] = []
  const adapter = createCliExecutorAdapter(traits, { onUsageObservation: (report) => reports.push(report) })
  const envelope = await adapter.run({ prompt: PROMPT, workspace, signal: AbortSignal.timeout(RUN_TIMEOUT_MS) })
  return { envelope, reports }
}

/** Everything a caller can observe about an envelope WITHOUT knowing the run. */
function shapeOf(envelope: ResultEnvelope): Record<string, unknown> {
  const data = (envelope.data ?? {}) as Record<string, unknown>
  return {
    keys: Object.keys(envelope).sort(),
    status: envelope.status,
    // Exit semantics, expressed exactly as `packages/cli/src/run.ts` computes
    // them, because that is the observable a script branches on.
    exitCode: envelope.status === 'ok' ? 0 : 1,
    dataKeys: Object.keys(data).sort(),
    dataTypes: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value])),
    errorCount: envelope.errors?.length ?? 0,
    summaryIsNonEmpty: envelope.summary.trim().length > 0,
  }
}

describe('live: the stream mode produces the envelope the single-object mode produced', () => {
  it(
    'runs the same prompt through both records and compares what a caller can see',
    async (ctx) => {
      const availability = await probe()
      if (!availability.available) ctx.skip(`live stream-mode check skipped: ${availability.reason}`)

      const old = await runLive(PRE_M15A_CLAUDE_TRAITS)
      if (looksUnauthenticated(old.envelope)) {
        ctx.skip(`claude detected but unusable: ${old.envelope.errors?.[0]?.message}`)
      }
      const now = await runLive(CLAUDE_CODE_TRAITS)
      if (looksUnauthenticated(now.envelope)) {
        ctx.skip(`claude detected but unusable: ${now.envelope.errors?.[0]?.message}`)
      }

      // The criterion. Values cannot be compared — a session id and a token
      // count differ between any two runs — so what is compared is the key set,
      // the type of every value, the status, and the exit code they imply.
      expect(now.envelope.status).toBe('ok')
      expect(shapeOf(now.envelope)).toEqual(shapeOf(old.envelope))

      // AC-2 names the exit code explicitly, so it is asserted as a value too
      // and not only through the shape above.
      expect(now.envelope.status === 'ok' ? 0 : 1).toBe(old.envelope.status === 'ok' ? 0 : 1)

      // M2's control, re-measured: the mode panda passed before this story
      // CANNOT see the quota surface, which is why 5-6 looked blocked. If this
      // ever stops holding, the story's premise has changed and should be
      // re-read rather than worked around.
      expect(old.reports).toEqual([])

      // And the capability the switch was for, from the same pair of runs.
      const observation = now.reports[0]
      expect(observation?.kind, `claude reported no quota surface: ${JSON.stringify(now.reports)}`).toBe('observed')
      if (observation?.kind !== 'observed') throw new Error('unreachable')
      expect(observation.windows.length).toBeGreaterThan(0)
      for (const window of observation.windows) {
        expect(window.name.length).toBeGreaterThan(0)
        expect(Number.isFinite(window.utilization)).toBe(true)
        expect(Number.isFinite(window.resetsAt)).toBe(true)
      }
      // The vendor's vocabulary as MEASURED on 2.1.260. A rename is a real
      // change to what panda reports, so it fails here loudly instead of
      // silently reporting one window fewer.
      expect(observation.windows.map((window) => window.name)).toContain('five_hour')
    },
    RUN_TIMEOUT_MS * 2 + PROBE_TIMEOUT_MS + 10_000,
  )
})
