import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RegistryStore } from '@skanl/panda-environment'
import { runPanda } from '../src'
import type { RunCommandOptions } from '../src'

// `panda remediate` at the binary's edge: argv, output and exit codes.
//
// Every fact printed here is the capability's — which finding was selected, what
// would change, whether panda refused. The CLI classifies nothing and writes
// nothing, so what these rows pin is the binding: that the default DESCRIBES,
// that `--apply` is what performs, that a refusal is exit 1 and a usage error is
// exit 2, and that a selector the capability cannot resolve is never guessed at.

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: (line) => out.push(line), stderr: (line) => err.push(line), out, err }
}

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'panda-cli-remediate-'))
}

/** A machine with claude-code present and one panda-written entry the user edited. */
async function editedEntry(): Promise<string> {
  const homeDir = await tempCwd()
  const claudeJson = join(homeDir, '.claude.json')
  await writeFile(claudeJson, '{}\n', 'utf8')
  const store = new RegistryStore({ homeDir })
  await store.register({ type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] }, 'global')
  await store.dispose()
  const io = capture()
  await runPanda(['init'], { ...io, homeDir })
  await writeFile(claudeJson, (await readFile(claudeJson, 'utf8')).replace('"ctx-server"', '"mine"'), 'utf8')
  return homeDir
}

/**
 * THE COMMAND PANDA PRINTS IS RUN, not read.
 *
 * Every clause in `printed-commands.test.ts` asks whether a printed verb
 * DISPATCHES, and `panda remediate` dispatches perfectly — it simply answers
 * about the machine. At project scope panda was naming commands that exit 1 or
 * do nothing:
 *
 *   project doctor on an edited entry  -> "`panda remediate adopt` or `panda remediate release`"
 *                                         both exit 1, REMEDIATION_REFUSED
 *   project doctor uninitialised       -> "`panda init`", which exits 0 and
 *                                         leaves the project exactly as it was
 *
 * A string assertion would pin the spelling and prove nothing about the state.
 * These take the command out of panda's own output and EXECUTE it.
 */
const PRINTED_COMMAND = /`(panda [^`]+)`/g

function commandsPrintedIn(lines: readonly string[]): string[] {
  return [...lines.join(' ').matchAll(PRINTED_COMMAND)]
    .map((match) => match[1])
    .filter((text): text is string => text !== undefined)
    .map((text) => text.trim())
}

describe('a command panda prints at project scope resolves the project', () => {
  /**
   * THE EXIT, not any command in the paragraph.
   *
   * The first draft of this clause collected every `panda …` in the whole report
   * and ran them all — and it PASSED, because the RESOLUTION half already names
   * both spellings ("`panda init` (or `panda project init`) creates panda's
   * state here") while the EXIT half, the sentence a user acts on, named only
   * the machine one. Running both fixed the project and hid the defect. The
   * clause has to isolate the sentence `FINDING_EXITS` renders.
   */
  const exitCommandsIn = (report: string): string[] => {
    const sentence = report.split('To leave this state:')[1] ?? ''
    return commandsPrintedIn([sentence.split('. ')[0] ?? ''])
  }

  it('names an init that actually initialises the project it was asked about', async () => {
    const homeDir = await tempCwd()
    const projectDir = await tempCwd()

    const reported = capture()
    await runPanda(['project', 'doctor', projectDir], { ...reported, homeDir })
    const report = [...reported.out, ...reported.err].join('\n')
    // CONTROL: the state this clause needs must be reported, or the assertion
    // below passes by measuring an empty report.
    expect(report, 'doctor did not report not-initialised, so this clause tested nothing').toContain(
      'not-initialised',
    )
    const named = exitCommandsIn(report)
    expect(named.length, `doctor named no exit:\n${report}`).toBeGreaterThan(0)

    // Run exactly what the exit named, then ask doctor again. The finding has to
    // be gone — which is the only thing "an exit" can honestly mean.
    for (const text of named) {
      const ran = capture()
      await runPanda(text.split(' ').slice(1), { ...ran, homeDir, cwd: projectDir })
    }
    const after = capture()
    await runPanda(['project', 'doctor', projectDir], { ...after, homeDir })
    expect(
      after.out.join('\n'),
      `the exit doctor named left the project uninitialised: ${named.join(', ')}`,
    ).not.toContain('not-initialised')
  })

  it('tells a project claim which init will act on it', async () => {
    const homeDir = await tempCwd()
    const projectDir = await tempCwd()
    const mcpJson = join(projectDir, '.mcp.json')
    await writeFile(join(homeDir, '.claude.json'), '{}\n', 'utf8')
    await mkdir(join(projectDir, '.panda'), { recursive: true })

    const io = capture()
    await runPanda(['project', 'add', 'mcp-server', 'ctx', '--command', 'ctx-server', projectDir], { ...io, homeDir })
    await runPanda(['project', 'init', projectDir], { ...io, homeDir })
    const projected = await readFile(mcpJson, 'utf8')
    expect(projected).toContain('ctx-server')
    await writeFile(mcpJson, projected.replace('"ctx-server"', '"edited-by-hand"'), 'utf8')

    const described = capture()
    await runPanda(['project', 'remediate', 'adopt', projectDir, '--entry', 'ctx'], { ...described, homeDir })
    const said = [...described.out, ...described.err].join('\n')
    // CONTROL: the consequence sentence has to be there at all, or the
    // assertion below reads an empty string and passes.
    expect(said, `adopt described nothing:\n${said}`).toMatch(/REPLACES what is there|REMOVES what this claim covers/)
    // The sentence used to name `panda init` alone. Driven before the fix: the
    // hand-edited byte survived that command and died to `panda project init`.
    expect(said, 'the consequence named only the machine init').toContain('panda project init')
  })

  it('names a remediation the project scope will accept', async () => {
    const homeDir = await tempCwd()
    const projectDir = await tempCwd()
    const mcpJson = join(projectDir, '.mcp.json')
    await writeFile(join(homeDir, '.claude.json'), '{}\n', 'utf8')
    await mkdir(join(projectDir, '.panda'), { recursive: true })

    const io = capture()
    await runPanda(['project', 'add', 'mcp-server', 'ctx', '--command', 'ctx-server', projectDir], { ...io, homeDir })
    await runPanda(['project', 'init', projectDir], { ...io, homeDir })
    const projected = await readFile(mcpJson, 'utf8')
    // CONTROL: the state this clause needs must actually exist, or it passes by
    // reporting nothing.
    expect(projected).toContain('ctx-server')
    await writeFile(mcpJson, projected.replace('"ctx-server"', '"edited-by-hand"'), 'utf8')

    const reported = capture()
    await runPanda(['project', 'doctor', projectDir], { ...reported, homeDir })
    const named = commandsPrintedIn([...reported.out, ...reported.err]).filter((text) =>
      text.includes('remediate'),
    )
    expect(named.length, `doctor named no remediation:\n${reported.out.join('\n')}`).toBeGreaterThan(0)

    for (const text of named) {
      const ran = capture()
      const code = await runPanda(text.split(' ').slice(1), { ...ran, homeDir, cwd: projectDir })
      expect(
        [code, ran.err.join(' ')],
        `panda printed '${text}' and running it was refused`,
      ).not.toContain('PANDA_PROJECTION_REMEDIATION_REFUSED')
      expect(code, `panda printed '${text}' and running it exited ${String(code)}`).not.toBe(1)
    }
  })
})

describe('panda remediate', () => {
  it('describes without writing by default, and performs only with --apply', async () => {
    const homeDir = await editedEntry()
    const claudeJson = join(homeDir, '.claude.json')
    const edited = await readFile(claudeJson, 'utf8')

    const described = capture()
    expect(await runPanda(['remediate', 'adopt', '--executor', 'claude-code', '--entry', 'ctx'], {
      ...described,
      homeDir,
    })).toBe(0)
    const payload = JSON.parse(described.out.join('\n')) as {
      mode: string
      finding: { kind: string }
      outcome: { applied: boolean; changes: { subject: string }[] }
    }
    expect(payload.mode).toBe('inspect')
    expect(payload.finding.kind).toBe('edited')
    expect(payload.outcome.applied).toBe(false)
    expect(payload.outcome.changes.map((change) => change.subject)).toEqual(['ledger'])
    expect(described.err.join('\n')).toContain('would change')
    expect(described.err.join('\n')).toContain('--apply')
    // The description is a description: the ledger is not written either.
    const ledgerBefore = await readFile(join(homeDir, '.panda', 'projection-ledger.json'), 'utf8')

    const applied = capture()
    expect(await runPanda(['remediate', 'adopt', '--executor=claude-code', '--entry=ctx', '--apply'], {
      ...applied,
      homeDir,
    })).toBe(0)
    expect((JSON.parse(applied.out.join('\n')) as { outcome: { applied: boolean } }).outcome.applied).toBe(true)
    expect(applied.err.join('\n')).toContain('changed:')
    expect(await readFile(join(homeDir, '.panda', 'projection-ledger.json'), 'utf8')).not.toBe(ledgerBefore)
    // No vendor byte, in either call.
    expect(await readFile(claudeJson, 'utf8')).toBe(edited)
  })

  it('exits 1 on a refusal and prints the findings the user could have named', async () => {
    const homeDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n', 'utf8')
    const io = capture()
    // Nothing drifted, so there is no finding `adopt` resolves.
    expect(await runPanda(['remediate', 'adopt', '--apply'], { ...io, homeDir })).toBe(1)
    expect(io.err.join('\n')).toContain('PANDA_PROJECTION_REMEDIATION_REFUSED')
    expect(io.err.join('\n')).toContain('did not just report')
  })

  it('rejects an unknown remediation, a missing one and a bare flag value', async () => {
    for (const argv of [
      ['remediate'],
      ['remediate', 'purge'],
      ['remediate', 'adopt', '--entry'],
      ['remediate', 'adopt', '--executor=-x'],
      ['remediate', 'adopt', '--force'],
      ['remediate', 'adopt', 'release'],
      // The machine scope has one scope and takes no directory.
      ['remediate', 'adopt', 'somewhere'],
    ]) {
      const io = capture()
      expect(await runPanda(argv, { ...io, homeDir: await tempCwd() }), argv.join(' ')).toBe(2)
      expect(io.out, argv.join(' ')).toHaveLength(0)
      expect(io.err.join('\n')).toContain('usage: panda run')
    }
  })

  it('prints the WHOLE synopsis on a usage error, not a prefix of it', async () => {
    // `DEFAULT_USAGE` was a line COUNT, and the two subcommands this story added
    // pushed `panda --help` off the end of it — silently, for six pre-existing
    // usage-error paths, which then advertised `panda remediate` without
    // `panda project remediate` and no longer said help existed.
    const io = capture()
    expect(await runPanda(['bogus'], { ...io, homeDir: await tempCwd() })).toBe(2)
    const printed = io.err.join('\n')
    for (const line of [
      'panda run',
      'panda init',
      'panda project init',
      'panda doctor',
      'panda project doctor',
      'panda remediate',
      'panda project remediate',
      'panda --help',
    ]) {
      expect(printed, line).toContain(line)
    }
  })

  it('answers --help wherever it appears, and takes a directory for the project scope', async () => {
    const io = capture()
    // Not only as the FIRST option token: `panda run` accepts it anywhere and
    // two answers to one question is how a binding drifts.
    expect(await runPanda(['remediate', 'adopt', '--apply', '--help'], { ...io, homeDir: await tempCwd() })).toBe(0)
    expect(io.out.join('\n')).toContain('panda project remediate')

    const homeDir = await tempCwd()
    const projectDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n', 'utf8')
    const scoped = capture()
    // The directory positional its two siblings already take.
    expect(
      await runPanda(['project', 'remediate', 'release', projectDir, '--apply'], { ...scoped, homeDir }),
    ).toBe(1)
    expect(JSON.parse(scoped.out.join('\n'))).toMatchObject({ scope: 'project' })
  })

  it('answers --help and advertises every remediation panda has', async () => {
    for (const argv of [
      ['remediate', '--help'],
      ['project', 'remediate', '-h'],
    ]) {
      const io = capture()
      expect(await runPanda(argv, { ...io, homeDir: await tempCwd() })).toBe(0)
      const printed = io.out.join('\n')
      for (const verb of ['adopt', 'release', 'repair', 'discard']) expect(printed).toContain(`  ${verb} `)
      expect(io.err).toHaveLength(0)
    }
  })

  it('runs against the project scope when asked, without touching the machine one', async () => {
    const homeDir = await tempCwd()
    const projectDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n', 'utf8')
    const io = capture()
    // Nothing is initialised in the project, so the only findings are ones no
    // remediation resolves — which is a refusal, not a crash and not a write.
    expect(await runPanda(['project', 'remediate', 'release', '--apply'], { ...io, homeDir, cwd: projectDir })).toBe(1)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ scope: 'project', remediation: 'release' })
  })

  it('removes a legacy block only when asked, by name', async () => {
    const homeDir = await tempCwd()
    await writeFile(join(homeDir, '.claude.json'), '{}\n', 'utf8')
    await mkdir(join(homeDir, '.claude'), { recursive: true })
    const settings = join(homeDir, '.claude', 'settings.json')
    await writeFile(settings, '{\n  "model": "sonnet",\n  "panda": {\n    "version": 1\n  }\n}\n', 'utf8')

    const doctor = capture()
    expect(await runPanda(['doctor'], { ...doctor, homeDir })).toBe(1)
    expect(doctor.err.join('\n')).toContain('legacy-block')

    const io = capture()
    expect(await runPanda(['remediate', 'discard', '--executor', 'claude-code', '--apply'], { ...io, homeDir })).toBe(0)
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ model: 'sonnet' })

    const after = capture()
    expect(await runPanda(['doctor'], { ...after, homeDir })).toBe(1)
    expect(after.err.join('\n')).not.toContain('legacy-block')
  })
})
