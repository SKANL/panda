import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES } from '@skanl/panda-contracts'
import type { RunRequest, WorkspaceHandle } from '@skanl/panda-contracts'
import { createClaudeCodeAdapter } from '../src/index.ts'
import type { ChildProcessSpawner, SpawnOutcome } from '../src/index.ts'
import { FakeSpawner, SUCCESS_STDOUT } from './fake-spawner.ts'

// Engine-level behavior that is identical for every trait record — exit codes,
// stream failures, request validation, timing — is exercised ONCE here through
// the Claude adapter; the trait-axis clauses run against all four adapters in
// executor-suite.ts. Claude's own payload semantics (is_error, error subtypes,
// session metadata) are asserted here because they are what its traits encode.

function probeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  const handle: WorkspaceHandle = { id: 'probe', rootPath: join(tmpdir(), 'panda-probe'), capabilities: ['read', 'write'] }
  return { prompt: 'do a thing', workspace: handle, ...overrides }
}

const OK_OUTCOME = { exitCode: 0, stdout: SUCCESS_STDOUT, stderr: '' }

describe('CLI executor engine — process-level outcomes', () => {
  it('maps a non-zero exit with stderr to a coded failed envelope', async () => {
    const spawner = new FakeSpawner({ exitCode: 1, stdout: '', stderr: 'Invalid API key' })
    const envelope = await createClaudeCodeAdapter({ spawner }).run(probeRequest())

    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
    expect(envelope.errors?.[0]?.message).toContain('Invalid API key')
    expect(envelope.summary.length).toBeGreaterThan(0)
  })

  it('reports external-signal termination explicitly instead of an unknown-code message', async () => {
    const spawner = new FakeSpawner({ exitCode: null, stdout: '', stderr: '' })
    const envelope = await createClaudeCodeAdapter({ spawner }).run(probeRequest())
    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
    expect(envelope.errors?.[0]?.message).toContain('terminated by an external signal')
  })

  it('maps mid-run stream failures to a typed failed envelope instead of raw errors', async () => {
    const spawner = new FakeSpawner({ exitCode: 1, stdout: '', stderr: '', streamErrorMessage: 'write EPIPE' })
    const envelope = await createClaudeCodeAdapter({ spawner }).run(probeRequest())
    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.message).toContain('EPIPE')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
  })

  it('maps a throwing spawn seam to a typed unavailable envelope instead of rejecting', async () => {
    const throwing: ChildProcessSpawner = {
      spawn() {
        throw Object.assign(new Error('spawn claude EINVAL'), { code: 'EINVAL' })
      },
    }
    const envelope = await createClaudeCodeAdapter({ spawner: throwing }).run(probeRequest())
    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorUnavailable)
    expect(envelope.errors?.[0]?.message).toContain('EINVAL')
  })

  it('rejects malformed requests with the canonical code before spawning anything', async () => {
    const spawner = new FakeSpawner()
    const adapter = createClaudeCodeAdapter({ spawner })
    await expect(
      adapter.run({ prompt: '', workspace: { id: '', rootPath: '', capabilities: [] } as unknown as WorkspaceHandle }),
    ).rejects.toMatchObject({ code: PANDA_ERROR_CODES.contractEnvelopeInvalid })
    expect(spawner.children).toHaveLength(0)
  })

  it('returns cancelled without spawning when the signal is already aborted', async () => {
    const spawner = new FakeSpawner()
    const controller = new AbortController()
    controller.abort()

    const envelope = await createClaudeCodeAdapter({ spawner }).run(probeRequest({ signal: controller.signal }))
    expect(spawner.children).toHaveLength(0)
    expect(envelope.status).toBe('cancelled')
    expect(envelope.errors?.length).toBeGreaterThan(0)
  })

  it('does not cancel a run that settled inside the abort dispatch window', async () => {
    // The child finishes SYNCHRONOUSLY during endStdin, so `done` is already
    // resolved while its `.then` callback is still a pending microtask. An
    // abort arriving in that window must read the child's synchronous settled
    // state, not the flag the microtask has yet to set.
    let settled = false
    let resolveDone!: (outcome: SpawnOutcome) => void
    const spawner: ChildProcessSpawner = {
      spawn: () => ({
        pid: 11,
        get settled() {
          return settled
        },
        writeStdin() {},
        endStdin() {
          settled = true
          resolveDone(OK_OUTCOME)
        },
        killTree() {
          throw new Error('a completed run must never be killed')
        },
        done: new Promise<SpawnOutcome>((resolve) => {
          resolveDone = resolve
        }),
      }),
    }
    const controller = new AbortController()
    const pending = createClaudeCodeAdapter({ spawner }).run(probeRequest({ signal: controller.signal }))
    controller.abort()

    expect((await pending).status).toBe('ok')
  })

  it('reports spawn setup and total run time through onTiming', async () => {
    const timings: unknown[] = []
    const spawner = new FakeSpawner(OK_OUTCOME)
    await createClaudeCodeAdapter({ spawner, onTiming: (t) => timings.push(t) }).run(probeRequest())

    expect(timings).toHaveLength(1)
    const timing = timings[0] as { spawnSetupMs: number; runMs: number }
    expect(timing.spawnSetupMs).toBeGreaterThanOrEqual(0)
    expect(timing.runMs).toBeGreaterThanOrEqual(timing.spawnSetupMs)
  })
})

describe('Claude Code payload semantics', () => {
  it('spawns headless print mode and summarizes the first result line', async () => {
    const spawner = new FakeSpawner(OK_OUTCOME)
    const envelope = await createClaudeCodeAdapter({ spawner }).run(probeRequest())

    expect(spawner.children[0]?.args).toContain('--print')
    expect(envelope.status).toBe('ok')
    expect(envelope.data).toMatchObject({ result: 'Wrote panda-ok.txt\nAll done.', subtype: 'success' })
    expect(envelope.summary).toBe('Wrote panda-ok.txt')
  })

  it('maps is_error / error-subtype payloads to FAILED envelopes even on exit 0', async () => {
    for (const payload of [
      { type: 'result', subtype: 'success', is_error: true, result: 'tool use refused' },
      { type: 'result', subtype: 'error_max_turns', is_error: false, result: 'stopped' },
    ]) {
      const spawner = new FakeSpawner({ exitCode: 0, stdout: JSON.stringify(payload), stderr: '' })
      const envelope = await createClaudeCodeAdapter({ spawner }).run(probeRequest())
      expect(envelope.status).toBe('failed')
      expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
      expect(envelope.summary.length).toBeGreaterThan(0)
    }
  })

  it('carries subtype, session id and truncation flags into envelope data', async () => {
    const failing = new FakeSpawner({
      exitCode: 0,
      stdout: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, result: 'stopped', session_id: 's-1' }),
      stderr: '',
    })
    expect((await createClaudeCodeAdapter({ spawner: failing }).run(probeRequest())).data).toMatchObject({
      subtype: 'error_max_turns',
      session_id: 's-1',
    })

    const succeeding = new FakeSpawner({
      exitCode: 0,
      stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's-2' }),
      stderr: '',
      stderrTruncated: true,
    })
    const envelope = await createClaudeCodeAdapter({ spawner: succeeding }).run(probeRequest())
    // stderr truncation does not endanger the RESULT, so the run still succeeds
    // — but the flags travel so a caller can tell the capture was clipped.
    expect(envelope.status).toBe('ok')
    expect(envelope.data).toMatchObject({
      subtype: 'success',
      session_id: 's-2',
      stdoutTruncated: false,
      stderrTruncated: true,
    })
  })
})
