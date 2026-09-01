import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runPanda, USAGE } from '../src/run.ts'
import type { RunCommandOptions } from '../src/run.ts'
import type { ResultEnvelope } from '@panda/contracts'
// From `@panda/session`, not `@panda/adapter-cli`: the CLI does not depend on
// the implementation packages, and the session re-exports the seam's vocabulary
// precisely so a consumer that installed only it can name these.
import type { ChildProcessSpawner, SpawnedChild, SpawnOutcome } from '@panda/session'

// `panda run --executor <id>` (Story 2.7c). The CLI's whole job here is argv,
// the selection line and exit codes — WHICH executor is selected and whether a
// configuration is usable belongs to `@panda/session` and is proven in
// `packages/session/test/executors.test.ts`, including the three-vendor argv
// proof and the no-silent-fallback matrix.

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: (line) => out.push(line), stderr: (line) => err.push(line), out, err }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'panda-cli-exec-'))
}

async function writeConfig(root: string, contents: string): Promise<void> {
  await mkdir(join(root, '.panda'), { recursive: true })
  await writeFile(join(root, '.panda', 'config.json'), contents)
}

function okAdapter(): ResultEnvelope {
  return { status: 'ok', data: { result: 'a.txt' }, summary: 'listed files', errors: [] }
}

interface SpawnCall {
  command: string
  args: string[]
}

/**
 * A child-process spawner that records what reached the OS and answers with one
 * JSON line every vendor's trait record can parse as a result.
 */
function recordingSpawner(): { spawner: ChildProcessSpawner; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const stdout = `${JSON.stringify({
    result: 'done',
    type: 'text',
    part: { type: 'text', text: 'done' },
    item: { type: 'agent_message', text: 'done' },
  })}\n`
  const spawner: ChildProcessSpawner = {
    spawn(command: string, args: readonly string[]): SpawnedChild {
      calls.push({ command, args: [...args] })
      let settle: (outcome: SpawnOutcome) => void = () => {}
      const done = new Promise<SpawnOutcome>((resolve) => {
        settle = resolve
      })
      const state = { settled: false }
      return {
        pid: 1,
        get settled() {
          return state.settled
        },
        writeStdin() {},
        endStdin() {
          state.settled = true
          settle({ exitCode: 0, stdout, stderr: '' })
        },
        killTree() {},
        done,
      }
    },
  }
  return { spawner, calls }
}

/**
 * A run that reaches the selection and then stops before any executor is
 * spawned. It deliberately supplies NO `createAdapter`, because that seam is
 * what suppresses the selection line — a test that injected an adapter would be
 * asserting on the path where panda did not select anything.
 */
function haltingRun(argv: readonly string[], options: RunCommandOptions & { out: string[]; err: string[] }) {
  return runPanda(argv, {
    ...options,
    createProvider: () => {
      throw new Error('halted before any executor could run')
    },
  })
}

describe('panda run --executor puts that vendor on the command line', () => {
  /**
   * The mutation that survived the first round: deleting `executorId:` from the
   * CLI's `runSession({...})` call left CLI 45/45, session 48/48, tsc 0 and
   * eslint 0 green, while the real binary printed "executor: codex" and ran
   * claude-code. Nothing failed because every CLI test that reached an executor
   * injected `createAdapter` — which bypasses `executorId` by design — and every
   * test that asserted the selection line stopped before an adapter existed.
   *
   * So this one injects NO adapter. The spawner arrives through
   * `adapterOptions`, the same production seam an embedding host would use, and
   * what is asserted is the command the OS was handed.
   */
  const vendors: [string, string, string[]][] = [
    ['claude-code', 'claude', ['--print', '--output-format', 'json', '--no-session-persistence', '--dangerously-skip-permissions']],
    ['codex', 'codex', ['exec', '--json', '--skip-git-repo-check']],
    ['opencode', 'opencode', ['run', '--format', 'json', '--', 'list files']],
  ]

  for (const [id, command, args] of vendors) {
    it(`runs ${command} for --executor ${id}, and says so`, async () => {
      const { spawner, calls } = recordingSpawner()
      const io = capture()
      const code = await runPanda(['run', '--executor', id, 'list files'], {
        ...io,
        cwd: await tempDir(),
        homeDir: await tempDir(),
        adapterOptions: { spawner },
      })
      expect(code).toBe(0)
      expect(calls.map((call) => call.command)).toEqual([command])
      expect(calls[0]?.args).toEqual(args)
      expect(io.err.join('\n')).toContain(`executor: ${id} (selected by the 'invocation' layer)`)
      expect(JSON.parse(io.out.join('\n'))).toMatchObject({ status: 'ok' })
    })
  }

  it('runs the executor a CONFIGURED document names, not the default', async () => {
    const cwd = await tempDir()
    await writeConfig(cwd, JSON.stringify({ executor: 'opencode' }))
    const { spawner, calls } = recordingSpawner()
    const io = capture()
    expect(
      await runPanda(['run', 'list files'], { ...io, cwd, homeDir: await tempDir(), adapterOptions: { spawner } }),
    ).toBe(0)
    expect(calls.map((call) => call.command)).toEqual(['opencode'])
    expect(io.err.join('\n')).toContain("executor: opencode (selected by the 'project' layer)")
  })

  it('runs claude-code when nothing selects otherwise', async () => {
    const { spawner, calls } = recordingSpawner()
    const io = capture()
    expect(
      await runPanda(['run', 'list files'], {
        ...io,
        cwd: await tempDir(),
        homeDir: await tempDir(),
        adapterOptions: { spawner },
      }),
    ).toBe(0)
    expect(calls.map((call) => call.command)).toEqual(['claude'])
    expect(io.err.join('\n')).toContain("executor: claude-code (selected by the 'defaults' layer)")
  })
})

describe('panda run --executor', () => {
  it('documents the flag in the usage block', () => {
    expect(USAGE).toContain('--executor <id>')
    expect(USAGE).toContain('usage: panda run [--executor <id>] [--trace] "<prompt>"')
    // The three exit codes it shares with every other run stay stated.
    expect(USAGE).toContain('2 usage/environment error')
  })

  it('reports the selection and its deciding layer on stderr, never on stdout', async () => {
    const io = capture()
    const cwd = await tempDir()
    const code = await haltingRun(['run', '--executor', 'codex', 'list', 'files'], { ...io, cwd, homeDir: await tempDir() })
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain("executor: codex (selected by the 'invocation' layer)")
    // stdout stays exactly the envelope JSON a caller pipes into a parser.
    expect(io.out).toHaveLength(0)
  })

  it('accepts --executor=<id> as well', async () => {
    const io = capture()
    const code = await haltingRun(['run', '--executor=opencode', 'list files'], {
      ...io,
      cwd: await tempDir(),
      homeDir: await tempDir(),
    })
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain("executor: opencode (selected by the 'invocation' layer)")
  })

  it('names the layer that decided it for each of the four layers', async () => {
    const homeDir = await tempDir()
    const cwd = await tempDir()

    const defaults = capture()
    await haltingRun(['run', 'p'], { ...defaults, cwd, homeDir })
    expect(defaults.err.join('\n')).toContain("executor: claude-code (selected by the 'defaults' layer)")

    await writeConfig(homeDir, JSON.stringify({ executor: 'codex' }))
    const global = capture()
    await haltingRun(['run', 'p'], { ...global, cwd, homeDir })
    expect(global.err.join('\n')).toContain("executor: codex (selected by the 'global' layer)")

    await writeConfig(cwd, JSON.stringify({ executor: 'opencode' }))
    const project = capture()
    await haltingRun(['run', 'p'], { ...project, cwd, homeDir })
    expect(project.err.join('\n')).toContain("executor: opencode (selected by the 'project' layer)")

    const invocation = capture()
    await haltingRun(['run', '--executor', 'claude-code', 'p'], { ...invocation, cwd, homeDir })
    expect(invocation.err.join('\n')).toContain("executor: claude-code (selected by the 'invocation' layer)")
  })

  it('exits 2 and lists every available id on an executor panda does not have', async () => {
    const io = capture()
    const code = await runPanda(['run', '--executor', 'aider', 'list files'], {
      ...io,
      cwd: await tempDir(),
      homeDir: await tempDir(),
      createAdapter: () => ({ run: () => Promise.resolve(okAdapter()) }),
    })
    expect(code).toBe(2)
    const stderr = io.err.join('\n')
    expect(stderr).toContain('PANDA_EXECUTOR_NOT_FOUND')
    // Exactly, not by substring: `toContain('codex')` also passes for `codex-2`.
    expect(stderr).toContain('available executors: claude-code, codex, opencode')
    // Refused BEFORE anything ran: nothing was printed to stdout, and the
    // injected adapter — which would have produced an envelope — never ran.
    expect(io.out).toHaveLength(0)
  })

  it('exits 2 with a code on a configuration it cannot use, and prints no envelope', async () => {
    const cwd = await tempDir()
    await writeConfig(cwd, '{ not json')
    const io = capture()
    const code = await runPanda(['run', 'list files'], {
      ...io,
      cwd,
      homeDir: await tempDir(),
      createAdapter: () => ({ run: () => Promise.resolve(okAdapter()) }),
    })
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('PANDA_CONFIGURATION_UNUSABLE')
    expect(io.out).toHaveLength(0)
  })

  it('exits 2 when --executor is given no value', async () => {
    for (const argv of [
      ['run', '--executor'],
      ['run', '--executor='],
      ['run', '--executor', '-x'],
      ['run', '--executor=-x'],
      ['run', 'a prompt', '--executor'],
    ]) {
      const io = capture()
      const code = await runPanda(argv, { ...io, cwd: await tempDir(), homeDir: await tempDir() })
      expect(code, argv.join(' ')).toBe(2)
      expect(io.err.join('\n')).toContain("option '--executor' requires an executor id")
      expect(io.err.join('\n')).toContain('usage: panda run')
      expect(io.out).toHaveLength(0)
    }
  })

  it('still rejects every other -- flag, and still takes a single dash as prompt text', async () => {
    const io = capture()
    expect(await runPanda(['run', '--executor', 'codex', '--model', 'sonnet'], { ...io, cwd: await tempDir() })).toBe(2)
    expect(io.err.join('\n')).toContain("unrecognized option '--model'")

    // A prompt is free text, and `-x` is a legitimate part of one. Unchanged.
    const dashed = capture()
    const code = await runPanda(['run', '-x', 'files'], {
      ...dashed,
      cwd: await tempDir(),
      homeDir: await tempDir(),
      createAdapter: () => ({ run: () => Promise.resolve(okAdapter()) }),
    })
    expect(code).toBe(0)
    expect(JSON.parse(dashed.out.join('\n'))).toMatchObject({ status: 'ok' })
  })

  it('keeps the prompt intact around the flag, wherever the flag sits', async () => {
    let seenPrompt: string | undefined
    const io = capture()
    const code = await runPanda(['run', 'list', '--executor', 'codex', 'files'], {
      ...io,
      cwd: await tempDir(),
      homeDir: await tempDir(),
      createAdapter: () => ({
        run: (request) => {
          seenPrompt = request.prompt
          return Promise.resolve(okAdapter())
        },
      }),
    })
    expect(code).toBe(0)
    expect(seenPrompt).toBe('list files')
  })

  it('says nothing about an IMPLICIT selection when the caller supplied its own adapter', async () => {
    // Panda selected nothing here, so a selection line would be a false claim —
    // and this is the seam every existing `panda run` assertion uses.
    const io = capture()
    const code = await runPanda(['run', 'list files'], {
      ...io,
      cwd: await tempDir(),
      homeDir: await tempDir(),
      createAdapter: () => ({ run: () => Promise.resolve(okAdapter()) }),
    })
    expect(code).toBe(0)
    expect(io.err).toHaveLength(0)
  })

  it('says out loud when an EXPLICIT --executor was overridden by the host adapter', async () => {
    // The mirror image, and the one that was wrong: the user typed
    // `--executor codex`, panda resolved it, something else ran, and stderr was
    // completely empty. Silence is honest about a selection panda did not make;
    // it is a false claim about one the user asked for by name.
    const io = capture()
    const code = await runPanda(['run', '--executor', 'codex', 'list files'], {
      ...io,
      cwd: await tempDir(),
      homeDir: await tempDir(),
      createAdapter: () => ({ run: () => Promise.resolve(okAdapter()) }),
    })
    expect(code).toBe(0)
    expect(io.err.join('\n')).toContain(
      "executor: codex (selected by the 'invocation' layer) — overridden by the host-supplied adapter",
    )
  })

  it('answers --help and -h instead of refusing them or running them as a prompt', async () => {
    // `panda run --help` was the only help in the binary that REFUSED (exit 2,
    // "unrecognized option"), and `panda run -h` spawned a real, billed agent
    // with the prompt `-h`. Both now print the usage block that documents the
    // flag this story added.
    for (const argv of [['run', '--help'], ['run', '-h']]) {
      const io = capture()
      // No adapter and no spawner: if this ever reaches an executor again it
      // fails here rather than by spawning something.
      expect(await runPanda(argv, { ...io, cwd: await tempDir(), homeDir: await tempDir() }), argv.join(' ')).toBe(0)
      expect(io.out.join('\n')).toContain('--executor <id>')
      expect(io.err).toHaveLength(0)
    }
  })

  it('keeps a single dash inside a longer prompt as prompt text', async () => {
    // The counterpart to the clause above: `-h` is help only when it is the
    // WHOLE argument list, because a prompt is free text.
    let seenPrompt: string | undefined
    const io = capture()
    await runPanda(['run', 'explain', '-h', 'please'], {
      ...io,
      cwd: await tempDir(),
      homeDir: await tempDir(),
      createAdapter: () => ({
        run: (request) => {
          seenPrompt = request.prompt
          return Promise.resolve(okAdapter())
        },
      }),
    })
    expect(seenPrompt).toBe('explain -h please')
  })
})

describe('panda run is machine independent', () => {
  it('resolves against the home directory it was given, not the real one', async () => {
    const homeDir = await tempDir()
    await writeConfig(homeDir, JSON.stringify({ executor: 'opencode' }))
    const io = capture()
    await haltingRun(['run', 'p'], { ...io, cwd: await tempDir(), homeDir })
    expect(io.err.join('\n')).toContain("executor: opencode (selected by the 'global' layer)")
    expect(homeDir).not.toBe(homedir())
  })

  it('resolves the machine layer from the ISOLATED home this suite installed', async () => {
    // The previous version of this clause asserted that nothing was configured,
    // which stayed green with `vitest.config.ts` DELETED on any machine without
    // a `~/.panda/config.json` — a machine-dependent pin against machine
    // dependence, unable to fire on CI. This asserts the mechanism instead: the
    // resolved home is under the temp directory, and a document written THERE is
    // what a run with no `homeDir` picks up.
    //
    // The prefix check runs FIRST and deliberately: without the setup file, the
    // write below would land in the real `~/.panda/config.json`.
    const isolated = homedir()
    expect(isolated.startsWith(tmpdir())).toBe(true)
    expect(isolated).not.toBe(tmpdir())

    await writeConfig(isolated, JSON.stringify({ executor: 'codex' }))
    try {
      const io = capture()
      await haltingRun(['run', 'p'], { ...io, cwd: await tempDir() })
      expect(io.err.join('\n')).toContain("executor: codex (selected by the 'global' layer)")
    } finally {
      await rm(join(isolated, '.panda', 'config.json'), { force: true })
    }
  })
})
