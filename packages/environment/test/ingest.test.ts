import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import { SKILL_ENTRY_FILE } from '@panda/projection'
import { RegistryStore } from '@panda/registry'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { diagnose } from '../src/doctor.ts'
import { EXECUTOR_PROFILES } from '../src/executors.ts'
import { ingestMachine } from '../src/ingest.ts'
import { initMachine } from '../src/init.ts'
import { snapshotRealSkillsRoots } from './real-skills-roots.ts'

// `panda ingest`'s capability half: which roots are read, what the ownership
// ledger excludes, and what happens when the ledger cannot be read at all.
//
// Every fixture injects its own home, and the developer's real skills roots are
// snapshotted around the whole file — this suite plants skills in directories
// that have the same NAMES as the ones holding their real work.

const tempRoots: string[] = []
let realRootsBefore: string

beforeAll(async () => {
  realRootsBefore = await snapshotRealSkillsRoots()
})

afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
  expect(await snapshotRealSkillsRoots()).toBe(realRootsBefore)
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panda-ingest-env-'))
  tempRoots.push(root)
  const homeDir = join(root, 'home')
  await mkdir(homeDir, { recursive: true })
  return homeDir
}

/** Claude Code, Codex and OpenCode all present, so every verified root applies. */
async function withEveryExecutor(homeDir: string): Promise<void> {
  await writeFile(join(homeDir, '.claude.json'), '{}\n', 'utf8')
  await mkdir(join(homeDir, '.codex'), { recursive: true })
  await mkdir(join(homeDir, '.config', 'opencode'), { recursive: true })
  await writeFile(join(homeDir, '.config', 'opencode', 'opencode.json'), '{}\n', 'utf8')
}

async function plantSkill(root: string, id: string): Promise<string> {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, SKILL_ENTRY_FILE),
    `---\nname: ${id}\ndescription: A planted skill.\n---\n\nBody.\n`,
    'utf8',
  )
  return directory
}

/** One server in Claude Code's own file, in Claude Code's own entry shape. */
async function plantServer(homeDir: string, id: string): Promise<void> {
  const filePath = join(homeDir, '.claude.json')
  const current = JSON.parse(await readFile(filePath, 'utf8').catch(() => '{}')) as {
    mcpServers?: Record<string, unknown>
  }
  const servers = { ...current.mcpServers, [id]: { type: 'stdio', command: 'uvx', args: [`${id}-server`] } }
  await writeFile(filePath, `${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`, 'utf8')
}

const machineRoots = (homeDir: string): string[] =>
  EXECUTOR_PROFILES.flatMap((profile) =>
    profile.machineSkills === undefined ? [] : [profile.machineSkills(homeDir)],
  )

describe('panda ingest reads exactly the roots panda has verified (D2)', () => {
  it('takes every machineSkills root, and nothing panda has not proven an executor reads', async () => {
    const homeDir = await fixture()
    const roots = machineRoots(homeDir)
    for (const [index, root] of roots.entries()) await plantSkill(root, `planted-${index}`)
    // `~/.agents/skills` holds 27 skills on the author's machine and NO panda
    // executor has been proven to read it, so it is not a source in this story.
    await plantSkill(join(homeDir, '.agents', 'skills'), 'agents-only')

    const report = await ingestMachine({ homeDir })

    // The three verified roots, SPELLED OUT. Comparing against the same flatMap
    // the capability runs would pass with any location at all in the profiles;
    // this fails the moment ingest reads somewhere panda has not proven.
    expect(report.roots).toEqual([
      join(homeDir, '.claude', 'skills'),
      join(homeDir, '.codex', 'skills'),
      join(homeDir, '.config', 'opencode', 'skills'),
    ])
    expect(report.roots).toEqual(roots)
    expect([...report.outcome.registered].sort()).toEqual(
      roots.map((_, index) => `skill:planted-${index}`),
    )
    expect(report.outcome.registered).not.toContain('skill:agents-only')
  })

  it('looks for the entry file the PROJECTION writes, not a second spelling of it', async () => {
    const homeDir = await fixture()
    const [root] = machineRoots(homeDir)
    const directory = join(root!, 'wrong-entry-file')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'skill.markdown'), 'not the entry file', 'utf8')
    await plantSkill(root!, 'right-entry-file')

    const report = await ingestMachine({ homeDir })

    // CONTROL: the sibling written with SKILL_ENTRY_FILE lands, so the miss is
    // the file NAME rather than a root that was never read.
    expect(report.outcome.registered).toEqual(['skill:right-entry-file'])
    expect(report.skipped.map((item) => item.kind)).toEqual(['not-a-skill'])
  })
})

describe('a path the ownership ledger owns is never ingested (D3)', () => {
  it('does not grow the registry when panda ingests what panda just projected', async () => {
    const homeDir = await fixture()
    await withEveryExecutor(homeDir)
    const sources = join(homeDir, 'sources')
    await mkdir(sources, { recursive: true })
    await writeFile(join(sources, 'alpha.md'), '---\nname: alpha\n---\n\nAlpha.\n', 'utf8')
    const store = new RegistryStore({ homeDir })
    await store.register({ type: 'skill', id: 'alpha', entryPath: join(sources, 'alpha.md') }, 'global')
    await store.dispose()

    // Panda writes `<root>/alpha/SKILL.md` into every detected executor's root.
    await initMachine({ homeDir })
    const before = await countEntries(homeDir)

    const report = await ingestMachine({ homeDir })

    expect(await countEntries(homeDir)).toBe(before)
    expect(report.outcome.registered).toEqual([])
    // CONTROL: panda really did materialise into those roots, so the count above
    // is an exclusion rather than an ingest that found nothing to look at.
    expect(report.ownedByPanda.length).toBe(machineRoots(homeDir).length)
  })

  it('ingests a hand-authored skill sitting in the same root beside panda\'s own output', async () => {
    const homeDir = await fixture()
    await withEveryExecutor(homeDir)
    const sources = join(homeDir, 'sources')
    await mkdir(sources, { recursive: true })
    await writeFile(join(sources, 'alpha.md'), '---\nname: alpha\n---\n\nAlpha.\n', 'utf8')
    const store = new RegistryStore({ homeDir })
    await store.register({ type: 'skill', id: 'alpha', entryPath: join(sources, 'alpha.md') }, 'global')
    await store.dispose()
    await initMachine({ homeDir })
    await plantSkill(machineRoots(homeDir)[0]!, 'written-by-a-human')

    const report = await ingestMachine({ homeDir })

    expect(report.outcome.registered).toEqual(['skill:written-by-a-human'])
  })
})

describe('an unreadable ownership ledger refuses the run (E10 / M11.A E6)', () => {
  it('rejects coded before a single store write, because ingesting panda\'s own output is worse', async () => {
    const homeDir = await fixture()
    const root = machineRoots(homeDir)[0]!
    await plantSkill(root, 'would-have-been-ingested')
    // A server in a vendor config too: ONE ledger read is the precondition for
    // BOTH origins, so the refusal has to cover the mcp half as well. A file
    // that would otherwise contribute is what makes that a measurement.
    await plantServer(homeDir, 'would-have-been-ingested-too')
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(join(homeDir, '.panda', 'projection-ledger.json'), '{ not json', 'utf8')

    const error = await ingestMachine({ homeDir }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(PandaError)
    expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.projectionLedgerUnavailable)
    expect((error as PandaError).message).toContain('projection-ledger.json')
    expect(await countEntries(homeDir)).toBe(0)
    // CONTROL: with a readable ledger the very same skill AND the very same
    // server ARE ingested, so the refusal above is the ledger and not an empty
    // root or an unread config.
    await rm(join(homeDir, '.panda', 'projection-ledger.json'))
    expect([...(await ingestMachine({ homeDir })).outcome.registered].sort()).toEqual([
      'mcp-server:would-have-been-ingested-too',
      'skill:would-have-been-ingested',
    ])
  })
})

describe('the mcp-server half of the same run (M11.A)', () => {
  it('AC3: supplies toolProviders and reads every VERIFIED machineConfig, and nothing else', async () => {
    const homeDir = await fixture()
    await plantServer(homeDir, 'from-claude')

    const report = await ingestMachine({ homeDir })

    // The three verified locations, SPELLED OUT. Comparing against the same
    // profile map the capability walks would pass with any path at all.
    expect(report.mcpServers.configPaths).toEqual([
      join(homeDir, '.claude.json'),
      join(homeDir, '.codex', 'config.toml'),
      join(homeDir, '.config', 'opencode', 'opencode.json'),
    ])
    expect(report.mcpServers.configPaths).toEqual(
      EXECUTOR_PROFILES.map((profile) => profile.machineConfig(homeDir)),
    )
    expect(report.outcome.registered).toEqual(['mcp-server:from-claude'])
  })

  it('E5: reports what the ledger claims, with the native location that record renders', async () => {
    const homeDir = await fixture()
    await withEveryExecutor(homeDir)
    const store = new RegistryStore({ homeDir })
    await store.register({ type: 'mcp-server', id: 'owned', command: 'npx', args: ['-y'] }, 'global')
    await store.dispose()
    // Panda writes `owned` into all three configs and claims each one.
    await initMachine({ homeDir })

    const report = await ingestMachine({ homeDir })

    expect(report.mcpServers.ownedByPanda.map((item) => item.targetId).sort()).toEqual([
      'claude-mcp',
      'codex-config',
      'opencode-config',
    ])
    // The location is REPORTED and is not the match key: it is a rendering of
    // the targetId and entryId that are.
    expect(report.mcpServers.ownedByPanda.map((item) => item.nativeLocation).sort()).toEqual([
      'mcp.owned',
      'mcpServers.owned',
      'mcp_servers.owned',
    ])
    // CONTROL: a hand-written server in the SAME file panda just wrote into is
    // still ingested, so the exclusion is per entry rather than per file.
    await plantServer(homeDir, 'written-by-a-human')
    expect((await ingestMachine({ homeDir })).outcome.registered).toEqual([
      'mcp-server:written-by-a-human',
    ])
  })

  it('AC2: ingest then init then diagnose reports NO problem, and panda claims only what it wrote', async () => {
    const homeDir = await fixture()
    await withEveryExecutor(homeDir)
    await plantServer(homeDir, 'users-own')

    await ingestMachine({ homeDir })
    await initMachine({ homeDir })
    const diagnosis = await diagnose({ homeDir })

    expect(diagnosis.findings.filter((finding) => finding.severity === 'problem')).toEqual([])
    const ledger = JSON.parse(
      await readFile(join(homeDir, '.panda', 'projection-ledger.json'), 'utf8'),
    ) as { records: { targetId: string; entryId: string }[] }
    const claimed = ledger.records.filter((record) => record.entryId === 'users-own')
    // Projected into the two executors that did NOT already have it, and NOT
    // claimed where the user's own bytes already sat: panda did not write
    // those, so claiming them would be an authority to delete them later.
    expect(claimed.map((record) => record.targetId).sort()).toEqual(['codex-config', 'opencode-config'])
  })

  it('E12: an ingested server names the keys that stayed behind, with the file they stayed in', async () => {
    const homeDir = await fixture()
    await writeFile(
      join(homeDir, '.claude.json'),
      `${JSON.stringify({ mcpServers: { rich: { type: 'stdio', command: 'npx', args: ['-y'], env: { T: '1' } } } }, null, 2)}\n`,
      'utf8',
    )

    const report = await ingestMachine({ homeDir })

    expect(report.outcome.registered).toEqual(['mcp-server:rich'])
    expect(report.mcpServers.dropped).toEqual([
      { entryId: 'rich', filePath: join(homeDir, '.claude.json'), keys: ['env'] },
    ])
  })
})


// The shapes a REAL vendor config holds, each written the way a person writes
// it rather than the way `renderMcpEntry` emits it.
//
// This corpus is the point of the clause below, not decoration. The first build
// of the already-satisfied comparison compared RENDERED BYTES, and the
// acceptance fixture it was proven against had been generated from
// `renderMcpEntry` — so it landed in the one shape that passes, reported green,
// and reported a `foreign-collision` on every ordinary machine. A falsification
// that is not representative is this repository's own recorded lesson, and it
// recurred.
const REAL_SHAPES: readonly {
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  readonly write: (homeDir: string) => Promise<void>
}[] = [
  {
    label: 'claude: minimal — no type, no args',
    command: 'npx',
    args: [],
    write: async (homeDir) =>
      await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({ mcpServers: { ctx: { command: 'npx' } } }, null, 2)}\n`, 'utf8'),
  },
  {
    label: 'claude: args present, type absent',
    command: 'npx',
    args: ['-y', 'x'],
    write: async (homeDir) =>
      await writeFile(
        join(homeDir, '.claude.json'),
        `${JSON.stringify({ mcpServers: { ctx: { command: 'npx', args: ['-y', 'x'] } } }, null, 2)}\n`,
        'utf8',
      ),
  },
  {
    label: 'claude: type present, args absent',
    command: 'npx',
    args: [],
    write: async (homeDir) =>
      await writeFile(
        join(homeDir, '.claude.json'),
        `${JSON.stringify({ mcpServers: { ctx: { type: 'stdio', command: 'npx' } } }, null, 2)}\n`,
        'utf8',
      ),
  },
  {
    label: 'claude: carries an env block panda cannot represent',
    command: 'npx',
    args: ['-y', 'x'],
    write: async (homeDir) =>
      await writeFile(
        join(homeDir, '.claude.json'),
        `${JSON.stringify({ mcpServers: { ctx: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { T: '1' } } } }, null, 2)}\n`,
        'utf8',
      ),
  },
  {
    label: 'codex: args before command',
    command: 'npx',
    args: ['-y', 'x'],
    write: async (homeDir) => {
      await mkdir(join(homeDir, '.codex'), { recursive: true })
      await writeFile(join(homeDir, '.codex', 'config.toml'), '[mcp_servers.ctx]\nargs = ["-y", "x"]\ncommand = "npx"\n', 'utf8')
    },
  },
  {
    label: 'codex: a comment inside the table',
    command: 'npx',
    args: ['-y', 'x'],
    write: async (homeDir) => {
      await mkdir(join(homeDir, '.codex'), { recursive: true })
      await writeFile(
        join(homeDir, '.codex', 'config.toml'),
        '# my servers\n[mcp_servers.ctx]\n# the upstream one\ncommand = "npx"\nargs = ["-y", "x"]\n',
        'utf8',
      )
    },
  },
  {
    label: 'opencode: no type, argv as one array',
    command: 'npx',
    args: ['-y', 'x'],
    write: async (homeDir) => {
      await mkdir(join(homeDir, '.config', 'opencode'), { recursive: true })
      await writeFile(
        join(homeDir, '.config', 'opencode', 'opencode.json'),
        `${JSON.stringify({ mcp: { ctx: { command: ['npx', '-y', 'x'] } } }, null, 2)}\n`,
        'utf8',
      )
    },
  },
]

describe('AC2 over the shapes a REAL config holds, not the shape panda renders', () => {
  it.each(REAL_SHAPES.map((shape) => [shape.label, shape] as const))(
    '%s: ingest then init then diagnose reports NOTHING',
    async (_label, shape) => {
      const homeDir = await fixture()
      await shape.write(homeDir)

      const ingested = await ingestMachine({ homeDir })
      await initMachine({ homeDir })
      const diagnosis = await diagnose({ homeDir })

      // CONTROL inside every row: the server really was ingested, so the silence
      // below is a comparison that answered "already satisfied" rather than a
      // config that was never read.
      expect(ingested.outcome.registered).toEqual(['mcp-server:ctx'])
      expect(diagnosis.findings.filter((finding) => finding.severity === 'problem')).toEqual([])
      expect(diagnosis.targets.flatMap((target) => target.drift)).toEqual([])
    },
  )

  it.each(REAL_SHAPES.map((shape) => [shape.label, shape] as const))(
    '%s CONTROL: a genuinely different command STILL collides',
    async (_label, shape) => {
      const homeDir = await fixture()
      await shape.write(homeDir)
      // No ingest: the registry names the same id running something else, which
      // is the one case that must remain a collision. A comparison that answers
      // "satisfied" for everything is not a comparison.
      const store = new RegistryStore({ homeDir })
      await store.register({ type: 'mcp-server', id: 'ctx', command: 'somebody-else', args: [...shape.args] }, 'global')
      await store.dispose()

      await initMachine({ homeDir })
      const diagnosis = await diagnose({ homeDir })

      expect(diagnosis.findings.map((finding) => finding.kind)).toContain('foreign-collision')
    },
  )
})

describe('D3 in production: the wiring must exclude what panda itself projected', () => {
  it('does not grow the registry when panda ingests what panda just projected', async () => {
    // The behavioural twin of the skills clause above, and the hazard the whole
    // of D3 exists for: panda writes its own servers into the SAME file the
    // user's live in. Unwiring `ownedEntries` at the wiring tier left every
    // report-shape assertion green — this is the one that goes red, because the
    // registry would then grow by the copies panda itself wrote into the other
    // two executors.
    const homeDir = await fixture()
    await withEveryExecutor(homeDir)
    await plantServer(homeDir, 'users-own')

    const first = await ingestMachine({ homeDir })
    // Panda now writes `users-own` into codex and opencode as well.
    await initMachine({ homeDir })
    const second = await ingestMachine({ homeDir })

    expect(first.outcome.registered).toEqual(['mcp-server:users-own'])
    // CONTROL: panda really did project into the other two, so the equality
    // below is an exclusion rather than an init that wrote nothing.
    expect(second.mcpServers.ownedByPanda.map((item) => item.targetId).sort()).toEqual([
      'codex-config',
      'opencode-config',
    ])
    expect(await countEntries(homeDir)).toBe(1)
    expect(second.outcome.registered).toEqual(['mcp-server:users-own'])
    // Offered ONCE, from the file the user wrote it in, rather than three times
    // with panda's own copies competing for the same id.
    expect(second.mcpServers.skipped).toEqual([])
  })
})

describe('a skill panda ingested is already at one of its own destinations', () => {
  it('reports no problem at all after ingest, and still projects into the other roots', async () => {
    // Spec M9.A amendment 3, and it was found by DRIVING THE BINARY while this
    // suite was green: ingest reads the roots the projection writes into, so
    // every ingested skill arrives already sitting at one of its destinations.
    // Panda called that a `foreign-collision`, so the first thing a user saw
    // after using the feature was a broken environment — and the verdict was
    // factually wrong, because the bytes that should be there are there.
    const homeDir = await fixture()
    await withEveryExecutor(homeDir)
    const roots = machineRoots(homeDir)
    const ingested = await plantSkill(roots[0]!, 'alpha')

    await ingestMachine({ homeDir })
    await initMachine({ homeDir })
    const diagnosis = await diagnose({ homeDir })

    expect(diagnosis.findings.filter((finding) => finding.severity === 'problem')).toEqual([])
    // CONTROL, and the half that already worked: the other two roots really are
    // written, so the silence above is "nothing to do" rather than a projection
    // that stopped looking at this entry.
    for (const root of roots.slice(1)) {
      expect(await readFile(join(root, 'alpha', SKILL_ENTRY_FILE), 'utf8')).toBe(
        await readFile(join(ingested, SKILL_ENTRY_FILE), 'utf8'),
      )
    }
    // The ledger keeps telling the truth: panda did not write the source, so it
    // claims nothing there. Adopting it would make `panda remediate release` an
    // authority to delete a skill the user owns.
    const ledger = JSON.parse(
      await readFile(join(homeDir, '.panda', 'projection-ledger.json'), 'utf8'),
    ) as { records: { filePath: string }[] }
    expect(ledger.records.map((record) => record.filePath)).toEqual(roots.slice(1))
  })
})

/** Entries in the machine registry document, or 0 when there is no document. */
async function countEntries(homeDir: string): Promise<number> {
  const store = new RegistryStore({ homeDir })
  try {
    return (await store.list('global')).length
  } finally {
    await store.dispose()
  }
}

describe('the registry document a dry run leaves behind', () => {
  it('is byte-identical to the one that was there before it (E13)', async () => {
    const homeDir = await fixture()
    await plantSkill(machineRoots(homeDir)[0]!, 'previewed')
    const registryPath = (await ingestMachine({ homeDir, dryRun: true })).registryPath
    const before = await readFile(registryPath, 'utf8').catch(() => '<absent>')

    const preview = await ingestMachine({ homeDir, dryRun: true })

    expect(preview.outcome.registered).toEqual(['skill:previewed'])
    expect(await readFile(registryPath, 'utf8').catch(() => '<absent>')).toBe(before)
    expect(before).toBe('<absent>')
  })
})
