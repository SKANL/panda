import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CODE_TRAITS,
  CODEX_TRAITS,
  OPENCODE_TRAITS,
  type ChildProcessSpawner,
  type SpawnedChild,
  type SpawnOptions,
  type SpawnOutcome,
} from '@skanl/panda-adapter-cli'
import type { ResultEnvelope } from '@skanl/panda-contracts'
import { runSession } from '../src/run-session.ts'
import {
  DEFAULT_EXECUTOR_ID,
  EXECUTOR_CATALOGUE,
  availableExecutorIds,
  createExecutorAdapter,
  executorConfigPath,
  resolveExecutor,
} from '../src/executors.ts'

// Every test here points `homeDir` and `projectDir` at temp directories it made
// itself. A test that read the real home directory would pass or fail for
// reasons having nothing to do with the code, which is the defect executor
// selection exists to remove.
//
// That is enforced by `test/isolate-home.ts`, not by discipline: it redirects
// `os.homedir()` for every file in this package, so a future call that forgets
// its `homeDir` still cannot reach the real machine. The clauses under `machine
// independence` below assert that mechanism — an earlier version only asserted
// that a SUPPLIED `homeDir` is honoured, which is a weaker claim than its own
// comment made.

async function tempDir(prefix = 'panda-exec-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Writes `<root>/.panda/config.json`, creating panda's directory as needed. */
async function writeConfig(root: string, contents: string): Promise<string> {
  const filePath = executorConfigPath(root)
  await mkdir(join(root, '.panda'), { recursive: true })
  await writeFile(filePath, contents)
  return filePath
}

interface SpawnCall {
  command: string
  args: string[]
  stdin: string
  cwd: string
}

/**
 * ONE fake child-process spawner, shared by all three vendors. It records what
 * was handed to the OS and answers with whatever stdout the test supplied, so
 * the assertion below is on the REAL argv each trait record produces rather than
 * on "the codex factory was called" — which is satisfiable without codex ever
 * appearing on a command line.
 */
function recordingSpawner(stdoutFor: (command: string) => string): {
  spawner: ChildProcessSpawner
  calls: SpawnCall[]
} {
  const calls: SpawnCall[] = []
  const spawner: ChildProcessSpawner = {
    spawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedChild {
      const call: SpawnCall = { command, args: [...args], stdin: '', cwd: options.cwd }
      calls.push(call)
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
        writeStdin(chunk: string) {
          call.stdin += chunk
        },
        endStdin() {
          state.settled = true
          settle({ exitCode: 0, stdout: stdoutFor(command), stderr: '' })
        },
        killTree() {},
        done,
      }
    },
  }
  return { spawner, calls }
}

// The minimal result-carrying record each vendor really prints, per its trait
// record's documented shape. Minimal on purpose: with no optional metadata in
// the payload, `envelope.data` must come out identical across all three, which
// is a stricter shape claim than the top-level key set alone.
const VENDOR_STDOUT: Record<string, string> = {
  claude: `${JSON.stringify({ type: 'result', result: 'done', is_error: false })}\n`,
  codex: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}\n`,
  opencode: `${JSON.stringify({ type: 'text', part: { type: 'text', text: 'done' } })}\n`,
}

/**
 * The envelope's observable SHAPE: its key set, the type of every top-level
 * value, the type of every value inside `data`, and how many errors it carries.
 * Everything a caller can see without knowing which vendor produced it.
 */
function shapeOf(envelope: ResultEnvelope): Record<string, unknown> {
  const data = (envelope.data ?? {}) as Record<string, unknown>
  return {
    keys: Object.keys(envelope).sort(),
    types: {
      status: typeof envelope.status,
      data: Array.isArray(envelope.data) ? 'array' : envelope.data === null ? 'null' : typeof envelope.data,
      summary: typeof envelope.summary,
      errors: Array.isArray(envelope.errors) ? 'array' : typeof envelope.errors,
    },
    dataTypes: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value])),
    status: envelope.status,
    errorCount: (envelope.errors ?? []).length,
  }
}

describe('the executor catalogue is keyed by the shipped trait records', () => {
  it('holds exactly the three shipped adapters, under their own executorId traits', () => {
    expect(availableExecutorIds()).toEqual([
      CLAUDE_CODE_TRAITS.executorId,
      CODEX_TRAITS.executorId,
      OPENCODE_TRAITS.executorId,
    ])
  })

  it('builds, for every key, an adapter that answers with that same key', () => {
    // The Map key comes from the traits by construction, so a drifting NAME is
    // impossible. What is still possible is a drifting PAIR — codex's traits
    // wired to opencode's factory — and that is what this builds and checks.
    // `CliExecutorAdapter.executorId` is the adapter's own answer, not the
    // catalogue's, so agreement here is agreement between two independent facts.
    for (const [id, shipped] of EXECUTOR_CATALOGUE) {
      expect(shipped.traits.executorId).toBe(id)
      expect(createExecutorAdapter(id).executorId).toBe(id)
    }
    expect(EXECUTOR_CATALOGUE.size).toBe(3)
  })

  it('takes its default from the claude-code trait record, not from a literal', () => {
    expect(DEFAULT_EXECUTOR_ID).toBe(CLAUDE_CODE_TRAITS.executorId)
    expect(EXECUTOR_CATALOGUE.has(DEFAULT_EXECUTOR_ID)).toBe(true)
    // No argument: this is the path `runSession` takes when nothing selected.
    expect(createExecutorAdapter().executorId).toBe(CLAUDE_CODE_TRAITS.executorId)
  })
})

describe('resolveExecutor reports the layer that decided the selection', () => {
  it('runs claude-code from the defaults layer when nothing is configured', async () => {
    const selection = await resolveExecutor({ homeDir: await tempDir(), projectDir: await tempDir() })
    expect(selection).toEqual({
      executorId: 'claude-code',
      layer: 'defaults',
      available: ['claude-code', 'codex', 'opencode'],
    })
  })

  it('takes the machine document as the global layer', async () => {
    const homeDir = await tempDir()
    await writeConfig(homeDir, JSON.stringify({ executor: 'codex' }))
    const selection = await resolveExecutor({ homeDir, projectDir: await tempDir() })
    expect(selection.executorId).toBe('codex')
    expect(selection.layer).toBe('global')
  })

  it('lets the project document override the machine one', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await writeConfig(homeDir, JSON.stringify({ executor: 'codex' }))
    await writeConfig(projectDir, JSON.stringify({ executor: 'opencode' }))
    const selection = await resolveExecutor({ homeDir, projectDir })
    expect(selection.executorId).toBe('opencode')
    expect(selection.layer).toBe('project')
  })

  it('lets an explicit invocation override both documents', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await writeConfig(homeDir, JSON.stringify({ executor: 'codex' }))
    await writeConfig(projectDir, JSON.stringify({ executor: 'codex' }))
    const selection = await resolveExecutor({ executorId: 'opencode', homeDir, projectDir })
    expect(selection.executorId).toBe('opencode')
    expect(selection.layer).toBe('invocation')
  })

  it('reports the layer that really supplied the value, not the narrowest one present', async () => {
    // A document that exists but says nothing about the executor must not claim
    // the selection: the provenance has to name the layer the VALUE came from.
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await writeConfig(homeDir, JSON.stringify({ executor: 'codex' }))
    await writeConfig(projectDir, JSON.stringify({ somethingElse: true }))
    const selection = await resolveExecutor({ homeDir, projectDir })
    expect(selection.executorId).toBe('codex')
    expect(selection.layer).toBe('global')
  })

  it('accepts a document written with a UTF-8 byte order mark', async () => {
    // PowerShell 5.1's `>` and `Set-Content`, Notepad and VS Code's "UTF-8 with
    // BOM" all emit one by default on the platform this repo is developed on.
    // `readFile(path,'utf8')` does not strip it and `JSON.parse` rejects it, so
    // three invisible bytes bricked a document whose visible contents are
    // correct — and because the founding rule is no-silent-fallback, that did not
    // degrade, it stopped the command.
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await writeConfig(projectDir, `\uFEFF${JSON.stringify({ executor: 'codex' })}`)
    const selection = await resolveExecutor({ homeDir, projectDir })
    expect(selection.executorId).toBe('codex')
    expect(selection.layer).toBe('project')
  })

  it('accepts a selection an editor appended whitespace to', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await writeConfig(projectDir, JSON.stringify({ executor: 'codex\n' }))
    expect((await resolveExecutor({ homeDir, projectDir })).executorId).toBe('codex')
  })

  it('refuses an empty scope root instead of relocating the machine scope', async () => {
    // `process.env.HOME ?? ''` is the exact shape Story 2.7a was bitten by, and
    // `RunCommandOptions.homeDir` forwards it raw from a public surface.
    // `join('', '.panda', …)` is RELATIVE, so the machine scope moved into the
    // working directory and the PROJECT's own document was then reported as the
    // `global` layer — a false claim on the one output this story exists to make
    // trustworthy.
    await expect(resolveExecutor({ homeDir: '', projectDir: await tempDir() })).rejects.toMatchObject({
      code: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE',
    })
    await expect(resolveExecutor({ homeDir: await tempDir(), projectDir: '  ' })).rejects.toMatchObject({
      code: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE',
    })
  })

  it('reports one document as `global` when the project root IS the home directory', async () => {
    // Running `panda run` from your own home directory. Loading the single
    // document into both layers reported `project` as the deciding layer for a
    // project that does not exist.
    const root = await tempDir()
    await writeConfig(root, JSON.stringify({ executor: 'codex' }))
    const selection = await resolveExecutor({ homeDir: root, projectDir: root })
    expect(selection.executorId).toBe('codex')
    expect(selection.layer).toBe('global')
  })

  it('treats a missing document as an absent layer rather than an error', async () => {
    const homeDir = await tempDir()
    // Panda's directory exists, its configuration does not — the ordinary state
    // of a machine that has run `panda init` and never chosen an executor.
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    const selection = await resolveExecutor({ homeDir, projectDir: await tempDir() })
    expect(selection.layer).toBe('defaults')
  })
})

describe('resolveExecutor never falls back to the default silently', () => {
  /**
   * Resolve, then run whatever was resolved through a REAL session with a fake
   * spawner. Both halves of the claim in one place: the failure is coded, AND no
   * executor reached a command line — a fallback to claude-code would show up
   * here as a spawn of `claude`.
   */
  async function attempt(homeDir: string, projectDir: string, executorId?: string) {
    const { spawner, calls } = recordingSpawner((command) => VENDOR_STDOUT[command] ?? '')
    let error: unknown
    try {
      const selection = await resolveExecutor({ executorId, homeDir, projectDir })
      await runSession({
        prompt: 'list files',
        cwd: projectDir,
        executorId: selection.executorId,
        adapterOptions: { spawner },
      })
    } catch (caught) {
      error = caught
    }
    return { error, calls }
  }

  const unusable: [string, string][] = [
    ['invalid JSON', '{ not json'],
    ['a JSON array instead of an object', '["codex"]'],
    ['a JSON scalar instead of an object', '"codex"'],
    ['a null selection', JSON.stringify({ executor: null })],
    ['a non-string selection', JSON.stringify({ executor: { name: 'codex' } })],
    ['a numeric selection', JSON.stringify({ executor: 7 })],
  ]

  for (const [label, contents] of unusable) {
    it(`fails coded on ${label}, and runs nothing`, async () => {
      const homeDir = await tempDir()
      const projectDir = await tempDir()
      const filePath = await writeConfig(projectDir, contents)
      const { error, calls } = await attempt(homeDir, projectDir)
      expect((error as { code?: string })?.code).toBe('PANDA_CONFIGURATION_UNUSABLE')
      // The path is in the message, because the user has to know WHICH file.
      expect((error as Error).message).toContain(filePath)
      expect(calls).toEqual([])
    })
  }

  it('fails coded when the document exists but cannot be read, and runs nothing', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    // A DIRECTORY where the document belongs: present, and unreadable. This is
    // the other side of the absent/unreadable line — absent is a layer panda
    // does not have, unreadable is a configuration panda cannot honour.
    await mkdir(executorConfigPath(projectDir), { recursive: true })
    const { error, calls } = await attempt(homeDir, projectDir)
    expect((error as { code?: string })?.code).toBe('PANDA_CONFIGURATION_UNUSABLE')
    expect(calls).toEqual([])
  })

  const hostile = '{ "__proto__": { "executor": "codex" }, "executor": "codex" }'

  it('rejects a prototype-polluting PROJECT document, naming the file, and runs nothing', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const filePath = await writeConfig(projectDir, hostile)
    const { error, calls } = await attempt(homeDir, projectDir)
    expect((error as { code?: string })?.code).toBe('PANDA_CONFIGURATION_UNUSABLE')
    // The kernel's own guard is what did the rejecting — `setLayer` validates the
    // snapshot, so the document goes in WHOLE and a copy of that rule here could
    // never drift from it. Its error is preserved as the cause; what the wrapper
    // adds is the one fact the kernel cannot know, which is WHICH FILE.
    expect((error as Error).message).toContain(filePath)
    expect((error as Error).message).toContain("the 'project' configuration layer rejected it")
    expect(((error as { cause?: { code?: string } })?.cause)?.code).toBe('PANDA_KERNEL_INVALID_LAYER')
    expect(calls).toEqual([])
    // And nothing was polluted on the way past.
    expect(({} as Record<string, unknown>)['executor']).toBeUndefined()
  })

  it('rejects a prototype-polluting GLOBAL document, naming that file', async () => {
    // Mirrored deliberately. Reducing the GLOBAL document to just its `executor`
    // key before `setLayer` — so the kernel never sees the hostile keys — left
    // the suite green, because only the project layer was ever pinned; the same
    // mutation on the project layer failed two clauses. A guard pinned on one of
    // two identical paths is a guard on one path.
    const homeDir = await tempDir()
    const filePath = await writeConfig(homeDir, hostile)
    const { error, calls } = await attempt(homeDir, await tempDir())
    expect((error as { code?: string })?.code).toBe('PANDA_CONFIGURATION_UNUSABLE')
    expect((error as Error).message).toContain(filePath)
    expect((error as Error).message).toContain("the 'global' configuration layer rejected it")
    expect(calls).toEqual([])
  })

  it('refuses an unboundedly nested document CODED, rather than crashing', async () => {
    // The kernel's `validateNode` recurses with no depth bound: at ~3000 levels
    // it threw a bare `RangeError` whose `code` was `undefined`, so the CLI
    // printed six words with no `PANDA_*` prefix and no file path. The matrix
    // says unknown input is "coded, not a crash"; exit 2 was right by accident.
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const filePath = await writeConfig(
      projectDir,
      `{ "executor": "codex", "deep": ${'['.repeat(5000)}${']'.repeat(5000)} }`,
    )
    const { error, calls } = await attempt(homeDir, projectDir)
    expect((error as { code?: string })?.code).toBe('PANDA_CONFIGURATION_UNUSABLE')
    expect((error as Error).message).toContain(filePath)
    expect(calls).toEqual([])
  })

  it('refuses a dangling symbolic link instead of treating it as absent', async () => {
    // `readFile` FOLLOWS symlinks, so a broken link reports ENOENT exactly like a
    // file that was never there — and panda would then run a DIFFERENT agent in
    // silence. This is the one present-but-unusable state out of the whole set
    // that used to slip through the no-silent-fallback rule, and every dotfile
    // manager materialises this file as a symlink.
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await mkdir(join(projectDir, '.panda'), { recursive: true })
    await symlink(join(projectDir, '.panda', 'nowhere.json'), executorConfigPath(projectDir))
    const { error, calls } = await attempt(homeDir, projectDir)
    expect((error as { code?: string })?.code).toBe('PANDA_CONFIGURATION_UNUSABLE')
    expect((error as Error).message).toContain(executorConfigPath(projectDir))
    expect(calls).toEqual([])
  })

  it('fails coded on an executor name panda has no adapter for, listing every available id', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await writeConfig(projectDir, JSON.stringify({ executor: 'aider' }))
    const { error, calls } = await attempt(homeDir, projectDir)
    expect((error as { code?: string })?.code).toBe('PANDA_EXECUTOR_NOT_FOUND')
    const message = (error as Error).message
    for (const id of availableExecutorIds()) expect(message).toContain(id)
    // NOT `executorUnavailable`: that means the binary did not spawn, and the
    // fix for this one is a different name rather than an installation.
    expect((error as { code?: string })?.code).not.toBe('PANDA_EXECUTOR_UNAVAILABLE')
    expect(calls).toEqual([])
  })

  it('names the GLOBAL file when the machine document holds the bad value', async () => {
    // Disabling the per-layer type check left the suite green: bad values fell
    // through to the post-composition branch, which threw the same code and
    // happened to name the PROJECT path — which is where every fixture wrote.
    // The check has two jobs and neither was covered: name the right file, and
    // fire for the global layer at all.
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const globalPath = await writeConfig(homeDir, JSON.stringify({ executor: 7 }))
    const projectPath = await writeConfig(projectDir, JSON.stringify({ executor: 'codex' }))
    const { error, calls } = await attempt(homeDir, projectDir)
    expect((error as { code?: string })?.code).toBe('PANDA_CONFIGURATION_UNUSABLE')
    expect((error as Error).message).toContain(globalPath)
    expect((error as Error).message).not.toContain(projectPath)
    // And it still errors even though a VALID project value would have won
    // composition: panda refuses a document it cannot read, it does not route
    // around one.
    expect(calls).toEqual([])
  })

  it('refuses a blank selection by naming it, not by calling it a missing adapter', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await writeConfig(projectDir, JSON.stringify({ executor: '   ' }))
    const { error } = await attempt(homeDir, projectDir)
    expect((error as { code?: string })?.code).toBe('PANDA_CONFIGURATION_UNUSABLE')
    expect((error as Error).message).toContain('is blank')
  })

  it('fails coded on an unknown name given at the invocation, and runs nothing', async () => {
    const { error, calls } = await attempt(await tempDir(), await tempDir(), 'aider')
    expect((error as { code?: string })?.code).toBe('PANDA_EXECUTOR_NOT_FOUND')
    expect(calls).toEqual([])
  })
})

describe('each selection really runs ITS vendor', () => {
  /**
   * The proof the story turns on. One fake spawner, three selections, each one
   * arrived at by writing a real configuration document and resolving it — then
   * run through a REAL `runSession`, real workspace and real interception
   * waterfall. What is asserted is the command and argv that reached the OS.
   */
  async function runSelected(
    configured: string,
    stdoutFor: (command: string) => string = (command) => VENDOR_STDOUT[command] ?? '',
  ): Promise<{ call: SpawnCall; envelope: ResultEnvelope }> {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await writeConfig(projectDir, JSON.stringify({ executor: configured }))
    const selection = await resolveExecutor({ homeDir, projectDir })
    expect(selection.executorId).toBe(configured)

    // NO `createAdapter`. That seam BYPASSES `executorId` by design, so a proof
    // that used it exercised the catalogue and the traits and never the
    // `executorId` → adapter wiring inside `runSession` — which is how deleting
    // `executorId:` from the CLI's `runSession` call left the whole gate green
    // while the real binary announced codex and ran claude-code. The spawner
    // arrives through `adapterOptions`, on the production path.
    const { spawner, calls } = recordingSpawner(stdoutFor)
    const envelope = await runSession({
      prompt: 'list files',
      cwd: projectDir,
      executorId: selection.executorId,
      adapterOptions: { spawner },
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error('the spawner recorded no call')
    return { call, envelope }
  }

  it('spawns claude with stream print mode and the prompt on stdin', async () => {
    const { call } = await runSelected('claude-code')
    expect(call.command).toBe('claude')
    expect(call.args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      // `stream-json` under `--print` exits 1 without `--verbose` (M15.A, E7),
      // so the pair is pinned here as well as in the adapter's own suite.
      '--verbose',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
    ])
    expect(call.stdin).toBe('list files')
    // Never in argv for a stdin-delivery executor.
    expect(call.args).not.toContain('list files')
  })

  it('spawns codex exec with the JSON stream and the prompt on stdin', async () => {
    const { call } = await runSelected('codex')
    expect(call.command).toBe('codex')
    expect(call.args).toEqual(['exec', '--json', '--skip-git-repo-check'])
    expect(call.stdin).toBe('list files')
    expect(call.args).not.toContain('list files')
  })

  it('spawns opencode run with the prompt as a positional after --', async () => {
    const { call } = await runSelected('opencode')
    expect(call.command).toBe('opencode')
    expect(call.args).toEqual(['run', '--format', 'json', '--', 'list files'])
    // The separator matters: without it a prompt starting with `-` is parsed as
    // a flag. Pinned positionally, not just by membership.
    expect(call.args[call.args.length - 2]).toBe('--')
    expect(call.stdin).toBe('')
  })

  it('produces one envelope shape across all three, key set and value types alike', async () => {
    const envelopes = [
      (await runSelected('claude-code')).envelope,
      (await runSelected('codex')).envelope,
      (await runSelected('opencode')).envelope,
    ]
    const shapes = envelopes.map(shapeOf)
    const [first] = shapes
    expect(first).toEqual({
      keys: ['data', 'errors', 'status', 'summary'],
      types: { status: 'string', data: 'object', summary: 'string', errors: 'array' },
      // TYPES inside `data`, not only its keys: codex returning `result` as a
      // number while the others return a string left a key-only comparison
      // green.
      dataTypes: { result: 'string' },
      status: 'ok',
      errorCount: 0,
    })
    for (const shape of shapes) expect(shape).toEqual(first)
    // The same answer, not merely the same shape.
    for (const envelope of envelopes) expect(envelope.summary).toBe('done')
  })

  it('produces one envelope shape across all three on the FAILURE path too', async () => {
    // Each vendor reports failure in its own vocabulary — claude's `is_error`,
    // codex's and opencode's `error` events, the last carrying an OBJECT detail.
    // The envelope that comes out must not.
    const failing: Record<string, string> = {
      claude: `${JSON.stringify({ type: 'result', result: 'nope', is_error: true, subtype: 'error_max_turns' })}\n`,
      codex: `${JSON.stringify({ type: 'error', message: 'nope' })}\n`,
      opencode: `${JSON.stringify({ type: 'error', error: { message: 'nope' } })}\n`,
    }
    const shapes = []
    for (const id of ['claude-code', 'codex', 'opencode']) {
      const { envelope } = await runSelected(id, (command) => failing[command] ?? '')
      expect(envelope.status).toBe('failed')
      shapes.push({
        keys: Object.keys(envelope).sort(),
        errorKeys: Object.keys(((envelope.errors ?? [])[0] ?? {}) as Record<string, unknown>).sort(),
        errorCode: (envelope.errors ?? [])[0]?.code,
        summaryType: typeof envelope.summary,
      })
    }
    const [first] = shapes
    expect(first).toEqual({
      keys: ['data', 'errors', 'status', 'summary'],
      errorKeys: ['code', 'message'],
      errorCode: 'PANDA_EXECUTOR_RUN_FAILED',
      summaryType: 'string',
    })
    for (const shape of shapes) expect(shape).toEqual(first)
  })
})

describe('runSession takes the selection already made', () => {
  it('selects from the catalogue rather than a hardcoded constructor', async () => {
    // An id the catalogue does not hold reaches the coded failure from INSIDE
    // the session. A hardcoded `createClaudeCodeAdapter()` fallback could not
    // produce this, which is what makes it a proof rather than a restatement.
    //
    // The spawner is here so the MUTANT fails by assertion rather than by
    // timeout: with the lookup reduced to `createExecutorAdapter()`, this used to
    // build a real claude-code adapter over the real Node spawner and try to
    // spawn `claude` — five seconds on a clean machine, and a real billed agent
    // invocation on one that has it installed.
    const { spawner, calls } = recordingSpawner(() => VENDOR_STDOUT['claude'] ?? '')
    await expect(
      runSession({ prompt: 'list files', cwd: await tempDir(), executorId: 'aider', adapterOptions: { spawner } }),
    ).rejects.toMatchObject({ code: 'PANDA_EXECUTOR_NOT_FOUND' })
    expect(calls).toEqual([])
  })

  it('refuses an id it has no adapter for BEFORE it creates a workspace', async () => {
    // "An invalid request must cost no mkdir" is stated at the top of
    // `runSession` and was true only of the prompt: the catalogue lookup ran
    // after `provider.create()`, so an unknown id left a workspace directory on
    // disk that nothing removes. `panda run` never saw it because
    // `resolveExecutor` validates first — the FR-29 path is the one that did.
    const cwd = await tempDir()
    await expect(
      runSession({ prompt: 'list files', cwd, executorId: 'aider' }),
    ).rejects.toMatchObject({ code: 'PANDA_EXECUTOR_NOT_FOUND' })
    expect(await readdir(cwd)).toEqual([])
  })

  it('fails a throwing createAdapter factory before the provider is constructed', async () => {
    // Hoisting the catalogue lookup moved the `createAdapter` CALL above the
    // provider too, which changed this path: a throwing factory used to lease a
    // workspace and unwind through release/dispose, and now costs neither. The
    // better behaviour, and previously unpinned — which is how the next silent
    // reordering gets in. Pinned as ordering, not as an error message.
    const cwd = await tempDir()
    let providerWasConstructed = false
    await expect(
      runSession({
        prompt: 'list files',
        cwd,
        createAdapter: () => {
          throw new Error('adapter construction failed')
        },
        createProvider: () => {
          providerWasConstructed = true
          throw new Error('unreachable: the adapter factory throws first')
        },
      }),
    ).rejects.toThrow('adapter construction failed')
    expect(providerWasConstructed).toBe(false)
    expect(await readdir(cwd)).toEqual([])
  })

  it('lets an injected createAdapter win over the selected id', async () => {
    const { calls } = recordingSpawner(() => '')
    const envelope = await runSession({
      prompt: 'list files',
      cwd: await tempDir(),
      executorId: 'codex',
      createAdapter: () => ({
        run: () => Promise.resolve({ status: 'ok', data: null, summary: 'injected', errors: [] }),
      }),
    })
    expect(envelope.summary).toBe('injected')
    // The seam wins whole: nothing from the catalogue reached a command line.
    expect(calls).toEqual([])
  })

  it('reads no configuration of its own', async () => {
    // A document selecting codex, in the very directory the session is told to
    // work under. `runSession` must not consult it — the selection is the
    // caller's to make, and a session that read the filesystem would make every
    // `panda run` test depend on whoever ran the suite.
    const projectDir = await tempDir()
    await writeConfig(projectDir, JSON.stringify({ executor: 'codex' }))
    const { spawner, calls } = recordingSpawner((command) => VENDOR_STDOUT[command] ?? '')
    // No `executorId`, so this is the catalogue DEFAULT taken on the production
    // path — and it stays claude-code with a codex document underfoot.
    await runSession({ prompt: 'list files', cwd: projectDir, adapterOptions: { spawner } })
    expect(calls.map((call) => call.command)).toEqual(['claude'])
  })
})

describe('machine independence', () => {
  it('honours the homeDir seam it is given', async () => {
    const homeDir = await tempDir()
    await writeConfig(homeDir, JSON.stringify({ executor: 'opencode' }))
    const selection = await resolveExecutor({ homeDir, projectDir: await tempDir() })
    expect(selection.executorId).toBe('opencode')
    expect(homeDir).not.toBe(homedir())
  })

  it('cannot reach the real machine even when NO homeDir is given', async () => {
    // The clause above only proves a SUPPLIED seam is honoured; it says nothing
    // about a call that forgets one, which is the drift that would silently
    // start reading whoever ran the suite. `test/isolate-home.ts` redirects
    // `os.homedir()` for every file in this package, and this asserts the
    // mechanism rather than its absence: the resolved home is under the temp
    // directory, and a document written THERE is picked up as the global layer.
    //
    // The prefix check runs FIRST and deliberately: without the setup file this
    // test would otherwise write into the real `~/.panda/config.json`.
    const isolated = homedir()
    expect(isolated.startsWith(tmpdir())).toBe(true)
    expect(isolated).not.toBe(tmpdir())

    await mkdir(join(isolated, '.panda'), { recursive: true })
    await writeFile(executorConfigPath(isolated), JSON.stringify({ executor: 'opencode' }))
    try {
      const selection = await resolveExecutor({ projectDir: await tempDir() })
      expect(selection).toMatchObject({ executorId: 'opencode', layer: 'global' })
    } finally {
      await rm(executorConfigPath(isolated), { force: true })
    }
  })
})
