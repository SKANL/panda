import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTRACT_PROBE_REQUEST,
  CONTRACT_PROBE_WORKSPACE_HANDLE,
  EXECUTOR_CLAUSES,
  PANDA_ERROR_CODES,
  PandaError,
  RESULT_ENVELOPE_SCHEMA,
  runExecutorContractSuite,
} from '../src'
import type { ClauseResult } from '../src'
import { validateRunRequest } from '../src'
import type { WorkspaceCapability } from '../src'
import type { ExecutorAdapter, ResultEnvelope } from '../src'
import type { MemoryContractHarness, MemoryProvider, SuiteReport, WorkspaceProvider } from '../src'
import { runMemoryContractSuite, runWorkspaceContractSuite, validateWorkspaceHandle } from '../src'

const CANCELLED_ENVELOPE: ResultEnvelope = {
  status: 'cancelled',
  data: null,
  summary: 'run cancelled',
  errors: [{ message: 'cancelled by caller', code: 'PANDA_EXECUTOR_CANCELLED' }],
}

function stubAdapter(envelope: ResultEnvelope): ExecutorAdapter {
  return {
    async run(request) {
      // Yield first so a synchronously-issued abort (as the cancellation clause
      // does) is observed before resolution, like any real out-of-process executor.
      await Promise.resolve()
      if (request.signal?.aborted) return CANCELLED_ENVELOPE
      return envelope
    },
  }
}

const ALL_CLAUSE_NAMES = EXECUTOR_CLAUSES.map((clause) => clause.name)

describe('executor contract suite', () => {
  it('passes a compliant adapter with zero violations and reports per-clause outcomes', async () => {
    const report = await runExecutorContractSuite(
      stubAdapter({ status: 'ok', data: { echoed: true }, summary: 'echoed the prompt' }),
    )
    expect(report.suite).toBe('executor-adapter')
    expect(report.clauses).toEqual(ALL_CLAUSE_NAMES)
    expect(report.passed).toBe(true)
    expect(report.violations).toEqual([])
    expect(report.outcomes.map((outcome) => outcome.clause)).toEqual(ALL_CLAUSE_NAMES)
    for (const outcome of report.outcomes as readonly ClauseResult[]) {
      expect(outcome.passed).toBe(true)
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('fails an adapter with no run method naming EVERY violated clause', async () => {
    const report = await runExecutorContractSuite({} as unknown as ExecutorAdapter)
    expect(report.passed).toBe(false)
    // Every run()-dependent clause fails; request-schema-conformance is independent
    // of the adapter and still passes.
    expect(report.violations.map((violation) => violation.clause)).toEqual([
      'exposes-async-run',
      'envelope-conformance',
      'ok-envelope-completeness',
      'failure-envelope-completeness',
      'cancel-yields-cancelled-envelope',
    ])
    for (const violation of report.violations) {
      expect(violation.detail).toMatch(/no run\(request\) method/)
    }
  })

  it('fails a malformed-status envelope naming exactly the schema clause', async () => {
    const report = await runExecutorContractSuite({
      run: async () => ({ status: 'nope', data: null, summary: '' }) as unknown as ResultEnvelope,
    })
    expect(report.passed).toBe(false)
    expect(report.violations.map((violation) => violation.clause)).toEqual([
      'envelope-conformance',
      'cancel-yields-cancelled-envelope',
    ])
    expect(report.violations[0]?.detail).toContain("'status' must be 'ok', 'failed' or 'cancelled'")
    expect(report.violations[0]?.detail).toContain(PANDA_ERROR_CODES.contractEnvelopeInvalid)
  })

  it('fails a failed-envelope without errors on schema AND failure-completeness clauses', async () => {
    const report = await runExecutorContractSuite({
      run: async () => ({ status: 'failed', data: null, summary: 'boom' }),
    })
    expect(report.passed).toBe(false)
    expect(report.violations.map((violation) => violation.clause)).toEqual([
      'envelope-conformance',
      'failure-envelope-completeness',
      'cancel-yields-cancelled-envelope',
    ])
    const schemaDetail = report.violations.find((violation) => violation.clause === 'envelope-conformance')
    expect(schemaDetail?.detail).toContain("status 'failed' requires a non-empty 'errors' array")
  })

  it('fails a cancelled-envelope without errors on exactly the schema clause', async () => {
    const report = await runExecutorContractSuite(
      stubAdapter({ status: 'cancelled', data: null, summary: 'cancelled without reason' }),
    )
    expect(report.violations.map((violation) => violation.clause)).toEqual(['envelope-conformance'])
    expect(report.violations[0]?.detail).toContain("status 'cancelled' requires a non-empty 'errors' array")
  })

  it('passes a signal-ignoring adapter on every clause EXCEPT cancellation', async () => {
    const report = await runExecutorContractSuite({
      run: async () => ({ status: 'ok', data: null, summary: 'ignored the abort' }),
    })
    expect(report.passed).toBe(false)
    expect(report.violations.map((violation) => violation.clause)).toEqual([
      'cancel-yields-cancelled-envelope',
    ])
    expect(report.violations[0]?.detail).toContain("resolved status 'ok' after cancellation")
  })

  it('fails an ok-envelope without data naming exactly the conformance + ok-completeness clauses', async () => {
    const report = await runExecutorContractSuite({
      run: async (request) => {
        await Promise.resolve()
        if (request.signal?.aborted) return CANCELLED_ENVELOPE
        return { status: 'ok', summary: 'done' } as unknown as ResultEnvelope
      },
    })
    expect(report.passed).toBe(false)
    expect(report.violations.map((violation) => violation.clause)).toEqual([
      'envelope-conformance',
      'ok-envelope-completeness',
    ])
  })

  it('isolates clause crashes: a rejecting adapter still yields named violations from every clause', async () => {
    const report = await runExecutorContractSuite({
      run: async () => {
        throw new Error('adapter exploded')
      },
    })
    expect(report.passed).toBe(false)
    expect(report.violations.map((violation) => violation.clause)).toEqual([
      'envelope-conformance',
      'ok-envelope-completeness',
      'failure-envelope-completeness',
      'cancel-yields-cancelled-envelope',
    ])
    for (const violation of report.violations) {
      expect(violation.detail).toContain('adapter exploded')
    }
  })

  it('times out hanging clauses into named violations instead of hanging the suite', async () => {
    const report = await runExecutorContractSuite(
      { run: () => new Promise<ResultEnvelope>(() => {}) },
      { timeoutMs: 50 },
    )
    expect(report.passed).toBe(false)
    expect(report.violations.map((violation) => violation.clause)).toEqual([
      'exposes-async-run (timeout)',
      'envelope-conformance (timeout)',
      'ok-envelope-completeness (timeout)',
      'failure-envelope-completeness (timeout)',
      'cancel-yields-cancelled-envelope (timeout)',
    ])
    for (const violation of report.violations) {
      expect(violation.detail).toContain('time budget')
    }
    expect(report.outcomes.filter((outcome) => outcome.passed)).toHaveLength(1)
    expect(report.outcomes.filter((outcome) => outcome.passed)[0]?.clause).toBe(
      'request-schema-conformance',
    )
  })

  it('runs each clause independently by name', async () => {
    const conforming = EXECUTOR_CLAUSES.find((clause) => clause.name === 'envelope-conformance')
    expect(conforming).toBeDefined()

    const goodStub = stubAdapter({ status: 'ok', data: null, summary: 'done' })
    await expect(conforming?.check(goodStub)).resolves.toEqual({ ok: true })

    const badStub = { run: async () => null } as unknown as ExecutorAdapter
    const outcome = await conforming?.check(badStub)
    expect(outcome?.ok).toBe(false)
    expect(outcome?.detail).toContain('result envelope must be an object')
  })
})

describe('programmatic validators raise coded schema violations', () => {
  it('rejects malformed requests with PANDA_CONTRACT_ENVELOPE_INVALID', () => {
    try {
      validateRunRequest({ prompt: '', workspace: { id: '', rootPath: '', capabilities: [] } })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.contractEnvelopeInvalid)
    }
  })

  it('rejects a non-AbortSignal run signal with PANDA_CONTRACT_ENVELOPE_INVALID', () => {
    try {
      validateRunRequest({
        prompt: 'ok',
        workspace: CONTRACT_PROBE_WORKSPACE_HANDLE,
        signal: 'not-a-signal' as unknown as AbortSignal,
      })
      expect.unreachable()
    } catch (error) {
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.contractEnvelopeInvalid)
      expect((error as PandaError).message).toContain("'signal' must be an AbortSignal")
    }
    expect(() =>
      validateRunRequest({
        prompt: 'ok',
        workspace: CONTRACT_PROBE_WORKSPACE_HANDLE,
        signal: new AbortController().signal,
      }),
    ).not.toThrow()
  })

  it('accepts a cancelled envelope carrying a cancellation reason', async () => {
    const result = await RESULT_ENVELOPE_SCHEMA['~standard'].validate(CANCELLED_ENVELOPE)
    expect(result.issues).toBeUndefined()
  })

  it('accepts the probe request', () => {
    expect(() => validateRunRequest(CONTRACT_PROBE_REQUEST)).not.toThrow()
  })
})

describe('shared fixtures are deeply frozen', () => {
  it('mutating the probe handle or request throws instead of corrupting later clauses', () => {
    expect(() => (CONTRACT_PROBE_WORKSPACE_HANDLE.capabilities as WorkspaceCapability[]).push('write')).toThrow(TypeError)
    expect(() => {
      ;(CONTRACT_PROBE_REQUEST as { prompt: string }).prompt = 'mutated'
    }).toThrow(TypeError)
    expect(() => {
      ;(CONTRACT_PROBE_REQUEST.workspace as { id: string }).id = 'mutated'
    }).toThrow(TypeError)
  })
})

describe('a suite diagnosing a broken provider does not kill the process diagnosing it', () => {
  /**
   * The clause that motivated this: `disposed-provider-rejects-operations`, in
   * both the workspace and the memory arrays, probes several operations after
   * dispose and returns on the FIRST violation. Written as an array literal of
   * CALLS, every probe starts before the loop's first `await`, so that early
   * return abandons the ones it never reached — and their rejections have no
   * handler.
   *
   * Nothing in this repository could see it. Panda's own providers PASS the
   * clause, so all the probes get awaited; the leak needs a NON-conformant
   * subject, which is exactly who a published suite is for. It surfaced when the
   * FR-29 proof ran the packed suite against a half-right provider in a bare
   * `node` process, where an unhandled rejection is a non-zero exit instead of a
   * line vitest folds into its own reporting.
   *
   * So the gate is a process-level listener rather than an assertion about the
   * report: the report was already correct when the process died.
   */
  const captureUnhandled = async (run: () => Promise<unknown>): Promise<unknown[]> => {
    const escaped: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      escaped.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await run()
      // Rejections surface a turn later than the promise that carried them, so a
      // listener read on the same tick reads zero for a leak that is about to
      // happen. Two macrotask hops, which is what made this reproducible.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    return escaped
  }

  it('CONTROL: the listener sees a rejection that really is abandoned', async () => {
    const escaped = await captureUnhandled(async () => {
      void Promise.reject(new Error('abandoned on purpose'))
    })
    expect(escaped).toHaveLength(1)
  })

  it('the workspace suite reports a half-right provider without leaking one', async () => {
    // Half-right ON PURPOSE, and the halves matter: `dispose` is a no-op, so
    // `create()` after dispose SUCCEEDS and the clause returns on its first
    // probe — leaving the `acquire` and `release` probes started and unread.
    const provider = {
      // A TEMP root, not `process.cwd()`. The `state-persists-across-sessions`
      // clause writes a durable marker INTO the handle's root, so a subject that
      // points at the repository leaves `.panda-contract-state` in the working
      // tree — caught by `git status`, not by this suite.
      create: () =>
        Promise.resolve(
          validateWorkspaceHandle({
            id: 'w1',
            rootPath: mkdtempSync(join(tmpdir(), 'panda-clause-subject-')),
            capabilities: ['read'],
          }),
        ),
      acquire: (id: string) =>
        Promise.reject(
          new PandaError(PANDA_ERROR_CODES.contractWorkspaceUnknownId, `unknown ${id}`),
        ),
      release: () => Promise.reject(new PandaError(PANDA_ERROR_CODES.contractWorkspaceInvalidHandle, 'forged')),
      dispose: () => Promise.resolve(),
    }
    let report: SuiteReport | undefined
    const escaped = await captureUnhandled(async () => {
      report = await runWorkspaceContractSuite(provider as unknown as WorkspaceProvider)
    })
    // The report is the control: a run that measured nothing leaks nothing
    // either, so "no escapes" only means something once the suite has spoken.
    expect(report?.violations.map((violation) => violation.clause)).toContain(
      'disposed-provider-rejects-operations',
    )
    expect(escaped).toEqual([])
  })

  it('the memory suite reports a half-right provider without leaking one', async () => {
    // The sibling site, and the worse one: FIVE probes rather than three, so an
    // early return abandoned four.
    //
    // The subject took three attempts to get right, and the reason is worth the
    // lines. A stub broken EVERYWHERE never reaches the loop — the clause opens
    // with `entryCount(provider)`, which calls `describe()`, so a stub that
    // rejects there fails the clause before a single probe is created and the
    // gate passes while pinning nothing. The subject has to be healthy enough to
    // ARRIVE and wrong in exactly one place once it does.
    const disposed = (): PandaError =>
      new PandaError(PANDA_ERROR_CODES.contractProviderDisposed, 'disposed')
    const shared = {
      describe: () => Promise.resolve({ entryCount: 0 }),
      timeline: () => Promise.resolve({ entries: [] }),
      search: () => Promise.resolve({ entries: [] }),
      save: () => Promise.resolve({ id: 'e1' }),
      overwrite: () => Promise.reject(disposed()),
      dispose: () => Promise.resolve(),
    } as unknown as MemoryProvider
    const throwaway = {
      // PLANTED: a disposed store must refuse this, and resolving is what makes
      // the clause return on its FIRST probe, leaving the other four started.
      save: () => Promise.resolve({ id: 'leaked' }),
      describe: () => Promise.reject(disposed()),
      timeline: () => Promise.reject(disposed()),
      search: () => Promise.reject(disposed()),
      overwrite: () => Promise.reject(disposed()),
      dispose: () => Promise.resolve(),
    } as unknown as MemoryProvider
    const harness: MemoryContractHarness = {
      providerName: 'half-right',
      provider: shared,
      reopen: () => Promise.resolve(throwaway),
      openDivergentFormatVersion: () => Promise.resolve(throwaway),
    }
    let report: SuiteReport | undefined
    const escaped = await captureUnhandled(async () => {
      report = await runMemoryContractSuite(harness)
    })
    // The control, and it is specific rather than "something failed": the clause
    // must have REACHED its loop and stopped on the planted probe. Without this
    // the gate passes for a subject that died in the setup.
    expect(
      report?.outcomes.find((outcome) => outcome.clause === 'disposed-provider-rejects-operations')
        ?.detail,
    ).toContain('save() after dispose')
    expect(escaped).toEqual([])
  })
})
