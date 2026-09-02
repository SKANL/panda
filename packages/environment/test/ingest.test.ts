import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import { SKILL_ENTRY_FILE } from '@panda/projection'
import { RegistryStore } from '@panda/registry'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { diagnose } from '../src/doctor.ts'
import { EXECUTOR_PROFILES } from '../src/executors.ts'
import { ingestMachineSkills } from '../src/ingest.ts'
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

    const report = await ingestMachineSkills({ homeDir })

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

    const report = await ingestMachineSkills({ homeDir })

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

    const report = await ingestMachineSkills({ homeDir })

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

    const report = await ingestMachineSkills({ homeDir })

    expect(report.outcome.registered).toEqual(['skill:written-by-a-human'])
  })
})

describe('an unreadable ownership ledger refuses the run (E10)', () => {
  it('rejects coded before a single store write, because ingesting panda\'s own output is worse', async () => {
    const homeDir = await fixture()
    const root = machineRoots(homeDir)[0]!
    await plantSkill(root, 'would-have-been-ingested')
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(join(homeDir, '.panda', 'projection-ledger.json'), '{ not json', 'utf8')

    const error = await ingestMachineSkills({ homeDir }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(PandaError)
    expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.projectionLedgerUnavailable)
    expect((error as PandaError).message).toContain('projection-ledger.json')
    expect(await countEntries(homeDir)).toBe(0)
    // CONTROL: with a readable ledger the very same skill IS ingested, so the
    // refusal above is the ledger and not an empty root.
    await rm(join(homeDir, '.panda', 'projection-ledger.json'))
    expect((await ingestMachineSkills({ homeDir })).outcome.registered).toEqual([
      'skill:would-have-been-ingested',
    ])
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

    await ingestMachineSkills({ homeDir })
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
    const registryPath = (await ingestMachineSkills({ homeDir, dryRun: true })).registryPath
    const before = await readFile(registryPath, 'utf8').catch(() => '<absent>')

    const preview = await ingestMachineSkills({ homeDir, dryRun: true })

    expect(preview.outcome.registered).toEqual(['skill:previewed'])
    expect(await readFile(registryPath, 'utf8').catch(() => '<absent>')).toBe(before)
    expect(before).toBe('<absent>')
  })
})
