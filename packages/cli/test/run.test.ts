import { readdirSync, readFileSync } from 'node:fs'
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

// --- Exit-code mapping the neutrality claim rests on ----------------------
//
// Three paths that reach `describe()` and were never pinned. Two of them are
// where Story 2.0 measurably CHANGED behaviour (for the better) rather than
// preserving it, and an unpinned improvement is indistinguishable from an
// accident the next person is free to undo.

describe('panda run exit-code mapping', () => {
  it('exits 2 when the envelope cannot be serialised, instead of throwing out of the binary', async () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const io = capture()
    const code = await runPanda(['run', 'produce a cycle'], {
      ...io,
      cwd: await tempCwd(),
      createAdapter: () => ({
        run: async () => ({ status: 'ok', data: circular, summary: 'cyclic payload', errors: [] }),
      }),
    })
    expect(code).toBe(2)
    expect(io.out).toHaveLength(0)
    expect(io.err.join('\n')).toContain('circular')
  })

  it('exits 2 when the adapter throws, printing the code of EITHER error hierarchy', async () => {
    // Deliberately not a `PandaError`: AD-1 keeps `PandaKernelError` in a disjoint
    // hierarchy, so a budget refusal carries a code that no `instanceof PandaError`
    // check can see. `describe()` duck-types on `code`, and this is what pins it.
    const io = capture()
    const code = await runPanda(['run', 'refuse me'], {
      ...io,
      cwd: await tempCwd(),
      createAdapter: () => ({
        run: () => {
          throw Object.assign(new Error('the invocations cap of 0 would be exceeded'), {
            code: 'PANDA_KERNEL_INVOCATION_CAP_EXCEEDED',
          })
        },
      }),
    })
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('PANDA_KERNEL_INVOCATION_CAP_EXCEEDED: the invocations cap of 0 would be exceeded')
  })

  it('exits 2 when the provider factory itself throws', async () => {
    // Previously an unhandled rejection with no mapped exit code, and reachable in
    // production through a deleted cwd.
    const io = capture()
    const code = await runPanda(['run', 'anything'], {
      ...io,
      cwd: await tempCwd(),
      createProvider: () => {
        throw new Error('provider construction failed')
      },
    })
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('provider construction failed')
  })
})

// --- The thin-binding pin (Story 2.0) -------------------------------------
//
// Everything above pins BEHAVIOUR. This block pins the SHAPE that behaviour is
// allowed to live in: the composition — create a workspace, obtain an adapter,
// run under a signal, release, dispose — belongs to `@panda/session`, and
// `@panda/cli` is argv parsing, output formatting and exit-code mapping.
//
// These two clauses are the cheap, exact half of that rule. They are NOT the
// whole enforcement, and it matters that nobody reads them as such:
//   - the relative-import route (`../../workspace-local/src/index.ts`, which
//     needs no manifest entry at all) is closed by `no-restricted-imports` in
//     eslint.config.js, repo-wide;
//   - the POSITIVE proof — that a consumer really can do this without the CLI —
//     is `packages/session/test/consumer.test.ts`, which the CLI cannot defeat
//     by rewriting itself.
// A text scan for composition vocabulary used to sit here and was deleted on
// review: it flagged a comment that merely named the tokens, and missed a real
// composition written as `provider['release'](h)`. A negative scan over source
// text cannot carry this claim.

const cliPackageDir = join(import.meta.dirname, '..')

function shippedSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    // `__scratch/` is git-ignored test scratch; recursing into a leftover probe
    // turns the gate red for something that is not source.
    if (entry.name === '__scratch' || entry.name === 'node_modules') return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? shippedSourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

function importSpecifiersOf(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined)
}

/** A composition cannot be written without reaching into at least one of these. */
const COMPOSITION_PACKAGES = ['@panda/adapter-cli', '@panda/workspace-local', '@panda/kernel']

describe('@panda/cli stays a thin binding', () => {
  it('shipped sources exist to scan', () => {
    // Guards against the pin passing because a path typo made every scan empty.
    expect(shippedSourceFiles(join(cliPackageDir, 'src')).length).toBeGreaterThan(0)
    expect(shippedSourceFiles(join(cliPackageDir, 'bin')).length).toBeGreaterThan(0)
  })

  it('depends on the session and on nothing else at runtime', () => {
    const pkg = JSON.parse(readFileSync(join(cliPackageDir, 'package.json'), 'utf8')) as Record<string, unknown>
    // `@panda/contracts` moved to devDependencies once `describe()` stopped
    // needing `instanceof PandaError`: the shipped CLI now imports exactly one
    // package, and the tests keep contracts only to type their fakes.
    expect(Object.keys((pkg['dependencies'] ?? {}) as Record<string, unknown>)).toEqual(['@panda/session'])
  })

  it('never imports the implementation packages a session composes', () => {
    for (const file of [
      ...shippedSourceFiles(join(cliPackageDir, 'src')),
      ...shippedSourceFiles(join(cliPackageDir, 'bin')),
    ]) {
      for (const specifier of importSpecifiersOf(readFileSync(file, 'utf8'))) {
        expect(COMPOSITION_PACKAGES.includes(specifier), `${file} imports '${specifier}'`).toBe(false)
      }
    }
  })
})
