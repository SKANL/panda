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
