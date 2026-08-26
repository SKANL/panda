import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createMemoryLogSink, KERNEL_ERROR_CODES } from '@panda/kernel'
import type { MemoryLogSink, PandaKernel } from '@panda/kernel'
import type { ChildProcessSpawner, SpawnOutcome, SpawnedChild } from '@panda/adapter-cli'
import { createSessionKernel, runSession, SESSION_ACTION_COST } from '../src/index.ts'

// Story M3.C, end to end: a session's executor run is admitted at
// `SESSION_ACTION_COST` and settled against what the executor itself reported.
//
// Everything here runs on the PRODUCTION path — the selection, the catalogue, the
// vendor trait record and the trait-driven output engine all participate, because
// the only seam injected is the child process. Injecting `createAdapter` instead
// would have skipped exactly the wiring under test.

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
})

/** claude's real print-mode payload shape, with a usage figure this test chooses. */
function claudePayload(totalTokens: number): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: 's-1',
    // Split across the four disjoint components claude really reports, so the sum
    // is the engine's rather than a single field this test handed it.
    usage: {
      input_tokens: totalTokens - 3,
      output_tokens: 1,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 1,
    },
  })
}

class ScriptedChild implements SpawnedChild {
  pid: number | undefined = 999
  killed = false
  settled = false
  readonly done: Promise<SpawnOutcome>
  #resolve!: (outcome: SpawnOutcome) => void

  constructor(private readonly stdout: string) {
    this.done = new Promise<SpawnOutcome>((resolve) => {
      this.#resolve = resolve
    })
  }

  writeStdin(): void {}

  endStdin(): void {
    queueMicrotask(() => this.#settle({ exitCode: 0, stdout: this.stdout, stderr: '' }))
  }

  killTree(): void {
    this.killed = true
    this.#settle({ exitCode: null, stdout: '', stderr: '' })
  }

  #settle(outcome: SpawnOutcome): void {
    if (this.settled) return
    this.settled = true
    this.#resolve(outcome)
  }
}

/** Hands each successive run the next scripted stdout, and counts the spawns. */
class ScriptedSpawner implements ChildProcessSpawner {
  spawns = 0

  constructor(private readonly outputs: readonly string[]) {}

  spawn(): SpawnedChild {
    const stdout = this.outputs[Math.min(this.spawns, this.outputs.length - 1)] ?? ''
    this.spawns += 1
    return new ScriptedChild(stdout)
  }
}

async function sharedKernel(
  outputs: readonly string[],
  actionPolicy: { readonly maxInvocations?: number; readonly maxTotalCost?: number },
): Promise<{ kernel: PandaKernel; spawner: ScriptedSpawner; log: MemoryLogSink; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'panda-settlement-'))
  roots.push(cwd)
  const spawner = new ScriptedSpawner(outputs)
  const log = createMemoryLogSink()
  // ONE kernel across both sessions, which is the only shape in which a budget
  // means anything: a cap only bounds what shares its pipeline.
  const kernel = createSessionKernel({
    cwd,
    executorId: 'claude-code',
    adapterOptions: { spawner },
    actionPolicy,
    log,
  })
  return { kernel, spawner, log, cwd }
}

describe('a session run is settled against what the executor reported', () => {
  it('refuses the SECOND run on the cost cap while the invocation count is still 1', async () => {
    // The story's headline, at session level. `SESSION_ACTION_COST` is 1, the cap
    // is 1000, so the first run walks in on its estimate; it settles at 5000, and
    // the second is refused on COST — with `maxInvocations` set to 50 and only one
    // invocation spent, so the invocation cap demonstrably was not the one that
    // fired. Before settlement this run could not exist: with the cost fixed at 1,
    // the two caps could only ever refuse on the same run.
    const shared = await sharedKernel([claudePayload(5000)], { maxInvocations: 50, maxTotalCost: 1000 })
    try {
      await expect(runSession({ prompt: 'one', kernel: shared.kernel })).resolves.toMatchObject({ status: 'ok' })

      const refusal: unknown = await runSession({ prompt: 'two', kernel: shared.kernel }).catch(
        (error: unknown) => error,
      )
      expect((refusal as { code?: string }).code).toBe(KERNEL_ERROR_CODES.costCapExceeded)
      // Refused BEFORE the executor spawned: one child, not two.
      expect(shared.spawner.spawns).toBe(1)
      // And the estimate alone would never have reached the cap.
      expect(SESSION_ACTION_COST * 2).toBeLessThan(1000)
    } finally {
      await shared.kernel.stop()
    }
  })

  it('refuses on the INVOCATION cap instead when the same runs are cheap', async () => {
    // Same policy shape, same session code, cheap runs. The refusal changes cap
    // AND code, which is the discrimination the caps could not express before.
    const shared = await sharedKernel([claudePayload(10)], { maxInvocations: 1, maxTotalCost: 1000 })
    try {
      await expect(runSession({ prompt: 'one', kernel: shared.kernel })).resolves.toMatchObject({ status: 'ok' })
      const refusal: unknown = await runSession({ prompt: 'two', kernel: shared.kernel }).catch(
        (error: unknown) => error,
      )
      expect((refusal as { code?: string }).code).toBe(KERNEL_ERROR_CODES.invocationCapExceeded)
    } finally {
      await shared.kernel.stop()
    }
  })

  it('shows the estimate and the settlement in the record stream, with the usage on the envelope', async () => {
    // A budget that never bites. The settlement records exist only where a policy
    // does, so a `panda run` with no caps keeps the Story 1.7 stream exactly and
    // a host that IS budgeting can reconstruct its own total from the records.
    const shared = await sharedKernel([claudePayload(4096)], { maxTotalCost: 1_000_000 })
    try {
      const envelope = await runSession({ prompt: 'one', kernel: shared.kernel })
      expect((envelope.data as Record<string, unknown>)['usage']).toBe(4096)
      expect(
        shared.log.records
          .filter((record) => record.event.startsWith('action.'))
          .map((record) => `${record.event}${record.cost === undefined ? '' : `=${record.cost}`}`),
      ).toEqual([
        'action.invoked',
        `action.estimated=${SESSION_ACTION_COST}`,
        'action.settled=4096',
        'action.completed',
      ])
    } finally {
      await shared.kernel.stop()
    }
  })

  it('keeps the Story 1.7 stream exactly when the session sets no budget', async () => {
    const shared = await sharedKernel([claudePayload(4096)], {})
    try {
      await expect(runSession({ prompt: 'one', kernel: shared.kernel })).resolves.toMatchObject({ status: 'ok' })
      expect(
        shared.log.records.filter((record) => record.event.startsWith('action.')).map((record) => record.event),
      ).toEqual(['action.invoked', 'action.completed'])
    } finally {
      await shared.kernel.stop()
    }
  })

  it('leaves a run whose executor reports nothing charged its estimate, not zero', async () => {
    const silent = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
    // A cap of exactly one estimate: the second run is refused only if the first
    // one was charged, which is what "never silently zero" has to mean.
    const shared = await sharedKernel([silent], { maxTotalCost: SESSION_ACTION_COST })
    try {
      const envelope = await runSession({ prompt: 'one', kernel: shared.kernel })
      expect(Object.hasOwn(envelope.data as object, 'usage')).toBe(false)
      const refusal: unknown = await runSession({ prompt: 'two', kernel: shared.kernel }).catch(
        (error: unknown) => error,
      )
      expect((refusal as { code?: string }).code).toBe(KERNEL_ERROR_CODES.costCapExceeded)
      // The estimate is in the stream and no settlement follows it, so a reader
      // reconstructing the total gets exactly what was charged.
      expect(
        shared.log.records
          .filter((record) => record.event.startsWith('action.'))
          .map((record) => `${record.event}${record.cost === undefined ? '' : `=${record.cost}`}`),
      ).toEqual([
        'action.invoked',
        `action.estimated=${SESSION_ACTION_COST}`,
        'action.completed',
        'action.refused',
      ])
    } finally {
      await shared.kernel.stop()
    }
  })
})
