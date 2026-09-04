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

/** A server in the file Claude Code was measured to read, in its own shape. */
async function plantServer(homeDir: string, id: string, args: readonly string[] = ['-y']): Promise<void> {
  const filePath = join(homeDir, '.claude.json')
  const current = JSON.parse(await readFile(filePath, 'utf8').catch(() => '{}')) as {
    mcpServers?: Record<string, unknown>
  }
  const servers = { ...current.mcpServers, [id]: { type: 'stdio', command: 'uvx', args } }
  await writeFile(filePath, `${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`, 'utf8')
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

  it('AC1: registers the MCP servers a vendor config already declares, and list shows them', async () => {
    const homeDir = await fixture()
    await plantServer(homeDir, 'fetch', ['mcp-server-fetch'])
    await plantSkill(homeDir, 'a-skill')

    const run = await panda(['ingest'], homeDir)

    expect(run.code).toBe(0)
    const payload = JSON.parse(run.out) as { registered: string[]; configPaths: string[] }
    // BOTH halves in one run, through one call.
    expect(payload.registered.sort()).toEqual(['mcp-server:fetch', 'skill:a-skill'])
    expect(payload.configPaths).toContain(join(homeDir, '.claude.json'))
    const listed = await panda(['list'], homeDir)
    const entries = (JSON.parse(listed.out) as { entries: { type: string; id: string; command?: string }[] }).entries
    expect(entries.find((entry) => entry.type === 'mcp-server')).toMatchObject({ id: 'fetch', command: 'uvx' })
  })

  it('E14: --dry-run previews the mcp half too and writes zero bytes', async () => {
    const homeDir = await fixture()
    await plantServer(homeDir, 'previewed')

    const before = await bytesAt(registryPath(homeDir))
    const preview = await panda(['ingest', '--dry-run'], homeDir)
    const afterPreview = await bytesAt(registryPath(homeDir))
    const real = await panda(['ingest'], homeDir)

    expect(afterPreview).toBe(before)
    const previewed = JSON.parse(preview.out) as Record<string, unknown>
    const written = JSON.parse(real.out) as Record<string, unknown>
    expect(previewed['registered']).toEqual(['mcp-server:previewed'])
    // Every fact but the flag itself: the preview is the same computation.
    expect({ ...previewed, dryRun: false }).toEqual(written)
  })

  it('E15: a second run over an unchanged machine leaves the registry BYTE-IDENTICAL', async () => {
    const homeDir = await fixture()
    await plantServer(homeDir, 'stable')

    await panda(['ingest'], homeDir)
    const afterFirst = await bytesAt(registryPath(homeDir))
    const second = await panda(['ingest'], homeDir)
    const afterSecond = await bytesAt(registryPath(homeDir))

    expect(second.code).toBe(0)
    // CONTROL: the first run really wrote the server, so the equality below is
    // a stable ingest rather than two runs that both wrote nothing.
    expect(afterFirst).toContain('stable')
    expect(afterSecond).toBe(afterFirst)
  })

  it('E12: names the keys that stayed in the vendor file, on stderr and in the report', async () => {
    const homeDir = await fixture()
    const rich = { type: 'stdio', command: 'uvx', args: [], env: { T: '1' } }
    await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({ mcpServers: { rich } }, null, 2)}\n`, 'utf8')

    const run = await panda(['ingest'], homeDir)

    expect(run.code).toBe(0)
    expect(JSON.parse(run.out)).toMatchObject({ mcpServers: { dropped: [{ entryId: 'rich', keys: ['env'] }] } })
    expect(run.err).toContain("'env' stayed in")
  })

  it('E13: a server with no command to run is named and skipped, and the rest proceeds', async () => {
    const homeDir = await fixture()
    await mkdir(join(homeDir, '.config', 'opencode'), { recursive: true })
    const mcp = { empty: { type: 'local', command: [] }, fine: { type: 'local', command: ['uvx'] } }
    await writeFile(
      join(homeDir, '.config', 'opencode', 'opencode.json'),
      `${JSON.stringify({ mcp }, null, 2)}\n`,
      'utf8',
    )

    const run = await panda(['ingest'], homeDir)

    expect(run.code).toBe(0)
    const payload = JSON.parse(run.out) as { registered: string[]; mcpServers: { skipped: { kind: string }[] } }
    // CONTROL: the sibling landed, so the skip is that entry rather than a file
    // that was never read.
    expect(payload.registered).toEqual(['mcp-server:fine'])
    expect(payload.mcpServers.skipped.map((item) => item.kind)).toEqual(['unreadable-entry'])
    expect(run.err).toContain('empty array')
  })

  it('E7: refuses coded and exits 2 on a malformed vendor document, writing nothing', async () => {
    const homeDir = await fixture()
    await plantSkill(homeDir, 'would-have-been-ingested')
    await writeFile(join(homeDir, '.claude.json'), '{"mcpServers": {"a": {"command": "x"},,}}', 'utf8')

    const run = await panda(['ingest'], homeDir)

    expect(run.code).toBe(2)
    // `line N, column M` is panda's own spelling. This read V8's `line N
    // column M` until M17.A, which discards V8's message because the credential
    // travelled inside it; the location the user acts on is unchanged.
    expect(run.err).toMatch(/line \d+, column \d+/)
    // Phase 1 validates every origin before phase 2 writes, so the skill that
    // WOULD have landed did not.
    expect(await bytesAt(registryPath(homeDir))).toBe('<absent>')
  })

  it('AC6: a hand-written server plus an add of the same id leaves doctor clean', async () => {
    // The D4 widening, proven where it bites: NO ingest anywhere in this run.
    const homeDir = await fixture()
    await plantServer(homeDir, 'ctx', ['-y', 'x'])
    const fixtureBytes = await bytesAt(join(homeDir, '.claude.json'))

    await panda(['add', 'mcp-server', 'ctx', '--command', 'uvx', '--arg', '-y', '--arg', 'x'], homeDir)
    const init = await panda(['init'], homeDir)
    const doctor = await panda(['doctor'], homeDir)

    expect(doctor.code).toBe(0)
    expect(init.err + doctor.err).not.toContain('foreign-collision')
    expect(await bytesAt(join(homeDir, '.claude.json'))).toBe(fixtureBytes)
    // NOT ADOPTED: panda wrote none of those bytes, so it claims none of them.
    expect(await bytesAt(join(homeDir, '.panda', 'projection-ledger.json'))).toContain('"records": []')
  })

  it('AC6 CONTROL: one argument different and it is STILL a foreign collision', async () => {
    const homeDir = await fixture()
    await plantServer(homeDir, 'ctx', ['-y', 'x'])
    const fixtureBytes = await bytesAt(join(homeDir, '.claude.json'))

    await panda(['add', 'mcp-server', 'ctx', '--command', 'uvx', '--arg', '-y', '--arg', 'somebody-else'], homeDir)
    await panda(['init'], homeDir)
    const doctor = await panda(['doctor'], homeDir)

    // A comparison that answers "satisfied" for everything is not a comparison.
    expect(doctor.code).toBe(1)
    expect(doctor.err).toContain('foreign-collision')
    expect(await bytesAt(join(homeDir, '.claude.json'))).toBe(fixtureBytes)
    expect(await bytesAt(join(homeDir, '.panda', 'projection-ledger.json'))).toContain('"records": []')
  })

  it('is advertised in the usage block, dry run included', async () => {
    const homeDir = await fixture()
    const help = await panda(['--help'], homeDir)
    expect(help.out).toContain('panda ingest')
    expect(help.out).toContain('--dry-run')
    // Both halves are advertised, or the command goes on describing one.
    expect(help.out).toContain('MCP servers')
  })
})
