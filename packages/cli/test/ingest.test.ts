import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runPanda } from '../src'

// `panda ingest` at the binary's own boundary: argv, the rendered outcome and
// the exit code. What was found and what was excluded is the capability's, and
// is proven in `packages/environment/test/ingest.test.ts`.
//
// The two clauses that matter most here cannot be proven anywhere else, because
// both are about BYTES ON DISK after a real command: a preview that writes
// nothing (E13), and a second identical run that leaves the registry document
// unchanged to the byte (E14).

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

async function panda(tokens: readonly string[], homeDir: string): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const code = await runPanda(tokens, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    homeDir,
    cwd: homeDir,
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panda-cli-ingest-'))
  tempRoots.push(root)
  const homeDir = join(root, 'home')
  await mkdir(homeDir, { recursive: true })
  return homeDir
}

/** A skill in the root Claude Code was measured to read, under an injected home. */
async function plantSkill(homeDir: string, id: string, body = '# planted'): Promise<string> {
  const directory = join(homeDir, '.claude', 'skills', id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), body, 'utf8')
  return directory
}

const registryPath = (homeDir: string): string => join(homeDir, '.panda', 'registry.json')

async function bytesAt(path: string): Promise<string> {
  return await readFile(path, 'utf8').catch(() => '<absent>')
}

describe('panda ingest', () => {
  it('registers the skills already on this machine and exits 0', async () => {
    const homeDir = await fixture()
    await plantSkill(homeDir, 'deslop')
    await plantSkill(homeDir, 'graphify')

    const run = await panda(['ingest'], homeDir)

    expect(run.code).toBe(0)
    const payload = JSON.parse(run.out) as { registered: string[]; dryRun: boolean }
    expect(payload.registered.sort()).toEqual(['skill:deslop', 'skill:graphify'])
    expect(payload.dryRun).toBe(false)
    expect(run.err).toContain(registryPath(homeDir))
    // And the entries really are listable afterwards, which is the whole point:
    // `panda list` returned an empty registry on a machine full of skills.
    const listed = await panda(['list'], homeDir)
    expect(listed.code).toBe(0)
    expect((JSON.parse(listed.out) as { entries: unknown[] }).entries).toHaveLength(2)
  })

  it('exits 0 with nothing to write, exactly as `panda list` does on an empty registry', async () => {
    const homeDir = await fixture()

    const run = await panda(['ingest'], homeDir)

    expect(run.code).toBe(0)
    expect((JSON.parse(run.out) as { registered: string[] }).registered).toEqual([])
    // A run that wrote nothing because there was nothing to write is a RESULT.
    expect(await bytesAt(registryPath(homeDir))).toBe('<absent>')
  })

  it('E13: --dry-run reports the identical outcome and writes zero bytes', async () => {
    const homeDir = await fixture()
    await plantSkill(homeDir, 'previewed')
    await mkdir(join(homeDir, '.claude', 'skills', 'not-a-skill'), { recursive: true })

    const before = await bytesAt(registryPath(homeDir))
    const preview = await panda(['ingest', '--dry-run'], homeDir)
    const afterPreview = await bytesAt(registryPath(homeDir))
    const real = await panda(['ingest'], homeDir)

    expect(preview.code).toBe(0)
    expect(afterPreview).toBe(before)
    const previewed = JSON.parse(preview.out) as Record<string, unknown>
    const written = JSON.parse(real.out) as Record<string, unknown>
    expect(previewed['dryRun']).toBe(true)
    expect(written['dryRun']).toBe(false)
    // Every fact but the flag itself: the preview is the same computation.
    expect({ ...previewed, dryRun: false }).toEqual(written)
    expect(previewed['registered']).toEqual(['skill:previewed'])
    expect(preview.err).toContain('nothing was written')
  })

  it('E14: a second run over an unchanged disk leaves the registry BYTE-IDENTICAL', async () => {
    const homeDir = await fixture()
    await plantSkill(homeDir, 'stable')

    const first = await panda(['ingest'], homeDir)
    const afterFirst = await bytesAt(registryPath(homeDir))
    const second = await panda(['ingest'], homeDir)
    const afterSecond = await bytesAt(registryPath(homeDir))

    expect(first.code).toBe(0)
    expect(second.code).toBe(0)
    // CONTROL: the first run really did write a document, so the equality below
    // is a stable ingest rather than two runs that both wrote nothing.
    expect(afterFirst).not.toBe('<absent>')
    expect(afterSecond).toBe(afterFirst)
    expect((JSON.parse(second.out) as { registered: string[]; unchanged: string[] })).toMatchObject({
      registered: [],
      unchanged: ['skill:stable'],
    })
  })

  it('names every candidate it skipped, and says which rule stopped it', async () => {
    const homeDir = await fixture()
    await plantSkill(homeDir, 'real')
    await mkdir(join(homeDir, '.claude', 'skills', '.git'), { recursive: true })
    await plantSkill(homeDir, 'constructor')

    const run = await panda(['ingest'], homeDir)

    expect(run.code).toBe(0)
    const skipped = (JSON.parse(run.out) as { skipped: { kind: string; path: string }[] }).skipped
    expect(skipped.map((item) => item.kind).sort()).toEqual(['not-a-skill', 'unusable-id'])
    expect(run.err).toContain('.git')
    expect(run.err).toContain('constructor')
  })

  it('refuses coded and exits 2 when the ownership ledger cannot be read', async () => {
    const homeDir = await fixture()
    await plantSkill(homeDir, 'would-have-been-ingested')
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(join(homeDir, '.panda', 'projection-ledger.json'), '{ not json', 'utf8')

    const run = await panda(['ingest'], homeDir)

    expect(run.code).toBe(2)
    expect(run.err).toContain('PANDA_PROJECTION_LEDGER_UNAVAILABLE')
    expect(await bytesAt(registryPath(homeDir))).toBe('<absent>')
  })

  it('prints usage and exits 0 on --help, and refuses an option it does not have', async () => {
    const homeDir = await fixture()

    expect((await panda(['ingest', '--help'], homeDir)).code).toBe(0)
    expect((await panda(['ingest', '-h'], homeDir)).code).toBe(0)
    const bad = await panda(['ingest', '--all'], homeDir)
    expect(bad.code).toBe(2)
    expect(bad.err).toContain('unrecognized option')
    const positional = await panda(['ingest', 'skills'], homeDir)
    expect(positional.code).toBe(2)
    expect(positional.err).toContain("unexpected argument 'skills'")
  })

  it('is advertised in the usage block, dry run included', async () => {
    const homeDir = await fixture()
    const help = await panda(['--help'], homeDir)
    expect(help.out).toContain('panda ingest')
    expect(help.out).toContain('--dry-run')
  })
})
