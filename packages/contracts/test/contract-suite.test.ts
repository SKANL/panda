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
