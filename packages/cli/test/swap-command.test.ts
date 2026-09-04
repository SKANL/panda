import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runPanda } from '../src'

const run = promisify(execFile)

async function fixture(): Promise<{ homeDir: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'panda-swap-'))
  const homeDir = join(root, 'home')
  const projectDir = join(root, 'project')
  await mkdir(homeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  return { homeDir, projectDir }
}

function configPath(root: string): string {
  return join(root, '.panda', 'config.json')
}

async function writeConfig(root: string, document: unknown): Promise<void> {
  await mkdir(join(root, '.panda'), { recursive: true })
  await writeFile(configPath(root), JSON.stringify(document), 'utf8')
}

async function readConfig(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath(root), 'utf8')) as Record<string, unknown>
}

/** The smallest module `resolveMethod` accepts, so the write is what fails or not. */
const VALID_METHOD = 'export default { id: "m", version: "1.0.0", phases: [], artifacts: [], commands: [] }'

interface Captured {
  readonly code: number
  readonly out: string
  readonly err: string
}

async function panda(argv: readonly string[], fixtures: { homeDir: string; projectDir?: string }): Promise<Captured> {
  const outLines: string[] = []
  const errLines: string[] = []
  const code = await runPanda(argv, {
    homeDir: fixtures.homeDir,
    cwd: fixtures.projectDir,
    stdout: (line) => outLines.push(line),
    stderr: (line) => errLines.push(line),
  })
  return { code, out: outLines.join('\n'), err: errLines.join('\n') }
}

describe('M5.C: panda swap executor writes the selection', () => {
  it('persists the id into the machine document and says where', async () => {
    const { homeDir, projectDir } = await fixture()

    const result = await panda(['swap', 'executor', 'codex'], { homeDir, projectDir })

    expect(result.code).toBe(0)
    expect(await readConfig(homeDir)).toEqual({ executor: 'codex' })
    expect(result.err).toContain('codex')
    expect(result.err).toContain(configPath(homeDir))
  })

  it('reports the previous value, so a change is distinguishable from a no-op', async () => {
    const { homeDir, projectDir } = await fixture()
    await writeConfig(homeDir, { executor: 'codex' })

    const result = await panda(['swap', 'executor', 'codex'], { homeDir, projectDir })

    expect(result.code).toBe(0)
    expect(result.err).toMatch(/already/i)
  })
})

describe('M5.C row 4: an id panda has no adapter for', () => {
  it('exits 2 listing the available executors, and writes nothing', async () => {
    const { homeDir, projectDir } = await fixture()

    const result = await panda(['swap', 'executor', 'bogus'], { homeDir, projectDir })

    expect(result.code).toBe(2)
    expect(result.err).toContain('bogus')
    for (const id of ['claude-code', 'codex', 'opencode']) expect(result.err).toContain(id)
    await expect(readFile(configPath(homeDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('M5.C rows 5, 6, 16 and 17: argv panda will not act on', () => {
  it.each([
    ['no noun', ['swap']],
    ['a noun swap does not take', ['swap', 'nonsense', 'codex']],
    ['no id', ['swap', 'executor']],
    ['a blank id', ['swap', 'executor', '   ']],
    ['a trailing positional the machine scope has no room for', ['swap', 'executor', 'codex', 'extra']],
  ])('exits 2 for %s and writes nothing', async (_label, argv) => {
    const { homeDir, projectDir } = await fixture()

    const result = await panda(argv, { homeDir, projectDir })

    expect(result.code).toBe(2)
    await expect(readFile(configPath(homeDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('M5.C row 12: writing a layer a narrower one overrides', () => {
  // THE LIE THIS STORY EXISTS TO NOT TELL. The write succeeds, the file now says
  // `codex`, and the effective selection is still `claude-code` because the
  // project document is narrower. A command that printed only "done" here would
  // be the "dispatchable is not delivers" failure, shipped again.
  it('says the effective selection did not change, and names the layer that decides', async () => {
    const { homeDir, projectDir } = await fixture()
    await writeConfig(projectDir, { executor: 'claude-code' })

    const result = await panda(['swap', 'executor', 'codex'], { homeDir, projectDir })

    expect(result.code).toBe(0)
    expect(await readConfig(homeDir)).toEqual({ executor: 'codex' })
    expect(result.err).toContain('claude-code')
    expect(result.err).toContain("'project'")
  })

  it('says nothing about an override when the layer it wrote is the one that decides', async () => {
    const { homeDir, projectDir } = await fixture()

    const result = await panda(['swap', 'executor', 'codex'], { homeDir, projectDir })

    expect(result.code).toBe(0)
    expect(result.err).not.toMatch(/still|override/i)
  })
})

describe('M5.C rows 13 and 14: panda project swap executor', () => {
  it('writes the project document and leaves the machine one alone', async () => {
    const { homeDir, projectDir } = await fixture()
    await writeConfig(homeDir, { executor: 'claude-code' })

    const result = await panda(['project', 'swap', 'executor', 'codex'], { homeDir, projectDir })

    expect(result.code).toBe(0)
    expect(await readConfig(projectDir)).toEqual({ executor: 'codex' })
    expect(await readConfig(homeDir)).toEqual({ executor: 'claude-code' })
  })

  // FOUND BY USING THE BINARY, not by the suite. Every test above hands
  // `runPanda` a `cwd`, and the real binary hands it none — so `project swap`
  // exited 2 with PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE for every actual user
  // while these tests stayed green. A harness that supplies what the real
  // caller does not is testing a caller that does not exist.
  it('falls back to the process working directory when no cwd is supplied, as the binary does', async () => {
    const { homeDir, projectDir } = await fixture()
    const previous = process.cwd()
    process.chdir(projectDir)
    try {
      const result = await panda(['project', 'swap', 'executor', 'codex'], { homeDir })
      expect(result.code).toBe(0)
      expect(await readConfig(projectDir)).toEqual({ executor: 'codex' })
    } finally {
      process.chdir(previous)
    }
  })

  it('takes an explicit directory rather than the cwd', async () => {
    const { homeDir, projectDir } = await fixture()
    const elsewhere = join(projectDir, 'nested')
    await mkdir(elsewhere, { recursive: true })

    const result = await panda(['project', 'swap', 'executor', 'codex', elsewhere], { homeDir, projectDir })

    expect(result.code).toBe(0)
    expect(await readConfig(elsewhere)).toEqual({ executor: 'codex' })
    await expect(readFile(configPath(projectDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('M5.C row 15: the selection persists across PROCESSES', () => {
  // A read-back inside the process that wrote proves only that the object in
  // memory is what it was. "Persists across processes" is FR-28's word and the
  // only honest proof is a second process, so this one spawns the real binary.
  it('a second process sees the value the first one wrote', async () => {
    const { homeDir, projectDir } = await fixture()
    const written = await panda(['swap', 'executor', 'codex'], { homeDir, projectDir })
    expect(written.code).toBe(0)
    expect(written.err).not.toMatch(/already/i)

    // The SAME command again, in a real second process. It has to READ the
    // document to answer "already", so `already` is only reachable if the first
    // process's write survived the process boundary. Asserting the file's bytes
    // here would prove the filesystem works; asserting this proves panda's own
    // read path crosses the boundary, which is what FR-28's word means.
    const binary = join(import.meta.dirname, '..', 'bin', 'panda.ts')
    const second = await run(
      process.execPath,
      ['--conditions=panda-source', binary, 'swap', 'executor', 'codex'],
      { env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir }, cwd: projectDir },
    )

    expect(second.stderr).toMatch(/already/i)
    expect(second.stderr).toContain('codex')
  })
})

describe('M30.B: what the machine document stores must mean the same thing everywhere', () => {
  /**
   * `swap` VALIDATED one file and STORED a specifier meaning a different one.
   *
   * `swap-command.ts` computes `projectDir` from cwd for the MACHINE scope too
   * and validates `resolveMethod(id, projectDir)`. So `panda swap method
   * ./mine.mjs` run from a project validated THAT project's `mine.mjs` and then
   * wrote the raw `./mine.mjs` into the HOME document — where `runSession`
   * resolves it against whatever directory the next run happens to stand in.
   *
   * Driven before this clause existed, with a control: standing in a directory
   * carrying only a `mine.mjs` and NO `.panda` config at all, that module's
   * top-level code RAN; the same directory with an empty HOME did not run it.
   * A wildcard over every repository on the machine.
   *
   * THE FIRST FIX HERE WAS A REFUSAL, AND THE REFUSAL WAS THE WRONG SHAPE.
   * It made the run-time guard's own advice — "name the module by ABSOLUTE path
   * in your own machine document" — cost the user a path they had to spell
   * themselves, while panda was standing in the very directory that resolves it.
   * A refusal that a one-line resolution removes is a refusal that exists to
   * spare the implementer, not the user.
   *
   * So the specifier is resolved HERE, where the user is standing and can see
   * what was stored, and the stored value is the one that was validated. The
   * run-time guard stays: a relative machine specifier can still reach the
   * document by hand or from an older build, and there it means nothing.
   */
  it('resolves a relative machine specifier against cwd and stores the absolute path', async () => {
    const at = await fixture()
    const absolute = join(at.projectDir, 'mine.mjs')
    await writeFile(absolute, VALID_METHOD, 'utf8')

    const said = await panda(['swap', 'method', './mine.mjs'], at)

    expect(said.code, said.err).toBe(0)
    // The STORED value is the assertion that matters: a success line naming the
    // absolute path over a document holding './mine.mjs' would read identically.
    expect((await readConfig(at.homeDir))['method']).toBe(absolute)
    // And the user is told, because the thing they typed is not the thing panda
    // kept — a resolution the user cannot see is the same lie as a bad store.
    expect(said.err).toContain(absolute)
    expect(said.err).toContain('./mine.mjs')
  })

  it('CONTROL: an absolute machine specifier is stored unchanged', async () => {
    // Without this the clause above is satisfied by a verb that rewrites every
    // specifier, which would break a package specifier the same way.
    const at = await fixture()
    const absolute = join(at.projectDir, 'mine.mjs')
    await writeFile(absolute, VALID_METHOD, 'utf8')

    const machine = await panda(['swap', 'method', absolute], at)

    expect(machine.code, machine.err).toBe(0)
    expect((await readConfig(at.homeDir))['method']).toBe(absolute)
  })
})

describe('M30.C: a verb that writes what no run will honour must say so', () => {
  /**
   * `panda project swap method X` exits 0, prints `selected:`, writes the key —
   * and EVERY subsequent run refuses it, because `assertMethodMayMount` refuses
   * the LAYER unconditionally, whatever the specifier. Driven at 7148c9a with a
   * control: same project, key removed, `panda run` reaches the executor.
   *
   * THE WRITE IS NOT THE DEFECT AND MUST NOT BE REMOVED. Spec M25.A froze row
   * E4 — "`project swap method X` still writes the project document (M5.D row
   * 6)" — and M5.D designed the project-scope write. Deleting a designed,
   * frozen behaviour to fix a printed word is the worst trade available here.
   *
   * The defect is the word `selected`, which claims an effect the value will
   * never have. So the write stands and the sentence tells the truth, including
   * the one command that DOES take effect — measured to work, not assumed:
   * `panda swap method <spec>` from the project directory now resolves and
   * stores the absolute path, and the run mounts it.
   */
  it('says the project document RECOMMENDS a method, and names the command that selects one', async () => {
    const at = await fixture()
    await writeFile(join(at.projectDir, 'mine.mjs'), VALID_METHOD, 'utf8')

    const said = await panda(['project', 'swap', 'method', './mine.mjs'], at)

    expect(said.code, said.err).toBe(0)
    // Row E4 stands: the document is still written.
    expect((await readConfig(at.projectDir))['method']).toBe('./mine.mjs')
    // And the word that was a lie is gone.
    expect(said.err).not.toContain('selected:')
    expect(said.err).toContain('recommend')
    expect(said.err).toContain('panda swap method ./mine.mjs')
  })

  it('CONTROL: project swap EXECUTOR still says selected, because that one takes effect', async () => {
    // The asymmetry is the point. Without this clause the change above is
    // satisfied by making every project write hedge, which would be false for
    // the executor: nothing refuses a project-layer executor.
    const at = await fixture()

    const said = await panda(['project', 'swap', 'executor', 'codex'], at)

    expect(said.code, said.err).toBe(0)
    expect(said.err).toContain('selected:')
    expect(said.err).not.toContain('recommend')
  })
})
