import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runPanda } from '../src'
import type { RunCommandOptions } from '../src'
import type { ExecutorAdapter, ResultEnvelope, WorkspaceProvider } from '@panda/contracts'
import { RegistryStore } from '@panda/environment'

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

/**
 * A composition cannot be written without reaching into at least one of these.
 * `@panda/projection` and `@panda/registry` joined the list with Story 2.7a:
 * `panda init` is exactly the command that would be tempting to write by reading
 * the registry and driving a projection target from here, and the whole point of
 * `@panda/environment` is that a third party gets that without the CLI.
 */
const COMPOSITION_PACKAGES = [
  '@panda/adapter-cli',
  '@panda/workspace-local',
  '@panda/kernel',
  '@panda/projection',
  '@panda/registry',
]

describe('@panda/cli stays a thin binding', () => {
  it('shipped sources exist to scan', () => {
    // Guards against the pin passing because a path typo made every scan empty.
    expect(shippedSourceFiles(join(cliPackageDir, 'src')).length).toBeGreaterThan(0)
    expect(shippedSourceFiles(join(cliPackageDir, 'bin')).length).toBeGreaterThan(0)
  })

  it('depends on the consumer-tier capability packages and on nothing else at runtime', () => {
    const pkg = JSON.parse(readFileSync(join(cliPackageDir, 'package.json'), 'utf8')) as Record<string, unknown>
    // `@panda/contracts` moved to devDependencies once `describe()` stopped
    // needing `instanceof PandaError`: the shipped CLI imports only consumer-tier
    // packages, and the tests keep contracts only to type their fakes.
    //
    // Story 2.7a added `@panda/environment` beside `@panda/session`. This list is
    // a SNAPSHOT of the CONSUMER TIER, not a cap of one: what the pin is for is
    // the clause below it — the CLI may never reach past a capability package
    // into the implementations one composes. A new entry here is only legitimate
    // for another package of the same tier, whose own guard test proves the tier.
    expect(Object.keys((pkg['dependencies'] ?? {}) as Record<string, unknown>)).toEqual([
      '@panda/environment',
      '@panda/session',
    ])
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

// --- panda init / panda project init (Story 2.7a) --------------------------
//
// The CLI's whole job for these two commands is argv, output and exit codes, so
// that is all this block pins. What was detected, what was projected and what
// drifted is the capability's, and is proven in
// `packages/environment/test/` — including the FR-29 consumer test, which
// composes the same capability with no CLI in sight.

describe('panda init', () => {
  it('exits 2 and names every path it looked at when no executor is detected', async () => {
    const homeDir = await tempCwd()
    const io = capture()
    const code = await runPanda(['init'], { ...io, homeDir })
    expect(code).toBe(2)
    const result = JSON.parse(io.out.join('\n')) as {
      scope: string
      detected: { executorId: string; present: boolean; evidence: { path: string }[] }[]
    }
    expect(result.scope).toBe('machine')
    expect(result.detected.map((detection) => detection.executorId)).toEqual(['claude-code', 'codex', 'opencode'])
    expect(result.detected.every((detection) => !detection.present)).toBe(true)
    // Actionable on stderr too: what was looked for, and where.
    const stderr = io.err.join('\n')
    expect(stderr).toContain('no executor configuration was found')
    for (const detection of result.detected) {
      for (const evidence of detection.evidence) expect(stderr).toContain(evidence.path)
    }
  })

  it('exits 0 and prints the per-target result when an executor is detected', async () => {
    const homeDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n')
    const io = capture()
    const code = await runPanda(['init'], { ...io, homeDir })
    expect(code).toBe(0)
    expect(io.err).toHaveLength(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({
      scope: 'machine',
      targets: [{ executorId: 'claude-code', filePath: join(homeDir, '.claude.json'), written: false }],
    })
  })

  it('binds a project into the executor file that project reads', async () => {
    const homeDir = await tempCwd()
    const projectDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n')
    const io = capture()
    const code = await runPanda(['project', 'init', projectDir], { ...io, homeDir })
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({
      scope: 'project',
      pandaDir: join(projectDir, '.panda'),
      targets: [{ executorId: 'claude-code', filePath: join(projectDir, '.mcp.json') }],
    })
  })

  it('exits 2 on a project subcommand it does not have, and on unrecognized flags', async () => {
    for (const argv of [['project'], ['project', 'status']]) {
      const io = capture()
      expect(await runPanda(argv, { ...io, homeDir: await tempCwd() })).toBe(2)
      expect(io.err.join('\n')).toContain('usage: panda run')
      expect(io.out).toHaveLength(0)
    }
    const io = capture()
    expect(await runPanda(['init', '--force'], { ...io, homeDir: await tempCwd() })).toBe(2)
    expect(io.err.join('\n')).toContain("unrecognized option '--force'")
    expect(io.out).toHaveLength(0)
  })

  it('exits 1 when one target fails, after printing the result for the others', async () => {
    const homeDir = await tempCwd()
    // A Claude config Claude itself would refuse to start on; Codex present and fine.
    await writeFile(join(homeDir, '.claude.json'), 'not json')
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    const io = capture()
    const code = await runPanda(['init'], { ...io, homeDir })
    expect(code).toBe(1)
    expect(io.err.join('\n')).toContain('PANDA_PROJECTION_NATIVE_MALFORMED')
    const result = JSON.parse(io.out.join('\n')) as { targets: { executorId: string; error?: unknown }[] }
    expect(result.targets.find((target) => target.executorId === 'codex')?.error).toBeUndefined()
  })
})

describe('panda init argv and diagnostics', () => {
  it('treats a single-dash token as an option, never as a directory', async () => {
    // `panda project init -f` fell through as a POSITIONAL and created a
    // directory literally named `-f`.
    const homeDir = await tempCwd()
    const cwd = await tempCwd()
    const io = capture()
    expect(await runPanda(['project', 'init', '-f'], { ...io, homeDir, cwd })).toBe(2)
    expect(io.err.join('\n')).toContain("unrecognized option '-f'")
    expect(io.out).toHaveLength(0)
    expect(readdirSync(cwd)).toEqual([])
  })

  it('rejects positionals it has no use for', async () => {
    const io = capture()
    expect(await runPanda(['init', 'somewhere'], { ...io, homeDir: await tempCwd() })).toBe(2)
    expect(io.err.join('\n')).toContain("unexpected argument 'somewhere'")

    const second = capture()
    const homeDir = await tempCwd()
    expect(
      await runPanda(['project', 'init', await tempCwd(), await tempCwd()], { ...second, homeDir }),
    ).toBe(2)
    expect(second.err.join('\n')).toContain('at most one directory may be given')
  })

  it('answers --help on the subcommands its own usage block advertises', async () => {
    for (const argv of [['init', '--help'], ['project', 'init', '-h'], ['project', '--help']]) {
      const io = capture()
      expect(await runPanda(argv, { ...io, homeDir: await tempCwd() })).toBe(0)
      expect(io.out.join('\n')).toContain('panda project init')
      expect(io.err).toHaveLength(0)
    }
  })

  it('exits 2 with a code when the directory it was pointed at cannot be used', async () => {
    const io = capture()
    const missing = join(await tempCwd(), 'no', 'such', 'project')
    expect(await runPanda(['project', 'init', missing], { ...io, homeDir: await tempCwd() })).toBe(2)
    expect(io.err.join('\n')).toContain('PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE')
    expect(io.out).toHaveLength(0)
  })

  it('says it could not LOOK, rather than that nothing is installed', async () => {
    const homeDir = await tempCwd()
    await symlink(join(homeDir, '.claude2'), join(homeDir, '.claude'))
    await symlink(join(homeDir, '.claude'), join(homeDir, '.claude2'))

    const io = capture()
    expect(await runPanda(['init'], { ...io, homeDir })).toBe(2)
    const stderr = io.err.join('\n')
    expect(stderr).toContain('no executor configuration was found')
    expect(stderr).toContain('could not determine whether these exist')
    expect(stderr).toContain(join(homeDir, '.claude'))
    expect(stderr).toContain('ELOOP')
  })

  it('prints skips and ledger warnings to stderr while still exiting 0', async () => {
    const homeDir = await tempCwd()
    const projectDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n')
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    // Panda's own ledger, unreadable: panda is about to project without being
    // able to claim what it writes. Exit 0 alone cannot say that.
    await writeFile(join(homeDir, '.panda', 'projection-ledger.json'), '{ broken')

    const io = capture()
    expect(await runPanda(['project', 'init', projectDir], { ...io, homeDir })).toBe(0)
    const stderr = io.err.join('\n')
    expect(stderr).toContain('PANDA_PROJECTION_LEDGER_UNAVAILABLE')
    expect(stderr).toContain('codex: nothing was projected')
  })
})
// --- panda doctor / panda project doctor (Story 2.7b) ----------------------
//
// Same division of labour as init: the CLI's job is argv, output and exit codes,
// and WHAT was diagnosed belongs to `@panda/environment` (proven in
// `packages/environment/test/doctor.test.ts`, including the byte-level
// writes-nothing clause). What is pinned here is the part a script depends on —
// clean exits 0, any finding exits 1, unable-to-look exits 2 — and that the
// binding stays thin enough to print facts it did not invent.

describe('panda doctor', () => {
  it('exits 0 with no findings on an environment that was just projected', async () => {
    const homeDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n')
    expect(await runPanda(['init'], { ...capture(), homeDir })).toBe(0)

    const io = capture()
    const code = await runPanda(['doctor'], { ...io, homeDir })

    expect(code).toBe(0)
    expect(io.err).toHaveLength(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ scope: 'machine', findings: [] })
  })

  it('exits 1 and names the executor, file, location and entry of each finding', async () => {
    const homeDir = await tempCwd()
    const claudeJson = join(homeDir, '.claude.json')
    await writeFile(claudeJson, '{}\n')
    // A registry entry panda projects, then a user edit on top of it.
    await writeFile(
      join(homeDir, '.claude.json'),
      '{\n  "mcpServers": {\n    "ctx": { "type": "stdio", "command": "theirs", "args": [] }\n  }\n}\n',
    )
    const store = new RegistryStore({ homeDir })
    await store.register({ type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] }, 'global')
    await store.dispose()

    const io = capture()
    const code = await runPanda(['doctor'], { ...io, homeDir })

    expect(code).toBe(1)
    const stderr = io.err.join('\n')
    expect(stderr).toContain('foreign-collision')
    expect(stderr).toContain('claude-code')
    expect(stderr).toContain(claudeJson)
    expect(stderr).toContain('mcpServers.ctx')
    // The resolution travels with the finding: what re-projecting would do.
    expect(stderr).toContain('panda never resolves a collision')
    const printed = JSON.parse(io.out.join('\n')) as { findings: { kind: string }[] }
    expect(printed.findings.map((found) => found.kind)).toContain('foreign-collision')
  })

  it('diagnoses the project it was pointed at, and creates nothing there', async () => {
    const homeDir = await tempCwd()
    const projectDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n')

    const io = capture()
    const code = await runPanda(['project', 'doctor', projectDir], { ...io, homeDir })

    expect(code).toBe(1)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({
      scope: 'project',
      pandaDir: join(projectDir, '.panda'),
      targets: [{ executorId: 'claude-code', filePath: join(projectDir, '.mcp.json') }],
    })
    expect(io.err.join('\n')).toContain('not-initialised')
    // The command that reports on a machine must not prepare one.
    expect(readdirSync(projectDir)).toEqual([])
  })

  it('applies the same argv rules as init, and answers --help', async () => {
    for (const argv of [['doctor', '--force'], ['doctor', 'somewhere'], ['project', 'doctor', '-f']]) {
      const io = capture()
      expect(await runPanda(argv, { ...io, homeDir: await tempCwd() }), argv.join(' ')).toBe(2)
      expect(io.out).toHaveLength(0)
    }
    for (const argv of [['doctor', '--help'], ['project', 'doctor', '-h']]) {
      const io = capture()
      expect(await runPanda(argv, { ...io, homeDir: await tempCwd() })).toBe(0)
      expect(io.out.join('\n')).toContain('panda project doctor')
      expect(io.err).toHaveLength(0)
    }
  })

  it('never certifies an environment `panda init` then refuses', async () => {
    // `panda doctor && panda init` — the gate a script actually writes. Doctor
    // exited 0 here while init exited 2 on the same untouched machine.
    const homeDir = await tempCwd()
    const doctorIo = capture()
    const doctorCode = await runPanda(['doctor'], { ...doctorIo, homeDir })
    const initCode = await runPanda(['init'], { ...capture(), homeDir })

    expect(initCode).toBe(2)
    expect(doctorCode).not.toBe(0)
    expect(doctorIo.err.join('\n')).toContain('no-executor')
    // Two facts findings have no room for, and that init prints on the same
    // environment: what panda could not check, and what has no location here.
    const withSkips = capture()
    const projectDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n')
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await runPanda(['project', 'doctor', projectDir], { ...withSkips, homeDir })
    expect(withSkips.err.join('\n')).toContain('codex: nothing would be projected')

    const undetermined = capture()
    const loopHome = await tempCwd()
    await symlink(join(loopHome, '.claude2'), join(loopHome, '.claude'))
    await symlink(join(loopHome, '.claude'), join(loopHome, '.claude2'))
    await runPanda(['doctor'], { ...undetermined, homeDir: loopHome })
    expect(undetermined.err.join('\n')).toContain('could not determine whether these exist')
    expect(undetermined.err.join('\n')).toContain('ELOOP')
  })

  it('exits 0 on a finding that is informational, because no command clears it', async () => {
    // A half-registered `mcp-server` is expressible by no target: it is reported
    // in full and does not fail the run, or the exit code is a light that never
    // goes out. (This row held a `profile` until story M4.F retired that word; a
    // retired entry is a `retired-type` finding, which is the exit-1 row below.)
    const homeDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n')
    const store = new RegistryStore({ homeDir })
    await store.register({ type: 'mcp-server', id: 'frontend' }, 'global')
    await store.dispose()
    expect(await runPanda(['init'], { ...capture(), homeDir })).toBe(0)

    const io = capture()
    const code = await runPanda(['doctor'], { ...io, homeDir })

    expect(code).toBe(0)
    // Printed anyway, with its severity, so a reader can see why 0 is right.
    expect(io.err.join('\n')).toContain('info: unprojectable')
  })

  it('exits 1 on a RETIRED entry, because one command clears it', async () => {
    // The counterpart of the `info` row above, and the pair is the whole point:
    // `unprojectable` is info because nothing can clear it, `retired-type` is a
    // problem because `panda remove` can. Nothing in the CLI covered the retired
    // kind at all, so flipping its severity — exit 1 to exit 0 on a registry
    // panda can no longer fully express — went unnoticed by every suite.
    const homeDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n')
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(
      join(homeDir, '.panda', 'registry.json'),
      JSON.stringify({ version: 1, entries: [{ type: 'tool', id: 'rg', command: 'rg' }] }),
      'utf8',
    )

    const io = capture()
    const code = await runPanda(['doctor'], { ...io, homeDir })

    expect(code).toBe(1)
    const stderr = io.err.join('\n')
    expect(stderr).toContain('problem: retired-type')
    // The exit it prints is the one that works, and the CLI runs it right here.
    expect(stderr).toContain('`panda remove tool rg`')
    expect(await runPanda(['remove', 'tool', 'rg'], { ...capture(), homeDir })).toBe(0)
    expect(await runPanda(['doctor'], { ...capture(), homeDir })).toBe(0)
  })

  it('exits 2 — not 1 — when it could not look at all', async () => {
    // "Found problems" and "could not run" must never share an exit code, or a
    // script cannot tell a diagnosed machine from a broken invocation.
    const io = capture()
    const missing = join(await tempCwd(), 'no', 'such', 'project')
    expect(await runPanda(['project', 'doctor', missing], { ...io, homeDir: await tempCwd() })).toBe(2)
    expect(io.err.join('\n')).toContain('PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE')
    expect(io.out).toHaveLength(0)
  })
})
