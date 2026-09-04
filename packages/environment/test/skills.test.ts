import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_SKILLS_TRAITS,
  CODEX_SKILLS_TRAITS,
  OPENCODE_SKILLS_TRAITS,
} from '@panda/projection'
import type { SkillsTargetTraits } from '@panda/projection'
import { RegistryStore } from '@panda/registry'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { diagnose } from '../src/doctor.ts'
import { EXECUTOR_PROFILES } from '../src/executors.ts'
import { initMachine, initProject } from '../src/init.ts'
import { snapshotRealSkillsRoots } from './real-skills-roots.ts'

// `panda init` end to end for the skills surface: a registry skill reaches each
// detected executor's own root, stops being reported as something no executor
// can express, and is removed again — exactly and only — when it leaves the
// registry.
//
// Every fixture injects its own home. The developer's three real skills roots
// are snapshotted before and after the whole file, because this is the suite
// whose subject is deletion.

const tempRoots: string[] = []
let realRootsBefore: string

beforeAll(async () => {
  realRootsBefore = await snapshotRealSkillsRoots()
})

afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
  expect(await snapshotRealSkillsRoots()).toBe(realRootsBefore)
})

interface Fixture {
  readonly homeDir: string
  readonly projectDir: string
  readonly sources: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'panda-skills-'))
  tempRoots.push(root)
  const homeDir = join(root, 'home')
  const projectDir = join(root, 'project')
  const sources = join(root, 'sources')
  await mkdir(homeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await mkdir(sources, { recursive: true })
  return { homeDir, projectDir, sources }
}

const SKILL_BODY = '---\nname: alpha\ndescription: The alpha skill.\n---\n\nAlpha body.\n'

async function registerSkill(at: Fixture, id = 'alpha'): Promise<string> {
  const entryPath = join(at.sources, `${id}.md`)
  await writeFile(entryPath, SKILL_BODY, 'utf8')
  const store = new RegistryStore({ homeDir: at.homeDir })
  await store.register({ type: 'skill', id, entryPath }, 'global')
  await store.dispose()
  return entryPath
}

async function unregisterAll(at: Fixture): Promise<void> {
  const store = new RegistryStore({ homeDir: at.homeDir })
  for (const entry of await store.list()) await store.remove(entry.type, entry.id, 'global')
  await store.dispose()
}

/** Claude Code, Codex and OpenCode all present, so every verified root applies. */
async function withEveryExecutor(homeDir: string): Promise<void> {
  await writeFile(join(homeDir, '.claude.json'), '{}\n', 'utf8')
  await mkdir(join(homeDir, '.codex'), { recursive: true })
  await mkdir(join(homeDir, '.config', 'opencode'), { recursive: true })
  await writeFile(join(homeDir, '.config', 'opencode', 'opencode.json'), '{}\n', 'utf8')
}

const ROOTS = (homeDir: string): Record<string, string> => ({
  'claude-code': join(homeDir, '.claude', 'skills'),
  codex: join(homeDir, '.codex', 'skills'),
  opencode: join(homeDir, '.config', 'opencode', 'skills'),
})

describe('the shipped executor profiles', () => {
  it('declare a verified skills root, its target id and its factory together or not at all', () => {
    for (const profile of EXECUTOR_PROFILES) {
      const declared = [
        profile.machineSkills !== undefined,
        profile.skillsTargetId !== undefined,
        profile.createSkillsTarget !== undefined,
      ]
      expect(new Set(declared).size, `${profile.executorId} half-declares a skills location`).toBe(1)
    }
  })

  it('writes at the EXACT string the live discovery check verified', () => {
    // THE LINK THE PROOF HANGS FROM, and it did not exist. The live check
    // measures each trait record's `defaultRoot` against the real binary;
    // production writes at `profile.machineSkills(homeDir)`. Those are two
    // different strings, and without this assertion mutating the production one
    // to a bogus root left the live suite fully green — "the binary confirmed
    // this location" would no longer imply "this is where panda writes".
    const traits: Record<string, SkillsTargetTraits> = {
      'claude-code': CLAUDE_SKILLS_TRAITS,
      codex: CODEX_SKILLS_TRAITS,
      opencode: OPENCODE_SKILLS_TRAITS,
    }
    const real = homedir()
    for (const profile of EXECUTOR_PROFILES) {
      if (profile.machineSkills === undefined || profile.createSkillsTarget === undefined) continue
      const shipped = traits[profile.executorId]
      expect(shipped, `no verified trait record for '${profile.executorId}'`).toBeDefined()
      expect(profile.machineSkills(real)).toBe(shipped!.defaultRoot)
      expect(profile.skillsTargetId).toBe(shipped!.targetId)
      // And the factory really builds THAT target at THAT root.
      const target = profile.createSkillsTarget(profile.machineSkills(real))
      expect(target.targetId).toBe(shipped!.targetId)
      expect(target.rootPath).toBe(shipped!.defaultRoot)
    }
  })

  it('spells each root the same way the report does, for an injected home', () => {
    const homeDir = join(tmpdir(), 'panda-root-spelling')
    for (const profile of EXECUTOR_PROFILES) {
      if (profile.machineSkills === undefined) continue
      expect(profile.machineSkills(homeDir)).toBe(ROOTS(homeDir)[profile.executorId])
    }
  })
})

describe('panda init materialises skills where each executor reads them', () => {
  it('writes <root>/<id>/SKILL.md for every detected executor, and reports one row each', async () => {
    const at = await fixture()
    await withEveryExecutor(at.homeDir)
    await registerSkill(at)

    const result = await initMachine({ homeDir: at.homeDir })

    expect(result.skills.map((row) => row.executorId)).toEqual(['claude-code', 'codex', 'opencode'])
    for (const row of result.skills) {
      expect(row).toMatchObject({ written: true, drift: [], unprojectable: [] })
      expect(row.filePath).toBe(ROOTS(at.homeDir)[row.executorId])
      expect(await readFile(join(row.filePath, 'alpha', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
    }
  })

  it('stops reporting a skill as something the executor cannot express', async () => {
    const at = await fixture()
    await withEveryExecutor(at.homeDir)
    await registerSkill(at)

    const result = await initMachine({ homeDir: at.homeDir })

    // Before this story every one of these rows said "'claude-code' has no
    // native representation for a skill entry". Saying it now, beside a row
    // reporting the same skill written, would be panda contradicting itself.
    expect(result.targets.flatMap((row) => row.unprojectable)).toEqual([])
  })

  it('is idempotent: a second init writes no byte under any root', async () => {
    const at = await fixture()
    await withEveryExecutor(at.homeDir)
    await registerSkill(at)
    await initMachine({ homeDir: at.homeDir })
    const landed = join(ROOTS(at.homeDir)['claude-code']!, 'alpha', 'SKILL.md')
    const before = await stat(landed)

    const again = await initMachine({ homeDir: at.homeDir })

    expect(again.skills.every((row) => !row.written)).toBe(true)
    expect((await stat(landed)).mtimeMs).toBe(before.mtimeMs)
  })

  it('removes exactly what it wrote when the skill leaves the registry, sparing a hand-made neighbour', async () => {
    const at = await fixture()
    await withEveryExecutor(at.homeDir)
    await registerSkill(at)
    await initMachine({ homeDir: at.homeDir })
    const root = ROOTS(at.homeDir)['claude-code']!
    await mkdir(join(root, 'by-hand'), { recursive: true })
    await writeFile(join(root, 'by-hand', 'SKILL.md'), 'mine\n', 'utf8')
    await unregisterAll(at)

    const result = await initMachine({ homeDir: at.homeDir })

    expect(result.skills.every((row) => row.written)).toBe(true)
    expect(await readdir(root)).toEqual(['by-hand'])
    expect(await readFile(join(root, 'by-hand', 'SKILL.md'), 'utf8')).toBe('mine\n')
  })

  it('reports a skill whose source cannot be read, per executor, and materialises nothing for it', async () => {
    const at = await fixture()
    await withEveryExecutor(at.homeDir)
    const entryPath = await registerSkill(at)
    await rm(entryPath)

    const result = await initMachine({ homeDir: at.homeDir })

    for (const row of result.skills) {
      expect(row.unprojectable).toEqual([
        { entryId: 'alpha', reason: expect.stringContaining('cannot be read') },
      ])
      await expect(stat(join(row.filePath, 'alpha'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    // The target's OWN reason, not the registry-derived sentence that would have
    // claimed the executor has no representation for a skill at all.
    //
    // THIS USED TO DISCRIMINATE ON `correction-01 C5`, an internal spec citation
    // the derived sentence carried. It made a good marker precisely because no
    // target would ever write one -- and that is also why it had to go: doctor
    // printed it verbatim to users, for whom a document name is a fact about
    // panda's history rather than about their machine. Pinned on the derived
    // SENTENCE now, which is the thing actually being ruled out.
    expect(result.skills[0]?.unprojectable[0]?.reason).not.toContain('has no native representation')
  })
})

describe('an executor whose skills location panda has not verified', () => {
  it('reports its skills unprojectable at project scope and invents no location', async () => {
    const at = await fixture()
    await withEveryExecutor(at.homeDir)
    await registerSkill(at)

    const result = await initProject({ homeDir: at.homeDir, projectDir: at.projectDir })

    expect(result.skills).toEqual([])
    for (const row of result.targets) {
      expect(row.unprojectable).toEqual([
        { entryId: 'alpha', reason: expect.stringContaining('no native representation for a skill') },
      ])
    }
    // Nothing was created under the project, and nothing under the machine roots.
    expect(await readdir(at.projectDir)).toEqual(expect.not.arrayContaining(['skills']))
    for (const root of Object.values(ROOTS(at.homeDir))) {
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
})

describe('panda doctor sees the skills surface too', () => {
  it('predicts the materialisation, writes nothing, and is clean once init has run', async () => {
    const at = await fixture()
    await withEveryExecutor(at.homeDir)
    await registerSkill(at)

    const before = await diagnose({ homeDir: at.homeDir })
    expect(before.skills.map((row) => row.wouldWrite)).toEqual([true, true, true])
    expect(before.findings.filter((found) => found.kind === 'out-of-date').length).toBeGreaterThan(0)
    for (const root of Object.values(ROOTS(at.homeDir))) {
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    }

    await initMachine({ homeDir: at.homeDir })

    const after = await diagnose({ homeDir: at.homeDir })
    expect(after.skills.map((row) => row.wouldWrite)).toEqual([false, false, false])
    expect(after.findings).toEqual([])
  })

  it('reports an edited skill as drift, naming the executor, the root and the entry', async () => {
    const at = await fixture()
    await withEveryExecutor(at.homeDir)
    await registerSkill(at)
    await initMachine({ homeDir: at.homeDir })
    const root = ROOTS(at.homeDir)['codex']!
    await writeFile(join(root, 'alpha', 'SKILL.md'), `${SKILL_BODY}mine\n`, 'utf8')

    const diagnosis = await diagnose({ homeDir: at.homeDir })

    expect(diagnosis.findings.filter((found) => found.kind === 'edited')).toEqual([
      expect.objectContaining({
        kind: 'edited',
        executorId: 'codex',
        filePath: root,
        location: 'alpha',
        entryId: 'alpha',
      }),
    ])
  })
})
