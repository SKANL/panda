import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import type { ParseError } from 'jsonc-parser'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  ProjectionClaim,
  ProjectionConfigTarget,
  ProjectionLedgerRecord,
  ProjectionMaterialiseTarget,
  RegistryEntry,
  RemediationOutcome,
} from '@panda/contracts'
import { groupByKind, runProjection } from '../src/engine.ts'
import { ProjectionLedger } from '../src/ledger.ts'
import { runRemediation } from '../src/remediate.ts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { createCodexConfigTarget } from '../src/targets/codex-config.ts'
import { createSkillsTargetFromTraits } from '../src/targets/skills.ts'
import { snapshotRealSkillsRoots } from './real-skills-roots.ts'

// The remediation matrix, against a real filesystem under one `mkdtemp` root.
//
// Every claim in this file is a filesystem claim — "the file is byte-identical
// afterwards", "the ledger gained exactly one record", "the junction was
// refused" — so a spy would prove none of them. The central proof is
// `expectPreviewEqualsAct`: it runs the remediation under INSPECTION, snapshots
// every byte under the sandbox, runs it again under APPLY, snapshots again, and
// asserts that the set of paths that actually changed is exactly the set the
// inspection named. Not a mock of the description; the description, measured
// against the disk.

const SKILL_BODY = '---\nname: alpha\ndescription: The alpha skill.\n---\n\nAlpha body.\n'

const CLAUDE_NATIVE = `{
  "numStartups": 42,
  "mcpServers": {
    "linear": {
      "type": "sse",
      "url": "https://mcp.linear.app/sse"
    }
  }
}
`

let sandbox: string
let realRootsBefore: string

beforeAll(async () => {
  realRootsBefore = await snapshotRealSkillsRoots()
  sandbox = await mkdtemp(join(tmpdir(), 'panda-remediate-'))
})

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  // Not one test here writes outside its injected home, and this is what makes
  // that a measurement rather than an intention.
  expect(await snapshotRealSkillsRoots()).toBe(realRootsBefore)
})

interface Fixture {
  readonly homeDir: string
  readonly claudeJson: string
  readonly codexToml: string
  readonly skillsRoot: string
  readonly sources: string
  readonly ledger: ProjectionLedger
}

let fixtures = 0

async function fixture(): Promise<Fixture> {
  fixtures += 1
  const homeDir = join(sandbox, `home-${fixtures}`)
  const sources = join(homeDir, 'sources')
  await mkdir(sources, { recursive: true })
  return {
    homeDir,
    claudeJson: join(homeDir, '.claude.json'),
    codexToml: join(homeDir, '.codex', 'config.toml'),
    skillsRoot: join(homeDir, 'skills'),
    sources,
    ledger: new ProjectionLedger({ homeDir }),
  }
}

/** Every file under a directory with a hash of its bytes; the identity a survival claim needs. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const walk = async (directory: string): Promise<void> => {
    let listing
    try {
      listing = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of listing) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        found.set(`${path}/`, 'dir')
        await walk(path)
        continue
      }
      const bytes = await readFile(path).catch(() => undefined)
      found.set(path, bytes === undefined ? 'unreadable' : createHash('sha256').update(bytes).digest('hex'))
    }
  }
  await walk(root)
  return found
}

/** The paths whose bytes are not the same in both snapshots, in sorted order. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort()
}

const mcp = (id: string, command = 'ctx-server'): RegistryEntry => ({
  type: 'mcp-server',
  id,
  command,
  args: [],
})

const skill = (id: string, entryPath: string): RegistryEntry => ({ type: 'skill', id, entryPath })

function skillsTarget(rootPath: string, targetId = 'stub-skills'): ProjectionMaterialiseTarget {
  return createSkillsTargetFromTraits({ targetId, defaultRoot: '/unused' }, { rootPath })
}

async function project(
  at: Fixture,
  entries: readonly RegistryEntry[],
  targets: readonly (ProjectionConfigTarget | ProjectionMaterialiseTarget)[],
  mode: 'apply' | 'inspect' = 'apply',
) {
  return await runProjection({ entries: groupByKind(entries), targets, ledger: at.ledger, mode })
}

async function ledgerRecords(at: Fixture): Promise<readonly ProjectionLedgerRecord[]> {
  return (await at.ledger.read()).records
}

/**
 * THE CENTRAL PROOF. Describe, snapshot, act, snapshot — then compare what the
 * filesystem did against what the description said, by path.
 *
 * The two calls are the SAME call with the mode flipped, which is what makes the
 * comparison meaningful: a preview computed by a second code path could agree
 * with the act here and disagree on the next state anyone builds.
 */
async function expectPreviewEqualsAct(
  at: Fixture,
  build: (mode: 'apply' | 'inspect') => Promise<RemediationOutcome>,
): Promise<{ preview: RemediationOutcome; act: RemediationOutcome }> {
  const before = await snapshot(at.homeDir)
  const preview = await build('inspect')
  expect(preview.applied).toBe(false)
  // Inspection is not merely "no vendor write": it is no write at all.
  expect(changedPaths(before, await snapshot(at.homeDir))).toEqual([])
  const act = await build('apply')
  const changed = changedPaths(before, await snapshot(at.homeDir))
  expect(act.refusal).toBeUndefined()
  // The description and the act describe the same change, path for path.
  expect(act.changes).toEqual(preview.changes)
  expect(changed).toEqual([...new Set(preview.changes.map((change) => change.path))].sort())
  return { preview, act }
}

// --- config targets: adopt / release ----------------------------------------

describe('adopt claims what is at panda`s own location, and writes no vendor byte', () => {
  it('takes over a foreign collision, leaves the file byte-identical, and lets init converge it', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const target = createClaudeMcpTarget({ filePath: at.claudeJson })
    // A server the USER wrote at the location panda wants.
    const foreign = JSON.parse(CLAUDE_NATIVE) as { mcpServers: Record<string, unknown> }
    foreign.mcpServers['ctx'] = { type: 'sse', url: 'https://example.invalid/ctx' }
    await writeFile(at.claudeJson, `${JSON.stringify(foreign, null, 2)}\n`, 'utf8')
    const occupied = await readFile(at.claudeJson, 'utf8')

    const first = await project(at, [mcp('ctx')], [target])
    expect(first.results[0]?.drift.map((entry) => entry.kind)).toEqual(['foreign-collision'])
    expect(await readFile(at.claudeJson, 'utf8')).toBe(occupied)

    const { act } = await expectPreviewEqualsAct(at, async (mode) =>
      await runRemediation({
        remediation: 'adopt',
        target,
        entryId: 'ctx',
        entries: groupByKind([mcp('ctx')]),
        ledger: at.ledger,
        mode,
      }),
    )
    // ONLY panda's own ledger changed; the vendor file was not written.
    expect(act.changes.map((change) => change.subject)).toEqual(['ledger'])
    expect(act.changes[0]?.byteDelta).toBe(0)
    expect(await readFile(at.claudeJson, 'utf8')).toBe(occupied)
    expect((await ledgerRecords(at)).map((record) => record.entryId)).toEqual(['ctx'])

    // The state is left: no more collision, and projecting converges it.
    const second = await project(at, [mcp('ctx')], [target])
    expect(second.results[0]?.drift).toEqual([])
    expect(second.results[0]?.written).toBe(true)
    const document = JSON.parse(await readFile(at.claudeJson, 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(document.mcpServers['ctx']).toEqual({ type: 'stdio', command: 'ctx-server', args: [] })
    // The user's own neighbour survived the whole sequence untouched.
    expect(document.mcpServers['linear']).toEqual({ type: 'sse', url: 'https://mcp.linear.app/sse' })
  })

  it('re-claims an entry the user edited, so the next projection takes panda`s version back', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const target = createClaudeMcpTarget({ filePath: at.claudeJson })
    await project(at, [mcp('ctx')], [target])
    const edited = (await readFile(at.claudeJson, 'utf8')).replace('"ctx-server"', '"mine"')
    await writeFile(at.claudeJson, edited, 'utf8')
    expect((await project(at, [mcp('ctx')], [target])).results[0]?.drift.map((entry) => entry.kind)).toEqual([
      'edited',
    ])

    await expectPreviewEqualsAct(at, async (mode) =>
      await runRemediation({
        remediation: 'adopt',
        target,
        entryId: 'ctx',
        entries: groupByKind([mcp('ctx')]),
        ledger: at.ledger,
        mode,
      }),
    )
    const after = await project(at, [mcp('ctx')], [target])
    expect(after.results[0]?.drift).toEqual([])
    expect(await readFile(at.claudeJson, 'utf8')).toContain('"ctx-server"')
  })

  it('refuses a location that is free, because there is nothing there to claim', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const outcome = await runRemediation({
      remediation: 'adopt',
      target: createClaudeMcpTarget({ filePath: at.claudeJson }),
      entryId: 'ctx',
      entries: groupByKind([mcp('ctx')]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.code).toBe('PANDA_PROJECTION_REMEDIATION_REFUSED')
    expect(outcome.refusal?.message).toContain('nothing for panda to claim')
    expect(await ledgerRecords(at)).toEqual([])
  })

  it('refuses when the vendor document spells the location twice', async () => {
    const at = await fixture()
    await writeFile(at.codexToml, '', 'utf8').catch(() => undefined)
    await mkdir(join(at.homeDir, '.codex'), { recursive: true })
    await writeFile(
      at.codexToml,
      '[mcp_servers.ctx]\ncommand = "a"\n\n[mcp_servers.ctx]\ncommand = "b"\n',
      'utf8',
    )
    const outcome = await runRemediation({
      remediation: 'adopt',
      target: createCodexConfigTarget({ filePath: at.codexToml }),
      entryId: 'ctx',
      entries: groupByKind([mcp('ctx')]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('defined 2 times')
    expect(await ledgerRecords(at)).toEqual([])
  })
})

describe('release drops the claim and never looks at the file', () => {
  it('leaves an edited entry exactly as the user left it, forever', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const target = createClaudeMcpTarget({ filePath: at.claudeJson })
    await project(at, [mcp('ctx')], [target])
    const edited = (await readFile(at.claudeJson, 'utf8')).replace('"ctx-server"', '"mine"')
    await writeFile(at.claudeJson, edited, 'utf8')

    const { act } = await expectPreviewEqualsAct(at, async (mode) =>
      await runRemediation({ remediation: 'release', target, entryId: 'ctx', ledger: at.ledger, mode }),
    )
    expect(act.changes.map((change) => change.action)).toEqual(['unclaim'])
    expect(await readFile(at.claudeJson, 'utf8')).toBe(edited)
    expect(await ledgerRecords(at)).toEqual([])
    // The entry is foreign now, so panda reports it and still does not touch it.
    const after = await project(at, [mcp('ctx')], [target])
    expect(after.results[0]?.drift.map((entry) => entry.kind)).toEqual(['foreign-collision'])
    expect(await readFile(at.claudeJson, 'utf8')).toBe(edited)
  })

  it('makes a removed-by-user location free again, so the next projection writes it back', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const target = createClaudeMcpTarget({ filePath: at.claudeJson })
    await project(at, [mcp('ctx')], [target])
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    expect((await project(at, [mcp('ctx')], [target])).results[0]?.drift.map((entry) => entry.kind)).toEqual([
      'removed-by-user',
    ])

    await expectPreviewEqualsAct(at, async (mode) =>
      await runRemediation({ remediation: 'release', target, entryId: 'ctx', ledger: at.ledger, mode }),
    )
    const after = await project(at, [mcp('ctx')], [target])
    expect(after.results[0]?.drift).toEqual([])
    expect(await readFile(at.claudeJson, 'utf8')).toContain('"ctx-server"')
  })

  it('refuses when panda holds no claim to drop', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const outcome = await runRemediation({
      remediation: 'release',
      target: createClaudeMcpTarget({ filePath: at.claudeJson }),
      entryId: 'ctx',
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('nothing to release')
  })

  it('drops only the named claim and keeps every other one, in this target and in others', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    await mkdir(join(at.homeDir, '.codex'), { recursive: true })
    await writeFile(at.codexToml, 'model = "x"\n', 'utf8')
    const claude = createClaudeMcpTarget({ filePath: at.claudeJson })
    const codex = createCodexConfigTarget({ filePath: at.codexToml })
    await project(at, [mcp('ctx'), mcp('other')], [claude, codex])
    expect((await ledgerRecords(at)).length).toBe(4)

    await runRemediation({ remediation: 'release', target: claude, entryId: 'ctx', ledger: at.ledger, mode: 'apply' })
    expect(
      (await ledgerRecords(at)).map((record) => `${record.targetId}:${record.entryId}`).sort(),
    ).toEqual(['claude-mcp:other', 'codex-config:ctx', 'codex-config:other'])
  })
})

describe('an unreadable ledger refuses every claim change and is left exactly as it is', () => {
  it.each(['adopt', 'release'] as const)('refuses %s and does not rewrite the ledger', async (remediation) => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const target = createClaudeMcpTarget({ filePath: at.claudeJson })
    await project(at, [mcp('ctx')], [target])
    await writeFile(at.ledger.filePath, '{ broken', 'utf8')

    const outcome = await runRemediation(
      remediation === 'adopt'
        ? {
            remediation,
            target,
            entryId: 'ctx',
            entries: groupByKind([mcp('ctx')]),
            ledger: at.ledger,
            mode: 'apply',
          }
        : { remediation, target, entryId: 'ctx', ledger: at.ledger, mode: 'apply' },
    )
    expect(outcome.refusal?.code).toBe('PANDA_PROJECTION_LEDGER_UNAVAILABLE')
    expect(await readFile(at.ledger.filePath, 'utf8')).toBe('{ broken')
  })
})

// --- containment ------------------------------------------------------------
//
// M4.B's rule, unchanged, on the one path that CREATES a delete authority. Every
// attack below is one its own review found on the removal path; each is aimed at
// `adopt`, because the record it writes is what a later run takes to `rm`.

/** A hand-rolled config target whose claim names whatever the attack needs. */
function forgedConfigTarget(filePath: string, record: ProjectionLedgerRecord): ProjectionConfigTarget {
  return {
    targetId: 'forged',
    filePath,
    merge: () => ({ text: '', drift: [], records: [], ownedSpans: [] }),
    claim: (): ProjectionClaim => ({ location: record.nativeLocation, byteLength: 1, record }),
  }
}

describe('containment: a claim panda cannot prove it owns is refused', () => {
  it('refuses a claim whose owned path is an ABSOLUTE path outside the root', async () => {
    const at = await fixture()
    const outside = join(at.homeDir, 'id_rsa')
    await writeFile(outside, 'secret', 'utf8')
    const outcome = await runRemediation({
      remediation: 'adopt',
      target: forgedConfigTarget(at.skillsRoot, {
        targetId: 'forged',
        filePath: at.skillsRoot,
        nativeLocation: 'alpha',
        entryId: 'alpha',
        contentHash: 'x',
        ownedPaths: [{ path: outside, contentHash: 'x' }],
      }),
      entryId: 'alpha',
      entries: groupByKind([]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('outside')
    expect(await ledgerRecords(at)).toEqual([])
    expect(await readFile(outside, 'utf8')).toBe('secret')
  })

  it('refuses a claim whose owned path is RELATIVE, which would resolve against the cwd', async () => {
    const at = await fixture()
    const outcome = await runRemediation({
      remediation: 'adopt',
      target: forgedConfigTarget(at.skillsRoot, {
        targetId: 'forged',
        filePath: at.skillsRoot,
        nativeLocation: 'alpha',
        entryId: 'alpha',
        contentHash: 'x',
        ownedPaths: [{ path: 'package.json', contentHash: 'x' }],
      }),
      entryId: 'alpha',
      entries: groupByKind([]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('outside')
    expect(await ledgerRecords(at)).toEqual([])
  })

  it('refuses a claim that names a different file from the one the target owns', async () => {
    const at = await fixture()
    const outcome = await runRemediation({
      remediation: 'adopt',
      target: forgedConfigTarget(at.claudeJson, {
        targetId: 'forged',
        filePath: join(at.homeDir, 'elsewhere.json'),
        nativeLocation: 'mcpServers.ctx',
        entryId: 'ctx',
        contentHash: 'x',
      }),
      entryId: 'ctx',
      entries: groupByKind([]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('outside')
    expect(await ledgerRecords(at)).toEqual([])
  })

  it('refuses a target that cannot say what occupies its location at all', async () => {
    const at = await fixture()
    const outcome = await runRemediation({
      remediation: 'adopt',
      target: { targetId: 'mute', filePath: at.claudeJson, merge: () => ({ text: '', drift: [], records: [], ownedSpans: [] }) },
      entryId: 'ctx',
      entries: groupByKind([]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('cannot say what occupies')
  })
})

// --- materialisation: the crash state ---------------------------------------

async function writeSkillSource(at: Fixture, id: string, body = SKILL_BODY): Promise<string> {
  const path = join(at.sources, `${id}.md`)
  await writeFile(path, body, 'utf8')
  return path
}

/** Panda's own tree on disk with no ledger record — the M4.B crash window. */
async function crashState(at: Fixture, id = 'alpha'): Promise<{ target: ProjectionMaterialiseTarget; entry: RegistryEntry }> {
  const source = await writeSkillSource(at, id)
  const entry = skill(id, source)
  const target = skillsTarget(at.skillsRoot)
  await project(at, [entry], [target])
  // Exactly what a crash between `land()` and `store.update()` leaves behind.
  await rm(at.ledger.filePath, { force: true })
  return { target, entry }
}

describe('the crash state: panda`s own tree with no record', () => {
  it('is a foreign collision panda refuses, and adopt is the way out', async () => {
    const at = await fixture()
    const { target, entry } = await crashState(at)
    const before = await project(at, [entry], [target])
    expect(before.results[0]?.drift.map((drift) => drift.kind)).toEqual(['foreign-collision'])

    const { act } = await expectPreviewEqualsAct(at, async (mode) =>
      await runRemediation({
        remediation: 'adopt',
        target,
        entryId: 'alpha',
        entries: groupByKind([entry]),
        ledger: at.ledger,
        mode,
      }),
    )
    expect(act.changes.map((change) => change.subject)).toEqual(['ledger'])
    const after = await project(at, [entry], [target])
    expect(after.results[0]?.drift).toEqual([])
    // Idempotent immediately: adoption claimed the bytes that were already right.
    expect(after.results[0]?.written).toBe(false)
    // And the tree is panda's again — dropping the skill now removes it.
    const dropped = await project(at, [], [target])
    expect(dropped.results[0]?.written).toBe(true)
    await expect(stat(join(at.skillsRoot, 'alpha'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never claims a file the user put beside panda`s, so removal cannot reach it', async () => {
    const at = await fixture()
    const { target, entry } = await crashState(at)
    const mine = join(at.skillsRoot, 'alpha', 'NOTES.md')
    await writeFile(mine, 'my notes\n', 'utf8')

    const outcome = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([entry]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal).toBeUndefined()
    const record = (await ledgerRecords(at))[0]
    expect((record?.ownedPaths ?? []).map((owned) => owned.path)).toEqual([
      join(at.skillsRoot, 'alpha', 'SKILL.md'),
    ])
    // Dropping the skill removes what panda claimed and stops at the neighbour.
    await project(at, [], [target])
    expect(await readFile(mine, 'utf8')).toBe('my notes\n')
  })

  it('refuses only when NOTHING of the entry is on disk', async () => {
    const at = await fixture()
    const { target, entry } = await crashState(at)
    await rm(join(at.skillsRoot, 'alpha'), { recursive: true, force: true })
    const outcome = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([entry]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('nothing to claim')
    expect(await ledgerRecords(at)).toEqual([])
  })

  it('refuses to claim an entry panda would not materialise', async () => {
    const at = await fixture()
    const target = skillsTarget(at.skillsRoot)
    const outcome = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'ghost',
      entries: groupByKind([]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('nothing there for panda to claim')
  })
})

/**
 * A directory link, or `false` where the platform refuses one. The junction form
 * is tried first because it is the shape that matters: `rmdir` removes one
 * without consulting its target.
 */
async function linkDirectory(target: string, link: string): Promise<boolean> {
  for (const type of ['junction', 'dir'] as const) {
    try {
      await symlink(target, link, type)
      return true
    } catch {
      continue
    }
  }
  return false
}

describe('containment on a materialised tree', () => {
  it('refuses to claim a tree reached through a junction, whatever the bytes behind it hash to', async () => {
    const at = await fixture()
    const source = await writeSkillSource(at, 'alpha')
    const entry = skill('alpha', source)
    const target = skillsTarget(at.skillsRoot)
    // The realistic sequence: panda materialises, the user moves the tree into
    // their own repository and leaves a link behind.
    const elsewhere = join(at.homeDir, 'dotfiles', 'alpha')
    await mkdir(elsewhere, { recursive: true })
    await writeFile(join(elsewhere, 'SKILL.md'), SKILL_BODY, 'utf8')
    await mkdir(at.skillsRoot, { recursive: true })
    if (!(await linkDirectory(elsewhere, join(at.skillsRoot, 'alpha')))) return

    const outcome = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([entry]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('reached through a link')
    expect(await ledgerRecords(at)).toEqual([])
    expect(await readFile(join(elsewhere, 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
  })

  it('refuses to claim a path another registry entry already claims', async () => {
    const at = await fixture()
    const source = await writeSkillSource(at, 'alpha')
    const target = skillsTarget(at.skillsRoot)
    await project(at, [skill('alpha', source)], [target])
    // A second id that lands on the SAME path: `Alpha` and `alpha` are one
    // directory on Windows, and this is the general two-records-one-path hole.
    const forged = (await ledgerRecords(at))[0]!
    await at.ledger.update(
      { targetId: target.targetId, filePath: at.skillsRoot },
      [forged, { ...forged, entryId: 'beta' }],
    )
    const outcome = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([skill('alpha', source)]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('already claimed by another registry entry')
  })

  it('refuses a materialisation target that plans outside its own root', async () => {
    const at = await fixture()
    const escaping: ProjectionMaterialiseTarget = {
      kind: 'materialise',
      targetId: 'escaping',
      rootPath: at.skillsRoot,
      plan: () => ({
        entries: [
          {
            entryId: 'alpha',
            location: 'alpha',
            files: [{ relativePath: '../../escaped.md', sourcePath: join(at.sources, 'alpha.md') }],
          },
        ],
        presentEntryIds: ['alpha'],
      }),
    }
    const outcome = await runRemediation({
      remediation: 'adopt',
      target: escaping,
      entryId: 'alpha',
      entries: groupByKind([]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('outside its own root')
    expect(await ledgerRecords(at)).toEqual([])
  })
})

// --- repair: panda's own ledger ---------------------------------------------

describe('repair is the exit from a ledger panda carries and cannot read', () => {
  it('keeps every record it can read and drops the ones it cannot', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const target = createClaudeMcpTarget({ filePath: at.claudeJson })
    await project(at, [mcp('ctx')], [target])
    const document = JSON.parse(await readFile(at.ledger.filePath, 'utf8')) as {
      version: number
      records: unknown[]
    }
    document.records.push({ targetId: 'x', filePath: 42 })
    await writeFile(at.ledger.filePath, JSON.stringify(document, null, 2), 'utf8')
    expect((await at.ledger.read()).warnings).toHaveLength(1)

    const { act } = await expectPreviewEqualsAct(at, async (mode) =>
      await runRemediation({ remediation: 'repair', ledger: at.ledger, mode }),
    )
    expect(act.changes.map((change) => change.action)).toEqual(['rewrite'])
    const read = await at.ledger.read()
    expect(read.warnings).toEqual([])
    expect(read.records.map((record) => record.entryId)).toEqual(['ctx'])
    // The vendor file was never opened.
    expect(await readFile(at.claudeJson, 'utf8')).toContain('"ctx-server"')
  })

  it('replaces a wholly unreadable ledger and says what that costs before doing it', async () => {
    const at = await fixture()
    await mkdir(join(at.homeDir, '.panda'), { recursive: true })
    await writeFile(at.ledger.filePath, 'not json at all', 'utf8')

    const preview = await runRemediation({ remediation: 'repair', ledger: at.ledger, mode: 'inspect' })
    expect(preview.changes[0]?.detail).toContain('REPLACE it with an empty ledger')
    expect(preview.changes[0]?.detail).toContain('foreign collision')
    expect(await readFile(at.ledger.filePath, 'utf8')).toBe('not json at all')

    const act = await runRemediation({ remediation: 'repair', ledger: at.ledger, mode: 'apply' })
    expect(act.applied).toBe(true)
    const read = await at.ledger.read()
    expect(read.state).toBe('readable')
    expect(read.records).toEqual([])
  })

  it('changes nothing when the ledger is clean, and nothing when there is none', async () => {
    const at = await fixture()
    expect((await runRemediation({ remediation: 'repair', ledger: at.ledger, mode: 'apply' })).changes).toEqual([])
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    await project(at, [mcp('ctx')], [createClaudeMcpTarget({ filePath: at.claudeJson })])
    const before = await readFile(at.ledger.filePath, 'utf8')
    expect((await runRemediation({ remediation: 'repair', ledger: at.ledger, mode: 'apply' })).changes).toEqual([])
    expect(await readFile(at.ledger.filePath, 'utf8')).toBe(before)
  })
})

// --- discard: correction-01 C6 ----------------------------------------------

const LEGACY_JSON = `{
  "theme": "vercel",
  "panda": {
    "version": 1,
    "mcpServers": {
      "ctx": {
        "command": "ctx-server"
      }
    }
  },
  "mcp": {
    "linear": {
      "type": "remote"
    }
  }
}
`

const LEGACY_TOML = `# User's codex configuration
model = "gpt-5-codex"

[mcp_servers.linear]
url = "https://mcp.linear.app/sse"

# BEGIN panda-managed v1
version = 1

[tools.ripgrep]
command = "rg"
# END panda-managed v1
`

describe('discard removes panda`s own prior output and nothing else (correction-01 C6)', () => {
  /**
   * THE ONE STATE `discard` LEAVES THROUGH A DIFFERENT DOOR THAN EVERY OTHER.
   *
   * `remediate.ts` states its own contract: "A refusal is RETURNED, coded, not
   * thrown". Three of the four remediations touch no user file; `discard` is the
   * one that writes, and its write was a bare `atomicWriteText`.
   *
   * Driven before this clause existed, against a 0o444 target: the run did not
   * escape UNCODED, which would have been the ordinary kind of hole. It escaped
   * FALSELY CODED. `describe()` duck-types `.code`, and a Node `ErrnoException`
   * has one, so a libuv errno rendered in panda's coded-error position and the
   * user read `EPERM: EPERM: operation not permitted, rename '<file>.<uuid>.tmp'
   * -> ...`. Doubled, and leaking the temporary path panda writes through.
   *
   * It also exited 2 where every other refusal in this function exits 1 — so the
   * read-only target was the single state in the remediation surface that left
   * by the usage/environment door instead of the refusal door.
   *
   * Both halves are caught: `atomicWriteText` can ALSO throw a coded
   * `PANDA_PROJECTION_NATIVE_UNCLAIMABLE` from its own containment check, and a
   * fix that only caught errnos would leave that one still escaping as a throw
   * out of a function whose contract says refusals are values.
   */
  it('REFUSES a target it cannot replace, as a value, without quoting its temp path', async () => {
    const at = await fixture()
    const path = join(at.homeDir, 'opencode.json')
    await writeFile(path, LEGACY_JSON, 'utf8')
    // THE PRECONDITION IS PLATFORM-SPECIFIC AND BOTH HALVES ARE NEEDED, which
    // cost this clause a red CI run to learn. `atomicWriteText` writes a temp
    // file and RENAMES over the target. On Windows the read-only ATTRIBUTE on
    // the file blocks that rename. On POSIX it does not: `rename(2)` is
    // permitted by write access to the containing DIRECTORY, and the target
    // file's own mode is irrelevant — so `chmod 0o444` alone let the discard
    // apply and the clause asserted a refusal that never happened.
    //
    // The ledger's existing lesson is that `0o600` is a no-op on Windows, so use
    // `0o444`. It takes on both platforms for WRITE. It does not for RENAME.
    // Both are set, and each is what actually bites on one platform.
    const before = await readFile(path, 'utf8')
    await chmod(path, 0o444)
    await chmod(at.homeDir, 0o555)
    try {
      // THE PRECONDITION, PROVED BEFORE THE SUBJECT RUNS. Without this, an
      // environment where the permissions do not bite (a root CI container, an
      // exotic filesystem) reports `expected undefined` and reads as though the
      // production code regressed. Verified in real Linux as uid 1000: file
      // 0444 alone leaves the rename PERMITTED, and it is the directory that
      // blocks it.
      await expect(writeFile(path, 'precondition probe', 'utf8')).rejects.toThrow()

      const outcome = await runRemediation({
        remediation: 'discard',
        legacy: { targetId: 'opencode-config', filePath: path, fileFormat: 'jsonc', rootPath: at.homeDir },
        mode: 'apply',
      })
      expect(outcome.refusal?.code).toBe('PANDA_PROJECTION_REMEDIATION_REFUSED')
      expect(outcome.applied).toBe(false)
      // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED: the file is byte-identical.
      // A refusal that arrived after a partial write would satisfy every clause
      // above and would be the worse defect.
      expect(await readFile(path, 'utf8')).toBe(before)
      // The temporary path is panda's own business and names a uuid the user
      // cannot act on; the refusal says what happened and what it means.
      expect(outcome.refusal?.message).not.toContain('.tmp')
      // CONTROL: the same fixture with both permissions restored APPLIES, so a
      // run that refused for an unrelated reason cannot satisfy the clause above.
      await chmod(at.homeDir, 0o755)
      await chmod(path, 0o666)
      const ok = await runRemediation({
        remediation: 'discard',
        legacy: { targetId: 'opencode-config', filePath: path, fileFormat: 'jsonc', rootPath: at.homeDir },
        mode: 'apply',
      })
      expect(ok.applied).toBe(true)
      expect(ok.refusal).toBeUndefined()
    } finally {
      await chmod(at.homeDir, 0o755).catch(() => {})
      await chmod(path, 0o666).catch(() => {})
    }
  })

  it('takes the reserved $.panda key out of a JSON config and leaves every other byte', async () => {
    const at = await fixture()
    const path = join(at.homeDir, 'opencode.json')
    await writeFile(path, LEGACY_JSON, 'utf8')

    const { act } = await expectPreviewEqualsAct(at, async (mode) =>
      await runRemediation({
        remediation: 'discard',
        legacy: { targetId: 'opencode-config', filePath: path, fileFormat: 'jsonc', rootPath: at.homeDir },
        mode,
      }),
    )
    expect(act.changes.map((change) => change.subject)).toEqual(['native-file'])
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('panda')
    // Still valid JSON, and every foreign key survives with its own formatting.
    expect(JSON.parse(text)).toEqual({ theme: 'vercel', mcp: { linear: { type: 'remote' } } })
    expect(text).toContain('  "theme": "vercel",\n')
    expect(text).toContain('      "type": "remote"\n')
  })

  it('takes the panda-managed block out of a TOML config and leaves the foreign tail identical', async () => {
    const at = await fixture()
    await mkdir(join(at.homeDir, '.codex'), { recursive: true })
    await writeFile(at.codexToml, LEGACY_TOML, 'utf8')

    await expectPreviewEqualsAct(at, async (mode) =>
      await runRemediation({
        remediation: 'discard',
        legacy: { targetId: 'codex-config', filePath: at.codexToml, fileFormat: 'toml', rootPath: at.homeDir },
        mode,
      }),
    )
    expect(await readFile(at.codexToml, 'utf8')).toBe(
      `# User's codex configuration\nmodel = "gpt-5-codex"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/sse"\n`,
    )
  })

  it('changes nothing when there is no block, and nothing when there is no file', async () => {
    const at = await fixture()
    const path = join(at.homeDir, 'clean.json')
    await writeFile(path, '{\n  "theme": "vercel"\n}\n', 'utf8')
    for (const filePath of [path, join(at.homeDir, 'absent.json')]) {
      const outcome = await runRemediation({
        remediation: 'discard',
        legacy: { targetId: 't', filePath, fileFormat: 'jsonc', rootPath: at.homeDir },
        mode: 'apply',
      })
      expect(outcome.changes).toEqual([])
      expect(outcome.refusal).toBeUndefined()
    }
    expect(await readFile(path, 'utf8')).toBe('{\n  "theme": "vercel"\n}\n')
  })

  it('refuses a file outside the scope it was given, and does not open it', async () => {
    const at = await fixture()
    const outside = join(sandbox, `escape-${fixtures}.json`)
    await writeFile(outside, LEGACY_JSON, 'utf8')
    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: outside, fileFormat: 'jsonc', rootPath: at.homeDir },
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('outside')
    expect(await readFile(outside, 'utf8')).toBe(LEGACY_JSON)
  })

  it('refuses markers it cannot bound, and refuses a key it cannot attribute', async () => {
    const at = await fixture()
    const unbalanced = join(at.homeDir, 'unbalanced.toml')
    await writeFile(unbalanced, 'model = "x"\n\n# BEGIN panda-managed v1\nversion = 1\n', 'utf8')
    const first = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: unbalanced, fileFormat: 'toml', rootPath: at.homeDir },
      mode: 'apply',
    })
    expect(first.refusal?.message).toContain('no matching')
    expect(await readFile(unbalanced, 'utf8')).toContain('# BEGIN panda-managed v1')

    const twice = join(at.homeDir, 'twice.json')
    const doubled = '{ "panda": { "version": 1 }, "panda": { "tools": {} } }'
    await writeFile(twice, doubled, 'utf8')
    const second = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: twice, fileFormat: 'jsonc', rootPath: at.homeDir },
      mode: 'apply',
    })
    expect(second.refusal?.message).toContain('declared 2 times')
    expect(second.refusal?.message).toContain('by hand')
    expect(await readFile(twice, 'utf8')).toBe(doubled)
  })

  it('will not leave a JSON config unparseable, whatever the region says', async () => {
    // The guard behind `jsonRemovalSpan`'s separator handling: a removal that
    // left `{"a":1,}` would be a worse state than the litter it took out.
    const at = await fixture()
    const path = join(at.homeDir, 'sole.json')
    await writeFile(path, '{\n  "panda": { "version": 1 }\n}\n', 'utf8')
    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: path, fileFormat: 'jsonc', rootPath: at.homeDir },
      mode: 'apply',
    })
    expect(outcome.refusal).toBeUndefined()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({})
  })
})

describe('the mode switch fails closed, exactly as the projection engine does', () => {
  it.each(['Inspect', 'inspect ', 'dry-run', null, 0])('rejects %o rather than writing', async (mode) => {
    const at = await fixture()
    await expect(
      runRemediation({
        remediation: 'repair',
        ledger: at.ledger,
        mode: mode as unknown as 'apply',
      }),
    ).rejects.toMatchObject({ code: 'PANDA_PROJECTION_MODE_INVALID' })
  })

  it('rejects a remediation it does not have', async () => {
    const at = await fixture()
    await expect(
      runRemediation({ remediation: 'purge', ledger: at.ledger, mode: 'inspect' } as unknown as {
        remediation: 'repair'
        ledger: ProjectionLedger
      }),
    ).rejects.toMatchObject({ code: 'PANDA_PROJECTION_REMEDIATION_REFUSED' })
  })
})

// --- HIGH-1: a partially materialised tree has an exit -----------------------
//
// Three routes reach a tree that is only PARTLY there, and the first shipped
// shape refused to claim any of them — which left `rm -rf` as the only escape,
// rebuilt out of the new vocabulary. Each route is walked end to end here.

describe('a tree that is only partly there is left, not trapped', () => {
  it('is claimed as the subset that exists, and the next run writes the rest back', async () => {
    const at = await fixture()
    // A skill whose source is a DIRECTORY, so the tree has more than one file
    // and "partly there" is expressible at all.
    const source = join(at.sources, 'alpha')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), SKILL_BODY, 'utf8')
    await writeFile(join(source, 'REFERENCE.md'), 'reference\n', 'utf8')
    const entry = skill('alpha', source)
    const target = skillsTarget(at.skillsRoot)
    await project(at, [entry], [target])
    // The user deletes ONE file out of the folder.
    await rm(join(at.skillsRoot, 'alpha', 'REFERENCE.md'), { force: true })
    const drifted = await project(at, [entry], [target])
    expect(drifted.results[0]?.drift.map((item) => item.kind)).toEqual(['edited'])

    const outcome = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([entry]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(outcome.refusal).toBeUndefined()
    expect((await ledgerRecords(at))[0]?.ownedPaths?.map((owned) => owned.path)).toEqual([
      join(at.skillsRoot, 'alpha', 'SKILL.md'),
    ])
    // The state is LEFT: no drift, and the missing file is put back.
    const after = await project(at, [entry], [target])
    expect(after.results[0]?.drift).toEqual([])
    expect(await readFile(join(at.skillsRoot, 'alpha', 'REFERENCE.md'), 'utf8')).toBe('reference\n')
  })

  it('survives `release` on an edited tree, which used to move the user from one refusal to two', async () => {
    const at = await fixture()
    const source = await writeSkillSource(at, 'alpha')
    const entry = skill('alpha', source)
    const target = skillsTarget(at.skillsRoot)
    await project(at, [entry], [target])
    await writeFile(join(at.skillsRoot, 'alpha', 'SKILL.md'), `${SKILL_BODY}mine\n`, 'utf8')
    expect((await project(at, [entry], [target])).results[0]?.drift.map((item) => item.kind)).toEqual([
      'edited',
    ])
    // The named exit for `edited`, taken.
    await runRemediation({ remediation: 'release', target, entryId: 'alpha', ledger: at.ledger, mode: 'apply' })
    expect((await project(at, [entry], [target])).results[0]?.drift.map((item) => item.kind)).toEqual([
      'foreign-collision',
    ])
    // ...and the state it moved to is itself leavable.
    const adopted = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([entry]),
      ledger: at.ledger,
      mode: 'apply',
    })
    expect(adopted.refusal).toBeUndefined()
    const after = await project(at, [entry], [target])
    expect(after.results[0]?.drift).toEqual([])
  })

  it('claims panda`s own tree back from the LEDGER when the entry has left the registry', async () => {
    const at = await fixture()
    const source = await writeSkillSource(at, 'alpha')
    const target = skillsTarget(at.skillsRoot)
    await project(at, [skill('alpha', source)], [target])
    // Edited, and no longer registered: reported as `edited` on the removal path,
    // whose only other exit is `release` — which leaves the tree on disk forever.
    await writeFile(join(at.skillsRoot, 'alpha', 'SKILL.md'), 'mine\n', 'utf8')
    const orphaned = await project(at, [], [target])
    expect(orphaned.results[0]?.drift.map((item) => item.kind)).toEqual(['edited'])

    const outcome = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([]),
      ledger: at.ledger,
      mode: 'inspect',
    })
    expect(outcome.refusal).toBeUndefined()
    // And the description says the sharpest thing it can: the next run REMOVES it.
    expect(outcome.changes[0]?.detail).toContain('REMOVES')
    await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([]),
      ledger: at.ledger,
      mode: 'apply',
    })
    const removed = await project(at, [], [target])
    expect(removed.results[0]?.drift).toEqual([])
    await expect(stat(join(at.skillsRoot, 'alpha'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// --- HIGH-2: the description carries the consequence, both branches ----------

describe('adopt says what OWNING the location will let a later run do', () => {
  it('names every path that becomes deletable, on the branch where the file is the user`s', async () => {
    const at = await fixture()
    const source = await writeSkillSource(at, 'alpha')
    const target = skillsTarget(at.skillsRoot)
    // A skill folder the USER made by hand, exactly where panda plans to write.
    const mine = join(at.skillsRoot, 'alpha', 'SKILL.md')
    await mkdir(join(at.skillsRoot, 'alpha'), { recursive: true })
    await writeFile(mine, 'my own skill\n', 'utf8')
    const entry = skill('alpha', source)
    expect((await project(at, [entry], [target])).results[0]?.drift.map((item) => item.kind)).toEqual([
      'foreign-collision',
    ])

    const preview = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([entry]),
      ledger: at.ledger,
      mode: 'inspect',
    })
    const detail = preview.changes[0]?.detail ?? ''
    // The three facts the frozen Always clause asks for, on the branch where the
    // stakes are highest: which paths, what panda gains, and the way out.
    expect(detail).toContain(mine)
    expect(detail).toContain('REMOVE')
    expect(detail).toContain("'release'")
  })

  it('says a CONFIG claim gains no authority to delete a file, because it cannot', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE.replace('"linear"', '"ctx"'), 'utf8')
    const preview = await runRemediation({
      remediation: 'adopt',
      target: createClaudeMcpTarget({ filePath: at.claudeJson }),
      entryId: 'ctx',
      entries: groupByKind([mcp('ctx')]),
      ledger: at.ledger,
      mode: 'inspect',
    })
    expect(preview.changes[0]?.detail).toContain('no authority to delete any FILE')
    expect(preview.changes[0]?.detail).toContain('REPLACES')
  })
})

// --- HIGH-3: the JSON key needs EVIDENCE ------------------------------------

describe('discard claims a `panda` key only when its members are panda`s own vocabulary', () => {
  it('leaves a user`s own `panda` key alone, and reports nothing about it', async () => {
    const at = await fixture()
    const path = join(at.homeDir, 'mine.json')
    const mine = '{\n  "panda": {\n    "favouriteColour": "black",\n    "notes": "my own settings"\n  }\n}\n'
    await writeFile(path, mine, 'utf8')
    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: path, fileFormat: 'jsonc', rootPath: at.homeDir },
      mode: 'apply',
    })
    // Not a refusal either: a refusal is still a REPORT, and panda has nothing
    // to report about a key it has no reason to think it wrote.
    expect(outcome.changes).toEqual([])
    expect(outcome.refusal).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(mine)
  })

  it('takes a key whose every member is vocabulary a panda build wrote', async () => {
    const at = await fixture()
    const path = join(at.homeDir, 'legacy.json')
    await writeFile(
      path,
      '{\n  "model": "sonnet",\n  "panda": {\n    "version": 1,\n    "hooks": {},\n    "skills": {}\n  }\n}\n',
      'utf8',
    )
    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: path, fileFormat: 'jsonc', rootPath: at.homeDir },
      mode: 'apply',
    })
    expect(outcome.applied).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ model: 'sonnet' })
  })

  it('leaves a key that MIXES panda vocabulary with the user`s own', async () => {
    const at = await fixture()
    const path = join(at.homeDir, 'mixed.json')
    const mixed = '{\n  "panda": {\n    "version": 1,\n    "myOwnKey": true\n  }\n}\n'
    await writeFile(path, mixed, 'utf8')
    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: path, fileFormat: 'jsonc', rootPath: at.homeDir },
      mode: 'apply',
    })
    expect(outcome.changes).toEqual([])
    expect(await readFile(path, 'utf8')).toBe(mixed)
  })
})

// --- HIGH-4: a marker inside a multi-line string is the user`s bytes ---------

describe('discard does not match its own marker inside a TOML string', () => {
  it('leaves a multi-line value that happens to contain the marker byte-identical', async () => {
    const at = await fixture()
    const path = join(at.homeDir, 'strings.toml')
    const fence = '"'.repeat(3)
    const body = [
      'model = "gpt-5-codex"',
      '',
      `notes = ${fence}`,
      'things I still have to clean up:',
      '# BEGIN panda-managed v1',
      '# END panda-managed v1',
      fence,
      '',
    ].join('\n')
    await writeFile(path, body, 'utf8')
    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: path, fileFormat: 'toml', rootPath: at.homeDir },
      mode: 'apply',
    })
    expect(outcome.changes).toEqual([])
    expect(outcome.refusal).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(body)
  })

  it('still takes a real block in the same file, outside the string', async () => {
    const at = await fixture()
    const path = join(at.homeDir, 'both.toml')
    const fence = '"'.repeat(3)
    const head = ['model = "gpt-5-codex"', '', `notes = ${fence}`, '# BEGIN panda-managed v1', fence, ''].join('\n')
    await writeFile(path, `${head}\n# BEGIN panda-managed v1\nversion = 1\n# END panda-managed v1\n`, 'utf8')
    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: path, fileFormat: 'toml', rootPath: at.homeDir },
      mode: 'apply',
    })
    expect(outcome.applied).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(head)
  })
})

// --- HIGH-5: the race is real and is refused --------------------------------
//
// In `test/remediate-race.test.ts`, which is a separate file because it wraps
// `node:fs/promises` to FORCE the competing write into the protected window
// instead of betting on the scheduler. The version that lived here looped up to
// 25 times hoping to win a one-microtask race; it won on Windows/Node 24 and
// stopped winning on Linux/Node 26, which is what a test that must win a race
// always eventually does.

// --- M1: containment against the REAL path ----------------------------------

describe('discard containment survives a link in the way', () => {
  it('refuses a file whose real path is outside the scope, however it is spelled', async () => {
    const at = await fixture()
    const outside = join(at.homeDir, '..', `escape-real-${fixtures}`)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'settings.json'), LEGACY_JSON, 'utf8')
    const linked = join(at.homeDir, 'linked')
    if (!(await linkDirectory(outside, linked))) return

    const outcome = await runRemediation({
      remediation: 'discard',
      // Spelled INSIDE the scope; it resolves outside it.
      legacy: {
        targetId: 't',
        filePath: join(linked, 'settings.json'),
        fileFormat: 'jsonc',
        rootPath: at.homeDir,
      },
      mode: 'apply',
    })
    expect(outcome.refusal?.message).toContain('outside')
    expect(await readFile(join(outside, 'settings.json'), 'utf8')).toBe(LEGACY_JSON)
    await rm(outside, { recursive: true, force: true }).catch(() => {})
  })
})

// --- M2 / HIGH-6: repair reads inside the queue and refuses a divergence -----

async function damagedLedger(at: Fixture): Promise<void> {
  await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
  await project(at, [mcp('ctx')], [createClaudeMcpTarget({ filePath: at.claudeJson })])
  const document = JSON.parse(await readFile(at.ledger.filePath, 'utf8')) as {
    version: number
    records: unknown[]
  }
  document.records.push({ targetId: 'x', filePath: 42 })
  await writeFile(at.ledger.filePath, JSON.stringify(document, null, 2), 'utf8')
}

describe('repair cannot destroy what it did not look at', () => {
  it('keeps a claim written between the description and the act', async () => {
    const at = await fixture()
    await damagedLedger(at)
    const scope = { targetId: 'other-target', filePath: at.claudeJson }
    const arriving: ProjectionLedgerRecord = {
      targetId: 'other-target',
      filePath: at.claudeJson,
      nativeLocation: 'mcpServers.late',
      entryId: 'late',
      contentHash: 'abc',
    }
    // The write lands while repair is between its own read and its persist.
    const inflight = at.ledger.updateEntry(scope, 'late', arriving)
    const repaired = runRemediation({ remediation: 'repair', ledger: at.ledger, mode: 'apply' })
    await Promise.all([inflight, repaired])
    expect((await ledgerRecords(at)).map((record) => record.entryId).sort()).toEqual(['ctx', 'late'])
  })

  it('reports the destructive branch in its OWN output when the ledger moved between calls', async () => {
    // The cross-invocation gap, pinned rather than papered over: two `panda
    // remediate` runs share no handle, so a preview that said "drop 1 record"
    // cannot bind the act. What the act must never do is stay quiet about it.
    const at = await fixture()
    await damagedLedger(at)
    const preview = await runRemediation({ remediation: 'repair', ledger: at.ledger, mode: 'inspect' })
    expect(preview.changes[0]?.detail).toContain('1 record(s) it can read')
    await writeFile(at.ledger.filePath, 'not json at all', 'utf8')
    const outcome = await runRemediation({ remediation: 'repair', ledger: at.ledger, mode: 'apply' })
    expect(outcome.changes[0]?.detail).toContain('REPLACE it with an empty ledger')
    expect(outcome.changes[0]?.detail).not.toBe(preview.changes[0]?.detail)
  })
})

// --- M5: the parse guard must not self-disable on the files at risk ---------

describe('the JSON parse guard judges the document the way the vendor does', () => {
  it('refuses rather than leaving a commented config with a dangling comma', async () => {
    const at = await fixture()
    const path = join(at.homeDir, 'commented.json')
    // A comment between the member and its comma: legal JSONC, and exactly what
    // `jsonRemovalSpan`'s whitespace walk cannot see. `JSON.parse` would have
    // called this file "already broken" and skipped the guard entirely.
    const body = '{\n  "panda": { "version": 1 } // my note\n  ,\n  "theme": "vercel"\n}\n'
    await writeFile(path, body, 'utf8')
    const outcome = await runRemediation({
      remediation: 'discard',
      legacy: { targetId: 't', filePath: path, fileFormat: 'jsonc', rootPath: at.homeDir },
      mode: 'apply',
    })
    // The property, either way: panda refuses and the file is untouched, or it
    // acts and the file is STILL a document the vendor can read. Asserting only
    // "theme survived and panda is gone" left `{ // my note\n , "theme": … }`
    // passing, which is the dangling comma this guard exists for.
    const after = await readFile(path, 'utf8')
    if (outcome.refusal !== undefined) {
      expect(outcome.refusal.message).toContain('unparseable')
      expect(after).toBe(body)
      return
    }
    expect(after).toContain('"theme": "vercel"')
    expect(after).not.toContain('panda')
    const errors: ParseError[] = []
    parseJsonc(after, errors, { allowTrailingComma: true })
    expect(errors, `the removal left '${after}' unreadable`).toEqual([])
  })
})

// --- M8: the SDK surface and the command agree about the default ------------

describe('the SDK surface describes by default, exactly as the command does', () => {
  it('writes nothing when no mode is given', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const target = createClaudeMcpTarget({ filePath: at.claudeJson })
    await project(at, [mcp('ctx')], [target])
    const before = await readFile(at.ledger.filePath, 'utf8')
    await writeFile(at.claudeJson, (await readFile(at.claudeJson, 'utf8')).replace('"ctx-server"', '"mine"'), 'utf8')

    const outcome = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'ctx',
      entries: groupByKind([mcp('ctx')]),
      ledger: at.ledger,
    })
    expect(outcome.applied).toBe(false)
    expect(outcome.changes.length).toBeGreaterThan(0)
    expect(await readFile(at.ledger.filePath, 'utf8')).toBe(before)
  })
})

describe('the ledger-derived claim is input, not fact', () => {
  it('refuses a record whose claimed path escaped the root, even with no plan to check it against', async () => {
    const at = await fixture()
    const source = await writeSkillSource(at, 'alpha')
    const target = skillsTarget(at.skillsRoot)
    await project(at, [skill('alpha', source)], [target])
    const outside = join(at.homeDir, 'id_rsa')
    await writeFile(outside, 'secret', 'utf8')
    // A hand-edited ledger, with the entry gone from the registry so the claim
    // comes from the RECORD rather than from a plan the engine could re-derive.
    const held = (await ledgerRecords(at))[0]!
    await at.ledger.updateEntry({ targetId: target.targetId, filePath: at.skillsRoot }, 'alpha', {
      ...held,
      ownedPaths: [{ path: outside, contentHash: 'x' }],
    })

    const outcome = await runRemediation({
      remediation: 'adopt',
      target,
      entryId: 'alpha',
      entries: groupByKind([]),
      ledger: at.ledger,
      mode: 'apply',
    })
    // The CLAIM SITE's own wording, not just the word "outside". The engine's
    // second check in `escapingPath` produces a different sentence and would
    // otherwise satisfy this row, which is how M4.B ended up with guards nobody
    // could show firing: two checks, one case, and removing either left green.
    expect(outcome.refusal?.message).toContain('is outside')
    // ...and it is the CLAIM SITE that refused, not the engine's second check in
    // `escapingPath`, whose sentence begins "claiming '<id>' would record". Two
    // checks sharing one case is how M4.B ended up with guards nobody could show
    // firing: removing either one left the suite green.
    expect(outcome.refusal?.message).not.toContain('would record')
    expect(await readFile(outside, 'utf8')).toBe('secret')
  })
})

describe('a remediation writes ONE entry, never a whole scope it read earlier (deterministic)', () => {
  it('does not resurrect a claim dropped while it was deciding', async () => {
    const at = await fixture()
    await writeFile(at.claudeJson, CLAUDE_NATIVE, 'utf8')
    const real = createClaudeMcpTarget({ filePath: at.claudeJson })
    await project(at, [mcp('ctx'), mcp('other')], [real])
    const scope = { targetId: real.targetId, filePath: at.claudeJson }
    expect(await ledgerRecords(at)).toHaveLength(2)
    // `ctx` has to actually DRIFT, or adoption is a no-op that writes nothing and
    // the whole-scope-replace it is being compared against never runs.
    await writeFile(
      at.claudeJson,
      (await readFile(at.claudeJson, 'utf8')).replace('"ctx-server"', '"mine"'),
      'utf8',
    )

    // The drop is fired from inside `claim()` — a real seam on the shipped port,
    // and the ledger's own FIFO queue is what makes the ordering deterministic:
    // this write is enqueued first, the remediation's write second.
    let dropped: Promise<void> | undefined
    const before = (await ledgerRecords(at)).find((record) => record.entryId === 'ctx')?.contentHash
    const racing: ProjectionConfigTarget = {
      targetId: real.targetId,
      filePath: at.claudeJson,
      merge: real.merge.bind(real),
      claim: (request) => {
        dropped ??= at.ledger.updateEntry(scope, 'other', undefined)
        return real.claim!(request)
      },
    }
    await runRemediation({
      remediation: 'adopt',
      target: racing,
      entryId: 'ctx',
      entries: groupByKind([mcp('ctx')]),
      ledger: at.ledger,
      mode: 'apply',
    })
    await dropped
    const after = await ledgerRecords(at)
    expect(after.map((record) => record.entryId)).toEqual(['ctx'])
    // And the adoption really happened, so the row is testing the write rather
    // than an early return.
    expect(after[0]?.contentHash).not.toBe(before)
  })
})
