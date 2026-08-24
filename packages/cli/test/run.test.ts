import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runPanda } from '../src'
import type { RunCommandOptions } from '../src'
import type { ExecutorAdapter, ResultEnvelope, WorkspaceProvider } from '@panda/contracts'

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    out,
    err,
  }
}

function fakeAdapter(envelope: ResultEnvelope): ExecutorAdapter {
  return {
    async run(request) {
      if (request.signal?.aborted) {
        return { status: 'cancelled', data: null, summary: 'cancel', errors: [{ message: 'cancelled' }] }
      }
      return envelope
    },
  }
}

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'panda-cli-'))
}

describe('panda run', () => {
  it('prints the envelope as structured JSON and exits 0 on ok', async () => {
    const cwd = await tempCwd()
    const io = capture()
    const code = await runPanda(['run', 'list files'], {
      ...io,
      cwd,
      createAdapter: () =>
        fakeAdapter({ status: 'ok', data: { result: 'a.txt' }, summary: 'listed files', errors: [] }),
    })
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ status: 'ok', summary: 'listed files' })
    expect(io.err).toHaveLength(0)
  })

  it('exits 1 and still prints the envelope on failed', async () => {
    const cwd = await tempCwd()
    const io = capture()
    const code = await runPanda(['run', 'break things'], {
      ...io,
      cwd,
      createAdapter: () =>
        fakeAdapter({
          status: 'failed',
          data: null,
          summary: 'task failed',
          errors: [{ message: 'boom', code: 'PANDA_EXECUTOR_RUN_FAILED' }],
        }),
    })
    expect(code).toBe(1)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ status: 'failed' })
  })

  it('exits 1 on cancelled', async () => {
    const cwd = await tempCwd()
    const io = capture()
    const code = await runPanda(['run', 'stop me'], {
      ...io,
      cwd,
      createAdapter: () => ({
        run: () =>
          Promise.resolve({
            status: 'cancelled',
            data: null,
            summary: 'execution cancelled before completion',
            errors: [{ message: 'the run was cancelled and its process tree terminated' }],
          }),
      }),
    })
    expect(code).toBe(1)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ status: 'cancelled' })
  })

  it('exits 2 on unknown command or empty prompt with usage on stderr', async () => {
    for (const argv of [['deploy'], ['run'], []]) {
      const io = capture()
      const code = await runPanda(argv, { ...io, cwd: await tempCwd() })
      expect(code).toBe(2)
      expect(io.err.join('\n')).toContain('usage: panda run')
      expect(io.out).toHaveLength(0)
    }
  })

  it('prints usage and exits 0 on --help, listing the exit codes', async () => {
    const io = capture()
    const code = await runPanda(['--help'], { ...io, cwd: await tempCwd() })
    expect(code).toBe(0)
    const printed = io.out.join('\n')
    expect(printed).toContain('usage: panda run')
    expect(printed).toContain('0 ok')
    expect(printed).toContain('1 failed/cancelled')
    expect(printed).toContain('2 usage/environment error')
    // --help must not spawn anything.
  })

  it('rejects unrecognized -- flags as usage errors instead of prompt text', async () => {
    const io = capture()
    const code = await runPanda(['run', '--model', 'sonnet'], { ...io, cwd: await tempCwd() })
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain("unrecognized option '--model'")
    expect(io.out).toHaveLength(0)
  })

  it('aborts via the interrupt seam: prints a cancelled envelope and exits 1', async () => {
    const cwd = await tempCwd()
    const io = capture()
    let triggerInterrupt: (() => void) | undefined
    const runPromise = runPanda(['run', 'long task'], {
      ...io,
      cwd,
      createAdapter: () => ({
        async run(request) {
          if (request.signal === undefined) throw new Error('expected a cancellation signal')
          return await request.signal.aborted
            ? cancelledEnvelope()
            : new Promise<ResultEnvelope>((resolve) => {
                request.signal?.addEventListener('abort', () => resolve(cancelledEnvelope()), { once: true })
              })
        },
      }),
      onInterrupt: (handler) => {
        triggerInterrupt = handler
        return () => {}
      },
    })

    // Wait until runPanda registered the handler, then fire Ctrl+C's equivalent.
    const deadline = Date.now() + 5_000
    while (triggerInterrupt === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(triggerInterrupt).toBeDefined()
    triggerInterrupt?.()

    const code = await runPromise
    expect(code).toBe(1)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ status: 'cancelled' })
  })

  it('contains release/dispose failures without masking the envelope', async () => {
    const cwd = await tempCwd()
    const io = capture()
    const code = await runPanda(['run', 'list files'], {
      ...io,
      cwd,
      createProvider: () => brokenProvider,
      createAdapter: () =>
        fakeAdapter({ status: 'ok', data: { result: 'a.txt' }, summary: 'listed files', errors: [] }),
    })
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ status: 'ok' })
    expect(io.err).toHaveLength(0)
  })

  it('exits 2 when the workspace cannot be created', async () => {
    const notADir = join(await tempCwd(), 'file.txt')
    await writeFile(notADir, 'x')
    const io = capture()
    const code = await runPanda(['run', 'anything'], { ...io, cwd: notADir })
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('PANDA_CONTRACT_WORKSPACE_UNAVAILABLE')
  })
})

const brokenProvider: WorkspaceProvider = {
  create: async () => ({
    id: 'w',
    rootPath: join(tmpdir(), 'panda-cli-broken'),
    capabilities: ['read', 'write'],
  }),
  acquire: async () => {
    throw new Error('unused in this test')
  },
  release: async () => {
    throw new Error('release exploded')
  },
  dispose: async () => {
    throw new Error('dispose exploded')
  },
}

function cancelledEnvelope(): ResultEnvelope {
  return {
    status: 'cancelled',
    data: null,
    summary: 'execution cancelled before completion',
    errors: [{ message: 'the run was cancelled and its process tree terminated' }],
  }
}
