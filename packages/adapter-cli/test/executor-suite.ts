import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, runExecutorContractSuite } from '@panda/contracts'
import type { RunRequest, WorkspaceHandle } from '@panda/contracts'
import type {
  ChildProcessSpawner,
  CliExecutorAdapter,
  CliExecutorAdapterOptions,
  PayloadShape,
  PromptDelivery,
  SpawnOutcome,
} from '../src/index.ts'
import { FakeSpawner } from './fake-spawner.ts'

// Shared executor clause suite: every adapter — shipped or trait-only stub —
// runs the SAME Story 1.4 contract suite plus the trait-axis clauses, driven
// uniformly through this runner. Fake spawners exclusively: no clause here may
// ever start a real binary, which is also why running the contract suite four
// times per adapter costs nothing.

export const PROMPT = 'do a thing'

// Trailing noise a real stream can end with: blank lines, a non-object line,
// and a bookkeeping event carrying no result.
const TRAILING_NOISE = '\nnot an event at all\n[]\n\n'

export interface ExecutorClauseCase {
  readonly label: string
  /** Identity the trait record declares; must survive onto the adapter. */
  readonly executorId: string
  /** Binary the adapter is expected to spawn; also what its errors must name. */
  readonly command: string
  readonly makeAdapter: (options: CliExecutorAdapterOptions) => CliExecutorAdapter
  readonly promptDelivery: PromptDelivery
  readonly payload: PayloadShape
  /** The COMPLETE argv expected for `PROMPT`, separator and all. */
  readonly expectedArgs: readonly string[]
  /** stdout of a successful run, in this executor's payload shape. */
  readonly okStdout: string
  /** The result text `okStdout` carries. */
  readonly expectedResult: string
  /** Everything besides `result` this executor's traits put into `data`. */
  readonly expectedMetadata: Readonly<Record<string, string>>
  /** stdout of a run the executor itself reports as failed, while exiting 0. */
  readonly reportedFailureStdout: string
  /** The reason `reportedFailureStdout` states; must reach the envelope. */
  readonly expectedFailureDetail: string
}

function probeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  const handle: WorkspaceHandle = {
    id: 'probe',
    rootPath: join(tmpdir(), 'panda-probe'),
    capabilities: ['read', 'write'],
  }
  return { prompt: PROMPT, workspace: handle, ...overrides }
}

export function runExecutorClauseSuite(cases: readonly ExecutorClauseCase[]): void {
  describe.each(cases)('executor clause suite — $label', (clauseCase) => {
    const isJsonl = clauseCase.payload === 'jsonl'
    const adapterWith = (outcome?: SpawnOutcome, options: CliExecutorAdapterOptions = {}) => {
      const spawner = new FakeSpawner(outcome)
      return { spawner, adapter: clauseCase.makeAdapter({ spawner, ...options }) }
    }
    const okOutcome: SpawnOutcome = { exitCode: 0, stdout: clauseCase.okStdout, stderr: '' }
    const okData = { result: clauseCase.expectedResult, ...clauseCase.expectedMetadata }

    it('passes every clause of the Story 1.4 contract suite', async () => {
      const { spawner, adapter } = adapterWith(okOutcome)
      const report = await runExecutorContractSuite(adapter)

      if (!report.passed) {
        const detail = report.violations.map((violation) => `${violation.clause}: ${violation.detail}`).join('\n')
        throw new Error(`contract suite violations:\n${detail}`)
      }
      // Order-independent: the cancellation clause must have terminated its own
      // child, and no clause may leave one running.
      expect(spawner.children.some((child) => child.killed)).toBe(true)
      expect(spawner.orphans).toHaveLength(0)
    })

    it('spawns the executor with its exact documented argv', async () => {
      const { spawner, adapter } = adapterWith(okOutcome)
      await adapter.run(probeRequest())

      const child = spawner.children[0]
      // `command` is overridable per instance, so identity comes from the record.
      expect(adapter.executorId).toBe(clauseCase.executorId)
      expect(child?.command).toBe(clauseCase.command)
      expect(child?.options.cwd).toBe(probeRequest().workspace.rootPath)
      expect(child?.args).toEqual(clauseCase.expectedArgs)
      expect(child?.stdinEnded).toBe(true)
      if (clauseCase.promptDelivery === 'stdin') {
        expect(child?.stdinChunks.join('')).toBe(PROMPT)
        // A prompt in argv could hit a command-line length limit; it must not leak there.
        expect(child?.args).not.toContain(PROMPT)
      } else {
        expect(child?.args.at(-1)).toBe(PROMPT)
        expect(child?.stdinChunks).toEqual([])
      }
    })

    it('honours a command override without changing the executor identity', async () => {
      const { spawner, adapter } = adapterWith(okOutcome, { command: 'panda-custom-binary' })
      const envelope = await adapter.run(probeRequest())

      expect(spawner.children[0]?.command).toBe('panda-custom-binary')
      expect(adapter.executorId).toBe(clauseCase.executorId)
      expect(envelope.status).toBe('ok')
    })

    it('maps a successful payload to an ok envelope carrying result and metadata', async () => {
      const { adapter } = adapterWith(okOutcome)
      const envelope = await adapter.run(probeRequest())

      expect(envelope.status).toBe('ok')
      // toEqual, not toMatchObject: an absent metadata key must fail too.
      expect(envelope.data).toEqual(okData)
      expect(envelope.summary.length).toBeGreaterThan(0)
      expect(envelope.errors).toEqual([])
    })

    it('tolerates a UTF-8 BOM ahead of the payload', async () => {
      const { adapter } = adapterWith({ exitCode: 0, stdout: `\uFEFF${clauseCase.okStdout}`, stderr: '' })
      const envelope = await adapter.run(probeRequest())

      expect(envelope.status).toBe('ok')
      expect(envelope.data).toEqual(okData)
    })

    it('reports the executor’s own reason on a failure it declares at exit code 0', async () => {
      const { adapter } = adapterWith({ exitCode: 0, stdout: clauseCase.reportedFailureStdout, stderr: '' })
      const envelope = await adapter.run(probeRequest())

      expect(envelope.status).toBe('failed')
      expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
      expect(envelope.errors?.[0]?.message).toContain(clauseCase.expectedFailureDetail)
      expect(envelope.summary.length).toBeGreaterThan(0)
    })

    it('keeps the structured payload when the executor exits non-zero', async () => {
      const { adapter } = adapterWith({ exitCode: 1, stdout: clauseCase.okStdout, stderr: 'noise on stderr' })
      const envelope = await adapter.run(probeRequest())

      expect(envelope.status).toBe('failed')
      expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
      // The reason and the payload survive; a bare stderr dump would lose both.
      expect(envelope.data).toEqual(okData)
    })

    it('refuses a truncated capture instead of reporting a partial answer as ok', async () => {
      const { adapter } = adapterWith({ ...okOutcome, stdoutTruncated: true })
      const envelope = await adapter.run(probeRequest())

      expect(envelope.status).toBe('failed')
      expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
      expect(envelope.errors?.[0]?.message).toContain('incomplete')
      expect(envelope.data).toMatchObject({ stdoutTruncated: true })
    })

    it('fails naming the executor when stdout carries no usable result', async () => {
      // Third case: a result that is present but blank must not shadow a real answer.
      const blankResult = clauseCase.okStdout.replace(JSON.stringify(clauseCase.expectedResult), '"   "')
      for (const stdout of ['not json at all', JSON.stringify({ nothing: 'useful' }), blankResult]) {
        const { adapter } = adapterWith({ exitCode: 0, stdout, stderr: '' })
        const envelope = await adapter.run(probeRequest())
        expect(envelope.status).toBe('failed')
        expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
        expect(envelope.errors?.[0]?.message).toContain(`'${clauseCase.command}'`)
      }
    })

    it('maps a missing binary to a coded unavailable envelope', async () => {
      const { adapter } = adapterWith({
        exitCode: null,
        stdout: '',
        stderr: '',
        spawnErrorMessage: `spawn ${clauseCase.command} ENOENT`,
      })
      const envelope = await adapter.run(probeRequest())

      expect(envelope.status).toBe('failed')
      expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorUnavailable)
      expect(envelope.errors?.[0]?.message).toContain(`'${clauseCase.command}'`)
      expect(envelope.errors?.[0]?.message).toContain('ENOENT')
    })

    it('kills the process tree and resolves cancelled when abort lands mid-run', async () => {
      // No auto-outcome: the child stays in flight until the abort kills it.
      const { spawner, adapter } = adapterWith()
      const controller = new AbortController()
      const pending = adapter.run(probeRequest({ signal: controller.signal }))
      controller.abort()

      const envelope = await pending
      expect(spawner.children[0]?.killed).toBe(true)
      expect(spawner.orphans).toHaveLength(0)
      expect(envelope.status).toBe('cancelled')
      expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorCancelled)
    })

    it('returns the real ok envelope when abort lands after the child already exited 0', async () => {
      let finishChild: ((outcome: SpawnOutcome) => void) | undefined
      let settled = false
      const spawner: ChildProcessSpawner = {
        spawn: () => ({
          pid: 7,
          get settled() {
            return settled
          },
          writeStdin() {},
          endStdin() {},
          killTree() {},
          done: new Promise<SpawnOutcome>((resolve) => {
            finishChild = (outcome) => {
              settled = true
              resolve(outcome)
            }
          }),
        }),
      }
      const controller = new AbortController()
      const pending = clauseCase.makeAdapter({ spawner }).run(probeRequest({ signal: controller.signal }))
      queueMicrotask(() => finishChild?.(okOutcome))
      await Promise.resolve()
      await Promise.resolve()
      controller.abort()

      const envelope = await pending
      expect(envelope.status).toBe('ok')
      expect(envelope.data).toEqual(okData)
    })

    it('kills the child when the prompt cannot be piped to it', async () => {
      const spawner = new FakeSpawner()
      const throwOnWrite = clauseCase.promptDelivery === 'stdin'
      spawner.failStdin(throwOnWrite ? 'write' : 'end', 'write EPIPE')
      const envelope = await clauseCase.makeAdapter({ spawner }).run(probeRequest())

      expect(envelope.status).toBe('failed')
      expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
      expect(envelope.errors?.[0]?.message).toContain('EPIPE')
      // An unreachable child left running would keep working the workspace.
      expect(spawner.children[0]?.killed).toBe(true)
      expect(spawner.orphans).toHaveLength(0)
    })

    it.skipIf(clauseCase.promptDelivery !== 'argument')(
      'keeps a prompt that starts with a dash out of flag position',
      async () => {
        const { spawner, adapter } = adapterWith(okOutcome)
        await adapter.run(probeRequest({ prompt: '--help me instead' }))

        const args = spawner.children[0]?.args ?? []
        expect(args.at(-1)).toBe('--help me instead')
        // Either a separator shields it, or the record documents having none.
        const shielded = args.at(-2) === '--'
        expect(shielded || !clauseCase.expectedArgs.includes('--')).toBe(true)
      },
    )

    it.skipIf(!isJsonl)('ignores trailing noise and still finds the last qualifying event', async () => {
      const { adapter } = adapterWith({ exitCode: 0, stdout: clauseCase.okStdout + TRAILING_NOISE, stderr: '' })
      const envelope = await adapter.run(probeRequest())

      expect(envelope.status).toBe('ok')
      expect(envelope.data).toEqual(okData)
    })

    it.skipIf(!isJsonl)('fails when a declared failure is followed by more output', async () => {
      // Emission order is not a contract: OpenCode emits recoverable error
      // events and keeps going, so a positional rule would drop the reason.
      const { adapter } = adapterWith({
        exitCode: 0,
        stdout: clauseCase.reportedFailureStdout + clauseCase.okStdout,
        stderr: '',
      })
      const envelope = await adapter.run(probeRequest())

      expect(envelope.status).toBe('failed')
      expect(envelope.errors?.[0]?.message).toContain(clauseCase.expectedFailureDetail)
    })
  })
}
