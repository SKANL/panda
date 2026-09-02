import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import { RegistryStore, createMachineSkillsSource, ingestProviders } from '../src'

// The filesystem SkillSource, one edge-case row at a time (M9.A E1-E12).
//
// Every clause below plants real directories and reads them back through the
// real source: the point of this story is that a port with no implementation
// gets one, and a fake that answers what the port wants to hear would prove the
// same nothing the port already proved.

const ENTRY_FILE = 'SKILL.md'
const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

/** One real skill on disk: a directory holding the entry file every executor reads. */
async function plantSkill(root: string, id: string, body = '# skill'): Promise<string> {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, ENTRY_FILE), body, 'utf8')
  return directory
}

function sourceOver(roots: readonly string[], ownedPaths: readonly string[] = []) {
  return createMachineSkillsSource({ roots, entryFileName: ENTRY_FILE, ownedPaths })
}

describe('the filesystem skill source reads the roots panda has verified', () => {
  it('E4: one directory holding the entry file is ONE entry, id = directory name', async () => {
    const root = await makeTempDir('panda-skills-e4-')
    const directory = await plantSkill(root, 'deslop')
    const source = sourceOver([root])

    const listed = await source.list()

    expect(listed).toHaveLength(1)
    expect(listed[0]?.entry).toEqual({ type: 'skill', id: 'deslop', entryPath: directory })
    expect(typeof listed[0]?.contentHash).toBe('string')
    expect(listed[0]?.contentHash).not.toBe('')
    expect(source.warnings).toEqual([])
  })

  it('E1: a root that does not exist contributes nothing and is not an error', async () => {
    const root = await makeTempDir('panda-skills-e1-')
    await plantSkill(root, 'present')
    const absent = join(root, 'no-such-executor', 'skills')

    // CONTROL: the same call over a root that DOES exist finds the skill, so the
    // empty answer below is an absence rather than a source that never looked.
    expect(await sourceOver([root]).list()).toHaveLength(1)
    expect(await sourceOver([absent]).list()).toEqual([])
  })

  it('E2: a root that exists and is empty produces the port\'s empty-source warning', async () => {
    const root = await makeTempDir('panda-skills-e2-')
    const homeDir = await makeTempDir('panda-skills-e2-home-')
    const store = new RegistryStore({ homeDir })

    const outcome = await ingestProviders(store, { skillSources: [sourceOver([root])] })

    expect(outcome.registered).toEqual([])
    expect(outcome.warnings.map((warning) => warning.kind)).toEqual(['empty-source'])
    await store.dispose()
  })

  it('E3: a root that exists and is a FILE is a coded error naming the path', async () => {
    const root = await makeTempDir('panda-skills-e3-')
    const asFile = join(root, 'skills')
    await writeFile(asFile, 'not a directory', 'utf8')

    const error = await sourceOver([asFile])
      .list()
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      )

    expect(error).toBeInstanceOf(PandaError)
    expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryProviderRejected)
    expect((error as PandaError).message).toContain(asFile)
  })

  it('E5: a directory with no entry file is skipped with a warning naming it', async () => {
    const root = await makeTempDir('panda-skills-e5-')
    await plantSkill(root, 'real')
    await mkdir(join(root, '.git'), { recursive: true })
    const source = sourceOver([root])

    const listed = await source.list()

    // The run is not failed by it: a `.git` beside real skills is ordinary.
    expect(listed.map((item) => item.entry.id)).toEqual(['real'])
    expect(source.warnings).toHaveLength(1)
    expect(source.warnings[0]?.kind).toBe('not-a-skill')
    expect(source.warnings[0]?.detail).toContain(join(root, '.git'))
    expect(source.warnings[0]?.detail).toContain(ENTRY_FILE)
  })

  it('E6: a directory name that is not a legal registry id is skipped, named, and NEVER renamed', async () => {
    const root = await makeTempDir('panda-skills-e6-')
    await plantSkill(root, 'real')
    const illegal = await plantSkill(root, 'constructor')
    const source = sourceOver([root])

    const listed = await source.list()

    expect(listed.map((item) => item.entry.id)).toEqual(['real'])
    expect(source.warnings).toHaveLength(1)
    expect(source.warnings[0]?.kind).toBe('unusable-id')
    expect(source.warnings[0]?.detail).toContain(illegal)
    // The RULE, not just the name: an id panda invents is an id nobody can predict.
    expect(source.warnings[0]?.detail).toContain('constructor')
    expect(source.warnings[0]?.detail).toContain('projected key')
  })

  it('E7: an unchanged skill produces no store write on the second run', async () => {
    const root = await makeTempDir('panda-skills-e7-')
    await plantSkill(root, 'stable')
    const homeDir = await makeTempDir('panda-skills-e7-home-')
    const store = new RegistryStore({ homeDir })
    const writes: string[] = []
    const register = store.register.bind(store)
    store.register = async (entry, scope) => {
      writes.push((entry as { id: string }).id)
      await register(entry, scope)
    }

    const first = await ingestProviders(store, { skillSources: [sourceOver([root])] })
    const second = await ingestProviders(store, { skillSources: [sourceOver([root])] })

    expect(first.registered).toEqual(['skill:stable'])
    expect(second.registered).toEqual([])
    expect(second.unchanged).toEqual(['skill:stable'])
    expect(writes).toEqual(['stable'])
    await store.dispose()
  })

  it('E8: a changed skill is registered again and said out loud', async () => {
    const root = await makeTempDir('panda-skills-e8-')
    await plantSkill(root, 'moving')
    const homeDir = await makeTempDir('panda-skills-e8-home-')
    const store = new RegistryStore({ homeDir })

    const first = await ingestProviders(store, { skillSources: [sourceOver([root])] })
    await plantSkill(root, 'moving', '# skill, with more bytes than before')
    const second = await ingestProviders(store, { skillSources: [sourceOver([root])] })

    expect(first.registered).toEqual(['skill:moving'])
    expect(second.registered).toEqual(['skill:moving'])
    expect(second.unchanged).toEqual([])
    await store.dispose()
  })

  it('E9: a path the ownership ledger owns is never contributed', async () => {
    const root = await makeTempDir('panda-skills-e9-')
    const mine = await plantSkill(root, 'authored-by-a-human')
    const pandas = await plantSkill(root, 'materialised-by-panda')
    const source = sourceOver([root], [join(pandas, ENTRY_FILE)])

    const listed = await source.list()

    // CONTROL: the sibling skill in the SAME root is contributed, so the missing
    // one is an exclusion rather than a source that read nothing.
    expect(listed.map((item) => item.entry.entryPath)).toEqual([mine])
    expect(source.excluded).toEqual([pandas])
  })

  it('E11: a root panda cannot look at is a coded error naming it, and nothing is written', async () => {
    const homeDir = await makeTempDir('panda-skills-e11-home-')
    const store = new RegistryStore({ homeDir })
    // A path the OS refuses to answer about at all. `chmod 0` was measured to be
    // a no-op on win32 (readdir still returned []), so a permissions fixture
    // would prove this branch on one platform and skip it on the other.
    const unreadable = join(homeDir, 'skills') + String.fromCharCode(0) + 'x'

    const error = await ingestProviders(store, { skillSources: [sourceOver([unreadable])] }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(PandaError)
    expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.registryProviderRejected)
    expect((error as PandaError).message).toContain('skills')
    expect(await store.list('global')).toEqual([])
    await store.dispose()
  })

  it('E12: two roots offering the same id with DIVERGENT trees are refused, naming every root', async () => {
    const first = await makeTempDir('panda-skills-e12a-')
    const second = await makeTempDir('panda-skills-e12b-')
    const left = await plantSkill(first, 'shared', '# left')
    const right = await plantSkill(second, 'shared', '# right')
    await plantSkill(second, 'unique')
    const source = sourceOver([first, second])

    const listed = await source.list()

    // CONTROL: the id that appears once still lands, so the collision is what
    // stopped `shared` rather than a source that gave up on the second root.
    expect(listed.map((item) => item.entry.id)).toEqual(['unique'])
    expect(source.warnings).toHaveLength(1)
    expect(source.warnings[0]?.kind).toBe('id-collision')
    expect(source.warnings[0]?.detail).toContain(left)
    expect(source.warnings[0]?.detail).toContain(right)
  })

  it('E12/amend-2: roots offering BYTE-IDENTICAL trees for one id collapse to a single entry', async () => {
    // Spec M9.A amendment 2, measured twice on the author's machine: 22 of 40
    // ids sit in all three roots because the user has been hand-syncing them,
    // and 11 of the 24 colliding ids are byte-identical. Refusing those is
    // refusing the main case — there is no decision to make, it is one skill.
    const first = await makeTempDir('panda-skills-same-a-')
    const second = await makeTempDir('panda-skills-same-b-')
    const left = await plantSkill(first, 'shared', '# same')
    const right = await plantSkill(second, 'shared', '# same')
    // Nested content counts too: identity is the whole tree, not the entry file.
    for (const directory of [left, right]) {
      await mkdir(join(directory, 'references'), { recursive: true })
      await writeFile(join(directory, 'references', 'notes.md'), 'shared notes', 'utf8')
    }
    const source = sourceOver([first, second])

    const listed = await source.list()

    expect(listed.map((item) => item.entry.id)).toEqual(['shared'])
    // The FIRST root in the caller's own order; see the comment on the choice.
    expect(listed[0]?.entry.entryPath).toBe(left)
    expect(source.warnings).toEqual([])
  })

  it('E12/amend-2: one divergent root among identical ones still refuses, naming all three', async () => {
    const first = await makeTempDir('panda-skills-mixed-a-')
    const second = await makeTempDir('panda-skills-mixed-b-')
    const third = await makeTempDir('panda-skills-mixed-c-')
    const left = await plantSkill(first, 'shared', '# same')
    const middle = await plantSkill(second, 'shared', '# same')
    const right = await plantSkill(third, 'shared', '# same')
    // Only the third root carries this file, so its tree is a different tree
    // even though every byte the other two hold matches.
    await writeFile(join(right, 'EXTRA.md'), 'only here', 'utf8')
    const source = sourceOver([first, second, third])

    const listed = await source.list()

    expect(listed).toEqual([])
    expect(source.warnings).toHaveLength(1)
    expect(source.warnings[0]?.kind).toBe('id-collision')
    for (const directory of [left, middle, right]) {
      expect(source.warnings[0]?.detail).toContain(directory)
    }
  })

  it('reports nothing twice when the same source is listed twice', async () => {
    const root = await makeTempDir('panda-skills-repeat-')
    await plantSkill(root, 'real')
    await mkdir(join(root, 'assets'), { recursive: true })
    const source = sourceOver([root])

    await source.list()
    await source.list()

    expect(source.warnings).toHaveLength(1)
  })
})
