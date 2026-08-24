import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, runExecutorContractSuite } from '@panda/contracts'
import type { RunRequest, WorkspaceHandle } from '@panda/contracts'
import { ClaudeCodeAdapter } from '../src'
import type { ChildProcessSpawner, SpawnOutcome } from '../src'
import { FakeSpawner, SUCCESS_STDOUT } from './fake-spawner'

function probeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  const handle: WorkspaceHandle = { id: 'probe', rootPath: join(tmpdir(), 'panda-probe'), capabilities: ['read', 'write'] }
  return { prompt: 'do a thing', workspace: handle, ...overrides }
}

const OK_OUTCOME = { exitCode: 0, stdout: SUCCESS_STDOUT, stderr: '' }

describe('ClaudeCodeAdapter envelope mapping', () => {
  it('delivers the prompt via stdin and maps success JSON to an ok envelope', async () => {
    const spawner = new FakeSpawner(OK_OUTCOME)
    const adapter = new ClaudeCodeAdapter({ spawner })
    const envelope = await adapter.run(probeRequest())

    const child = spawner.children[0]
    expect(child).toBeDefined()
    expect(child?.command).toBe('claude')
    expect(child?.options.cwd).toBe(probeRequest().workspace.rootPath)
    expect(child?.args).toContain('--print')
    expect(child?.stdinChunks.join('')).toBe('do a thing')
    expect(child?.stdinEnded).toBe(true)

    expect(envelope.status).toBe('ok')
    expect(envelope.data).toMatchObject({ result: 'Wrote panda-ok.txt\nAll done.', subtype: 'success' })
    expect(envelope.summary).toBe('Wrote panda-ok.txt')
    expect(envelope.errors).toEqual([])
  })

  it('maps a non-zero exit with stderr to a coded failed envelope', async () => {
    const spawner = new FakeSpawner({ exitCode: 1, stdout: '', stderr: 'Invalid API key' })
    const adapter = new ClaudeCodeAdapter({ spawner })
    const envelope = await adapter.run(probeRequest())

    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
    expect(envelope.errors?.[0]?.message).toContain('Invalid API key')
    expect(envelope.summary.length).toBeGreaterThan(0)
  })

  it('names the missing executor in an unavailable failed envelope on spawn error', async () => {
    const spawner = new FakeSpawner({ exitCode: null, stdout: '', stderr: '', spawnErrorMessage: 'spawn claude ENOENT' })
    const adapter = new ClaudeCodeAdapter({ spawner })
    const envelope = await adapter.run(probeRequest())

    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorUnavailable)
    expect(envelope.errors?.[0]?.message).toContain("'claude'")
    expect(envelope.errors?.[0]?.message).toContain('ENOENT')
  })

  it('fails when exit-0 output is not JSON or lacks a string result field', async () => {
    for (const stdout of ['not json at all', JSON.stringify({ nope: true })]) {
      const spawner = new FakeSpawner({ exitCode: 0, stdout, stderr: '' })
      const adapter = new ClaudeCodeAdapter({ spawner })
      const envelope = await adapter.run(probeRequest())
      expect(envelope.status).toBe('failed')
      expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
    }
  })

  it('maps is_error / error-subtype payloads to FAILED envelopes even on exit 0', async () => {
    for (const payload of [
      { type: 'result', subtype: 'success', is_error: true, result: 'tool use refused' },
      { type: 'result', subtype: 'error_max_turns', is_error: false, result: 'stopped' },
    ]) {
      const spawner = new FakeSpawner({ exitCode: 0, stdout: JSON.stringify(payload), stderr: '' })
      const adapter = new ClaudeCodeAdapter({ spawner })
      const envelope = await adapter.run(probeRequest())
      expect(envelope.status).toBe('failed')
      expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
      expect(envelope.summary.length).toBeGreaterThan(0)
    }

    const spawner = new FakeSpawner({
      exitCode: 0,
      stdout: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, result: 'stopped', session_id: 's-1' }),
      stderr: '',
    })
    const envelope = await new ClaudeCodeAdapter({ spawner }).run(probeRequest())
    expect(envelope.data).toMatchObject({ subtype: 'error_max_turns', session_id: 's-1' })
  })

  it('carries success metadata (subtype, session id, truncation flags) in ok data', async () => {
    const spawner = new FakeSpawner({
      exitCode: 0,
      stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's-2' }),
      stderr: '',
      stdoutTruncated: true,
    })
    const envelope = await new ClaudeCodeAdapter({ spawner }).run(probeRequest())
    expect(envelope.status).toBe('ok')
    expect(envelope.data).toMatchObject({ subtype: 'success', session_id: 's-2', stdoutTruncated: true })
  })

  it('reports external-signal termination explicitly instead of an unknown-code message', async () => {
    const spawner = new FakeSpawner({ exitCode: null, stdout: '', stderr: '' })
    const envelope = await new ClaudeCodeAdapter({ spawner }).run(probeRequest())
    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
    expect(envelope.errors?.[0]?.message).toContain('terminated by an external signal')
  })

  it('maps mid-run stream failures to a typed failed envelope instead of raw errors', async () => {
    const spawner = new FakeSpawner({ exitCode: 1, stdout: '', stderr: '', streamErrorMessage: 'write EPIPE' })
    const envelope = await new ClaudeCodeAdapter({ spawner }).run(probeRequest())
    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.message).toContain('EPIPE')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
  })

  it('returns the real ok envelope when abort lands after successful completion', async () => {
    let finishChild: ((outcome: SpawnOutcome) => void) | undefined
    const spawner: ChildProcessSpawner = {
      spawn() {
        const done = new Promise<SpawnOutcome>((resolve) => {
          finishChild = resolve
        })
        return {
          pid: 7,
          writeStdin() {},
          endStdin() {},
          killTree() {},
          done,
        }
      },
    }
    const controller = new AbortController()
    const pending = new ClaudeCodeAdapter({ spawner }).run(probeRequest({ signal: controller.signal }))
    // Complete successfully BEFORE the caller aborts.
    queueMicrotask(() =>
      finishChild?.({ exitCode: 0, stdout: SUCCESS_STDOUT, stderr: '' }),
    )
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()

    const envelope = await pending
    expect(envelope.status).toBe('ok')
    expect(envelope.data).toMatchObject({ result: 'Wrote panda-ok.txt\nAll done.', subtype: 'success' })
  })

  it('maps a throwing spawn seam to a typed unavailable envelope instead of rejecting', async () => {
    const throwing: ChildProcessSpawner = {
      spawn() {
        throw Object.assign(new Error('spawn claude EINVAL'), { code: 'EINVAL' })
      },
    }
    const envelope = await new ClaudeCodeAdapter({ spawner: throwing }).run(probeRequest())
    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorUnavailable)
    expect(envelope.errors?.[0]?.message).toContain('EINVAL')
  })

  it('rejects malformed requests with the canonical code before spawning anything', async () => {
    const spawner = new FakeSpawner()
    const adapter = new ClaudeCodeAdapter({ spawner })
    await expect(adapter.run({ prompt: '', workspace: { id: '', rootPath: '', capabilities: [] } as unknown as WorkspaceHandle })).rejects.toMatchObject({
      code: PANDA_ERROR_CODES.contractEnvelopeInvalid,
    })
    expect(spawner.children).toHaveLength(0)
  })
})

describe('ClaudeCodeAdapter cancellation', () => {
  it('kills the child process tree and resolves a typed cancelled envelope', async () => {
    const spawner = new FakeSpawner()
    const adapter = new ClaudeCodeAdapter({ spawner })
    const controller = new AbortController()

    const pending = adapter.run(probeRequest({ signal: controller.signal }))
    controller.abort()

    const envelope = await pending
    expect(spawner.children).toHaveLength(1)
    expect(spawner.children[0]?.killed).toBe(true)
    expect(spawner.orphans).toHaveLength(0)
    expect(envelope.status).toBe('cancelled')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorCancelled)
  })

  it('returns cancelled without spawning when the signal is already aborted', async () => {
    const spawner = new FakeSpawner()
    const adapter = new ClaudeCodeAdapter({ spawner })
    const controller = new AbortController()
    controller.abort()

    const envelope = await adapter.run(probeRequest({ signal: controller.signal }))
    expect(spawner.children).toHaveLength(0)
    expect(envelope.status).toBe('cancelled')
    expect(envelope.errors?.length).toBeGreaterThan(0)
  })
})

describe('ClaudeCodeAdapter overhead instrumentation', () => {
  it('reports spawn setup and total run time through onTiming', async () => {
    const timings: unknown[] = []
    const spawner = new FakeSpawner(OK_OUTCOME)
    const adapter = new ClaudeCodeAdapter({ spawner, onTiming: (t) => timings.push(t) })
    await adapter.run(probeRequest())
    expect(timings).toHaveLength(1)
    const timing = timings[0] as { spawnSetupMs: number; runMs: number }
    expect(timing.spawnSetupMs).toBeGreaterThanOrEqual(0)
    expect(timing.runMs).toBeGreaterThanOrEqual(timing.spawnSetupMs)
  })
})

describe('ClaudeCodeAdapter against the executor contract suite', () => {
  it('passes every clause with zero violations', async () => {
    const spawner = new FakeSpawner(OK_OUTCOME)
    const adapter = new ClaudeCodeAdapter({ spawner })
    const report = await runExecutorContractSuite(adapter)

    if (!report.passed) {
      const detail = report.violations.map((violation) => `${violation.clause}: ${violation.detail}`).join('\n')
      throw new Error(`contract suite violations:\n${detail}`)
    }
    expect(report.passed).toBe(true)
    // The cancellation clause must have actually exercised tree termination.
    const cancelChild = spawner.children.at(-1)
    expect(cancelChild?.killed).toBe(true)
    expect(spawner.orphans).toHaveLength(0)
  })
})
