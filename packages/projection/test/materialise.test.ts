import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectionMaterialiseTarget, RegistryEntry } from '@panda/contracts'
import { runProjection, groupByKind } from '../src/engine.ts'
import { ProjectionLedger } from '../src/ledger.ts'
import { snapshotRealSkillsRoots } from './real-skills-roots.ts'
import { createSkillsTargetFromTraits } from '../src/targets/skills.ts'

// The materialisation matrix. Everything here runs against a real filesystem
// under one `mkdtemp` root, because the claims are filesystem claims: a
// hand-made directory SURVIVES, foreign files are byte-identical afterwards, a
// corrupt ledger removes NOTHING. A spy on an unlink call would prove none of
// them.

const SKILL_BODY = '---\nname: alpha\ndescription: The alpha skill.\n---\n\nAlpha body.\n'

let sandbox: string
let realRootsBefore: string

beforeAll(async () => {
  realRootsBefore = await snapshotRealSkillsRoots()
  sandbox = await mkdtemp(join(tmpdir(), 'panda-materialise-'))
})

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  // The developer's own skills roots, unchanged. Every fixture injects its own
  // home, and this is what makes that a measurement rather than an intention.
  expect(await snapshotRealSkillsRoots()).toBe(realRootsBefore)
})

interface Fixture {
  readonly homeDir: string
  readonly root: string
  readonly sources: string
  readonly ledger: ProjectionLedger
}

let fixtures = 0

async function fixture(): Promise<Fixture> {
  fixtures += 1
  const homeDir = join(sandbox, `home-${fixtures}`)
  const root = join(homeDir, 'skills')
  const sources = join(homeDir, 'sources')
  await mkdir(sources, { recursive: true })
  return { homeDir, root, sources, ledger: new ProjectionLedger({ homeDir }) }
}

function target(rootPath: string, targetId = 'stub-skills'): ProjectionMaterialiseTarget {
  return createSkillsTargetFromTraits({ targetId, defaultRoot: '/unused' }, { rootPath })
}

async function writeSource(fixtureAt: Fixture, name: string, body = SKILL_BODY): Promise<string> {
  const path = join(fixtureAt.sources, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body, 'utf8')
  return path
}

function skill(id: string, entryPath: string): RegistryEntry {
  return { type: 'skill', id, entryPath }
}

async function project(
  at: Fixture,
  entries: readonly RegistryEntry[],
  options: { readonly mode?: 'apply' | 'inspect'; readonly targets?: readonly ProjectionMaterialiseTarget[] } = {},
) {
  return await runProjection({
    entries: groupByKind(entries),
    targets: options.targets ?? [target(at.root)],
    ledger: at.ledger,
    mode: options.mode ?? 'apply',
  })
}

/**
 * A directory link, or `false` where the platform refuses one.
 *
 * On Windows an unprivileged process cannot create a symlink without developer
 * mode, so the junction form is tried first — and a junction is the shape that
 * matters anyway, because `rmdir` removes one without consulting its target.
 */
async function symlinkDirectory(target_: string, link: string): Promise<boolean> {
  for (const type of ['junction', 'dir'] as const) {
    try {
      await symlink(target_, link, type)
      return true
    } catch {
      continue
    }
  }
  return false
}

/** Every path under a directory with its bytes; the identity a survival claim needs. */
async function treeOf(path: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name)
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        found[`${key}/`] = ''
        await walk(child, key)
      } else {
        found[key] = await readFile(child, 'utf8')
      }
    }
  }
  await walk(path, '').catch(() => {})
  return found
}

describe('skills materialise as a directory tree', () => {
  it('places <root>/<id>/SKILL.md with the source bytes, verbatim', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')

    const run = await project(at, [skill('alpha', source)])

    expect(run.failures).toEqual([])
    expect(run.results[0]).toMatchObject({ targetId: 'stub-skills', written: true })
    expect(await readFile(join(at.root, 'alpha', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
  })

  it('copies a directory source whole, nested files included', async () => {
    const at = await fixture()
    const source = join(at.sources, 'beta')
    await mkdir(join(source, 'references'), { recursive: true })
    await writeFile(join(source, 'SKILL.md'), SKILL_BODY, 'utf8')
    await writeFile(join(source, 'references', 'notes.md'), 'notes\n', 'utf8')

    await project(at, [skill('beta', source)])

    expect(await treeOf(join(at.root, 'beta'))).toEqual({
      'SKILL.md': SKILL_BODY,
      'references/': '',
      'references/notes.md': 'notes\n',
    })
  })

  it('writes nothing at all on a second run over an unchanged registry', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const landed = join(at.root, 'alpha', 'SKILL.md')
    const before = await stat(landed)

    const second = await project(at, [skill('alpha', source)])

    expect(second.results[0]).toMatchObject({ written: false, byteDelta: 0, drift: [] })
    const after = await stat(landed)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
  })

  it('reports what it WOULD do under inspection and touches nothing', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')

    const run = await project(at, [skill('alpha', source)], { mode: 'inspect' })

    expect(run.results[0]?.written).toBe(true)
    await expect(stat(at.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('removal takes exactly what the ledger claims', () => {
  it('removes the recorded paths and reclaims the emptied directory', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])

    const run = await project(at, [])

    expect(run.results[0]?.written).toBe(true)
    expect(await treeOf(at.root)).toEqual({})
    // The root itself is never removed: it is the vendor's directory, not panda's.
    expect((await stat(at.root)).isDirectory()).toBe(true)
  })

  it('leaves a hand-made skill directory beside panda’s untouched', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const handMade = join(at.root, 'mine')
    await mkdir(handMade, { recursive: true })
    await writeFile(join(handMade, 'SKILL.md'), 'mine, by hand\n', 'utf8')
    const before = await treeOf(handMade)

    await project(at, [])

    expect(await treeOf(handMade)).toEqual(before)
    expect(await treeOf(at.root)).toEqual({ 'mine/': '', 'mine/SKILL.md': 'mine, by hand\n' })
  })

  it('leaves foreign files in the root byte for byte, whatever they are', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    await writeFile(join(at.root, 'README.md'), 'not panda’s\n', 'utf8')
    await writeFile(join(at.root, '.keep'), '', 'utf8')

    await project(at, [])

    expect(await treeOf(at.root)).toEqual({ '.keep': '', 'README.md': 'not panda’s\n' })
  })

  it('keeps a directory alive when a foreign file was added inside panda’s own tree', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    await writeFile(join(at.root, 'alpha', 'notes.md'), 'mine\n', 'utf8')

    await project(at, [])

    // Panda's own file is gone; the foreign one — and therefore the directory —
    // survives, because `rmdir` refuses a directory that still holds anything.
    expect(await treeOf(at.root)).toEqual({ 'alpha/': '', 'alpha/notes.md': 'mine\n' })
  })

  it('refuses to remove a tree the user has edited, and says so', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const landed = join(at.root, 'alpha', 'SKILL.md')
    await writeFile(landed, `${SKILL_BODY}mine\n`, 'utf8')

    const run = await project(at, [])

    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'edited', entryId: 'alpha', location: 'alpha' }),
    ])
    expect(await readFile(landed, 'utf8')).toBe(`${SKILL_BODY}mine\n`)
  })

  it('removes nothing at all when the ledger cannot be read', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const before = await treeOf(at.root)
    await writeFile(at.ledger.filePath, '{ broken', 'utf8')

    const run = await project(at, [])

    expect(run.warnings.map((warning) => warning.code)).toEqual(['PANDA_PROJECTION_LEDGER_UNAVAILABLE'])
    expect(await treeOf(at.root)).toEqual(before)
    expect(await readFile(at.ledger.filePath, 'utf8')).toBe('{ broken')
  })

  it('drops the claim silently when the user already deleted the tree', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    await rm(join(at.root, 'alpha'), { recursive: true })

    const run = await project(at, [])

    expect(run.results[0]).toMatchObject({ written: false, drift: [] })
  })

  it('takes back a file that left the source, and nothing beside it', async () => {
    const at = await fixture()
    const source = join(at.sources, 'gamma')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), SKILL_BODY, 'utf8')
    await writeFile(join(source, 'extra.md'), 'extra\n', 'utf8')
    await project(at, [skill('gamma', source)])
    await rm(join(source, 'extra.md'))

    await project(at, [skill('gamma', source)])

    expect(await treeOf(join(at.root, 'gamma'))).toEqual({ 'SKILL.md': SKILL_BODY })
  })

  it('keeps the claim for a registered skill whose source vanished, and removes nothing', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    await rm(source)

    const run = await project(at, [skill('alpha', source)])

    expect(run.results[0]?.skipped?.[0]?.entryId).toBe('alpha')
    expect(await readFile(join(at.root, 'alpha', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
    // Still claimed, so the next run can manage it again once the source is back.
    const ledger = await at.ledger.read()
    expect(ledger.records.map((record) => record.entryId)).toEqual(['alpha'])
  })
})

describe('panda writes only where it can prove the location is free', () => {
  it('reports a hand-made directory with the same id as a collision and overwrites nothing', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await mkdir(join(at.root, 'alpha'), { recursive: true })
    await writeFile(join(at.root, 'alpha', 'SKILL.md'), 'theirs\n', 'utf8')

    const run = await project(at, [skill('alpha', source)])

    expect(run.results[0]).toMatchObject({ written: false })
    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'foreign-collision', entryId: 'alpha' }),
    ])
    expect(await readFile(join(at.root, 'alpha', 'SKILL.md'), 'utf8')).toBe('theirs\n')
  })

  it('writes into an EMPTY leftover directory, because an empty directory belongs to no one', async () => {
    // The dead end this closes, reached by following panda's own printed
    // instructions: delete a materialised SKILL.md and the directory survives;
    // doctor reports `removed-by-user` and says `release` frees the location so
    // the next run writes it back; `release` drops the claim; the next run then
    // found the EMPTY directory, called it foreign and refused; `adopt` had
    // nothing to claim and refused; `release` had no claim left and refused.
    // Exit 1 forever, escapable only with `rmdir` by hand. Panda was refusing to
    // write in order to protect nothing.
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    await rm(join(at.root, 'alpha', 'SKILL.md'))
    // The claim is gone — this is the state `release` leaves behind. A fresh
    // ledger over the SAME root is that state exactly: the tree is there, and
    // nothing in panda's records claims it.
    const unclaimed: Fixture = {
      ...at,
      ledger: new ProjectionLedger({ filePath: join(at.homeDir, 'released-ledger.json') }),
    }

    const run = await project(unclaimed, [skill('alpha', source)])

    expect(run.results[0]?.drift).toEqual([])
    expect(run.results[0]).toMatchObject({ written: true })
    expect(await treeOf(at.root)).toEqual({ 'alpha/': '', 'alpha/SKILL.md': SKILL_BODY })
  })

  it('still refuses an unclaimed directory that holds ANYTHING, which is the protection that matters', async () => {
    // The other half of the same change, and the one that must not move: a
    // directory with a file in it is content panda did not write and will not
    // resolve.
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await mkdir(join(at.root, 'alpha'), { recursive: true })
    await writeFile(join(at.root, 'alpha', 'THEIRS.txt'), 'mine\n', 'utf8')

    const run = await project(at, [skill('alpha', source)])

    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'foreign-collision', entryId: 'alpha' }),
    ])
    expect(await treeOf(at.root)).toEqual({ 'alpha/': '', 'alpha/THEIRS.txt': 'mine\n' })
  })

  it('reports an edited tree rather than overwriting it', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const landed = join(at.root, 'alpha', 'SKILL.md')
    await writeFile(landed, 'mine now\n', 'utf8')

    const run = await project(at, [skill('alpha', source)])

    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'edited', entryId: 'alpha' }),
    ])
    expect(await readFile(landed, 'utf8')).toBe('mine now\n')
  })

  it('never re-adds a tree the user deleted while the skill is still registered', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    await rm(join(at.root, 'alpha'), { recursive: true })

    const run = await project(at, [skill('alpha', source)])

    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'removed-by-user', entryId: 'alpha' }),
    ])
    expect(await treeOf(at.root)).toEqual({})
  })
})

describe('a source panda cannot use is reported, never approximated', () => {
  it('reports a missing entryPath and materialises nothing for it', async () => {
    const at = await fixture()
    const present = await writeSource(at, 'alpha.md')

    const run = await project(at, [
      skill('alpha', present),
      { type: 'skill', id: 'ghost', entryPath: join(at.sources, 'nowhere.md') },
    ])

    expect(run.results[0]?.skipped).toEqual([
      { entryId: 'ghost', reason: expect.stringContaining('cannot be read') },
    ])
    expect(await treeOf(at.root)).toEqual({ 'alpha/': '', 'alpha/SKILL.md': SKILL_BODY })
  })

  it('reports a skill entry with no entryPath at all', async () => {
    const at = await fixture()

    const run = await project(at, [{ type: 'skill', id: 'bare' }])

    expect(run.results[0]?.skipped).toEqual([
      { entryId: 'bare', reason: expect.stringContaining('no entryPath') },
    ])
  })

  it('reports a directory source holding no SKILL.md rather than inventing one', async () => {
    const at = await fixture()
    const source = join(at.sources, 'empty')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'readme.md'), 'nothing here\n', 'utf8')

    const run = await project(at, [skill('empty', source)])

    expect(run.results[0]?.skipped).toEqual([
      { entryId: 'empty', reason: expect.stringContaining('holds no SKILL.md') },
    ])
    expect(await treeOf(at.root)).toEqual({})
  })

  it('refuses an id that would escape the root, and writes nothing outside it', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')

    const run = await project(at, [skill('../escaped', source)])

    expect(run.results[0]?.skipped).toEqual([
      { entryId: '../escaped', reason: expect.stringContaining('cannot be a directory name') },
    ])
    await expect(stat(join(at.homeDir, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('the engine defends itself against the plan it was handed', () => {
  // A target's plan is ordinary code, and the filesystem moves between planning
  // and writing. These two cases exercise the engine's own guards directly,
  // with a hand-rolled target, because the skills target's `plan` already
  // filters both shapes out and could never reach them.
  const planning = (
    entriesOut: readonly { entryId: string; location: string; files: readonly { relativePath: string; sourcePath: string }[] }[],
  ): ProjectionMaterialiseTarget => ({
    kind: 'materialise',
    targetId: 'stub-skills',
    rootPath: '',
    plan: () => ({ entries: entriesOut, presentEntryIds: entriesOut.map((entry) => entry.entryId) }),
  })

  it('reports a source that disappeared after planning, and keeps the claim it already had', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const vanished = join(at.sources, 'vanished.md')
    const raced = {
      ...planning([
        {
          entryId: 'alpha',
          location: 'alpha',
          files: [{ relativePath: 'alpha/SKILL.md', sourcePath: vanished }],
        },
      ]),
      rootPath: at.root,
    }

    const run = await project(at, [], { targets: [raced] })

    expect(run.failures).toEqual([])
    expect(run.results[0]?.skipped).toEqual([
      { entryId: 'alpha', reason: expect.stringContaining('cannot read') },
    ])
    expect(await readFile(join(at.root, 'alpha', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
    expect((await at.ledger.read()).records.map((record) => record.entryId)).toEqual(['alpha'])
  })

  it('refuses a plan that names a path outside the root, and writes nothing there', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    // The skills target's own id check makes this unreachable through the
    // shipped path, which is exactly why the ENGINE's copy needs its own case:
    // without one it was a guard nobody could show firing.
    const escaping = {
      ...planning([
        {
          entryId: 'alpha',
          location: 'alpha',
          files: [{ relativePath: '../../escaped.md', sourcePath: source }],
        },
      ]),
      rootPath: at.root,
    }

    const run = await project(at, [], { targets: [escaping] })

    expect(run.failures[0]?.error.code).toBe('PANDA_PROJECTION_TRAITS_INVALID')
    await expect(stat(join(at.homeDir, '..', 'escaped.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(at.homeDir, 'escaped.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves no partial tree behind when a write fails halfway through one', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    // The second file's parent is the first file, so writing the first makes the
    // second impossible: a failure that can only happen after bytes have landed.
    const doomed = {
      ...planning([
        {
          entryId: 'alpha',
          location: 'alpha',
          files: [
            { relativePath: 'alpha/SKILL.md', sourcePath: source },
            { relativePath: 'alpha/SKILL.md/nested.md', sourcePath: source },
          ],
        },
      ]),
      rootPath: at.root,
    }

    const run = await project(at, [], { targets: [doomed] })

    expect(run.failures.map((failure) => failure.targetId)).toEqual(['stub-skills'])
    expect(await treeOf(at.root)).toEqual({})
  })
})

describe('the delete path is contained, and its guards are falsifiable', () => {
  // The containment and identity guarantees used to be enforced on the
  // reversible half (writes) and ASSUMED on the irreversible one. Every clause
  // below is a path panda must not delete.

  it('never removes a path the ledger claims outside the root, absolute or relative', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const outside = join(at.homeDir, 'precious.json')
    await writeFile(outside, '{"mine": true}\n', 'utf8')
    // A ledger a user hand-edited, a build with a bug, a path that predates a
    // move: a record is a file panda PARSED, so its paths are input.
    const state = await at.ledger.read()
    await at.ledger.update(
      { targetId: 'stub-skills', filePath: at.root },
      state.records.map((record) => ({
        ...record,
        ownedPaths: [
          { path: outside, contentHash: 'whatever' },
          // A RELATIVE path resolves against the process working directory,
          // which is nowhere near the root panda owns.
          { path: 'package.json', contentHash: 'whatever' },
        ],
      })),
    )

    const run = await project(at, [])

    expect(await readFile(outside, 'utf8')).toBe('{"mine": true}\n')
    expect(await readFile(join(process.cwd(), 'package.json'), 'utf8')).not.toBe('')
    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'foreign-collision', entryId: 'alpha' }),
    ])
    // Reported, and the claim kept: erasing it would orphan the tree forever.
    expect((await at.ledger.read()).records.map((record) => record.entryId)).toEqual(['alpha'])
  })

  it('refuses a claimed tree reached through a link, instead of deleting through it', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    // The realistic sequence: the user moves the tree into their own repository
    // and leaves a link behind. The hash check reads THROUGH it, so without the
    // link clause the state reads `intact` and panda deletes the real file.
    const moved = join(at.homeDir, 'my-repo', 'alpha')
    await mkdir(moved, { recursive: true })
    await writeFile(join(moved, 'SKILL.md'), SKILL_BODY, 'utf8')
    await rm(join(at.root, 'alpha'), { recursive: true })
    const linked = await symlinkDirectory(moved, join(at.root, 'alpha'))
    if (!linked) return

    const run = await project(at, [])

    // The real file, outside the root, is untouched — and so is the link, which
    // `rmdir` would otherwise have removed without consulting its target.
    expect(await readFile(join(moved, 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
    expect((await lstat(join(at.root, 'alpha'))).isSymbolicLink()).toBe(true)
    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'edited', entryId: 'alpha' }),
    ])
  })

  it('never removes a path another registry entry still claims', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    // A second record claiming the SAME path — which is what `alpha` and
    // `Alpha` are on Windows, and what any two ids that collide are anywhere.
    const state = await at.ledger.read()
    const twin = state.records.map((record) => ({ ...record, entryId: 'twin', nativeLocation: 'twin' }))
    await at.ledger.update({ targetId: 'stub-skills', filePath: at.root }, [...state.records, ...twin])

    // `twin` leaves the registry; `alpha` stays.
    const run = await project(at, [skill('alpha', source)])

    expect(await readFile(join(at.root, 'alpha', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'foreign-collision', detail: expect.stringContaining('more than one registry entry') }),
    ])
  })

  it('keeps a claim it cannot use as authority instead of erasing it', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    // A record with no `ownedPaths`: what an older build wrote, and what the
    // authority filter refuses to act on. Refusing to ACT on it is right;
    // dropping it turns a one-run under-claim into a permanent orphan.
    const state = await at.ledger.read()
    await at.ledger.update(
      { targetId: 'stub-skills', filePath: at.root },
      state.records.map((record) => ({ ...record, ownedPaths: undefined })),
    )

    const run = await project(at, [skill('alpha', source)])

    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'foreign-collision', entryId: 'alpha' }),
    ])
    const after = await at.ledger.read()
    expect(after.records.map((record) => record.entryId)).toEqual(['alpha'])
    expect(after.records[0]?.ownedPaths).toBeUndefined()
  })

  it('drops a record whose ownedPaths are malformed, so it can authorise nothing', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const raw = JSON.parse(await readFile(at.ledger.filePath, 'utf8')) as {
      records: { ownedPaths: unknown }[]
    }
    // `readFile(123)` reads a FILE DESCRIPTOR in node, which is the reason a
    // half-typed path list may never reach the removal code.
    raw.records[0]!.ownedPaths = [{ path: 123, contentHash: 'x' }]
    await writeFile(at.ledger.filePath, JSON.stringify(raw), 'utf8')

    const state = await at.ledger.read()

    expect(state.records).toEqual([])
    expect(state.warnings.map((warning) => warning.code)).toEqual(['PANDA_PROJECTION_LEDGER_UNAVAILABLE'])
    // And with nothing claimed, the tree is a foreign collision rather than a
    // removal candidate: the user's files are not reachable by this run.
    const run = await project(at, [])
    expect(await treeOf(at.root)).not.toEqual({})
    expect(run.results[0]?.written).toBe(false)
  })

  it('decides REMOVAL on raw bytes, so an EOL rewrite is never taken as a match', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const landed = join(at.root, 'alpha', 'SKILL.md')
    await writeFile(landed, SKILL_BODY.replaceAll('\n', '\r\n'), 'utf8')

    const run = await project(at, [])

    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'edited', entryId: 'alpha' }),
    ])
    expect(await readFile(landed, 'utf8')).toContain('\r\n')
  })

  it('decides OVERWRITE on normalised text, so a CRLF checkout is repaired, not condemned', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    await project(at, [skill('alpha', source)])
    const landed = join(at.root, 'alpha', 'SKILL.md')
    // `core.autocrlf` on a skills root kept in a dotfiles repository. Byte-exact
    // here would mark every panda skill `edited` forever, with no adopt, force
    // or reclaim path anywhere in the product to get back out of it.
    await writeFile(landed, SKILL_BODY.replaceAll('\n', '\r\n'), 'utf8')

    const run = await project(at, [skill('alpha', source)])

    expect(run.results[0]?.drift).toEqual([])
    expect(run.results[0]?.written).toBe(true)
    expect(await readFile(landed, 'utf8')).toBe(SKILL_BODY)
  })

  it('reports a claimed file that became unreadable rather than failing the whole target', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    const other = await writeSource(at, 'beta.md')
    await project(at, [skill('alpha', source), skill('beta', other)])
    // A directory where a claimed FILE was: `readFile` answers EISDIR, which the
    // first version let escape and fail every skill for that executor.
    await rm(join(at.root, 'alpha', 'SKILL.md'))
    await mkdir(join(at.root, 'alpha', 'SKILL.md'), { recursive: true })

    const run = await project(at, [skill('beta', other)])

    expect(run.failures).toEqual([])
    expect(run.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'edited', entryId: 'alpha' }),
    ])
    expect(await readFile(join(at.root, 'beta', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
  })

  it('reports a dot-only id per entry instead of failing every skill for that executor', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')

    const run = await project(at, [skill('...', source), skill('alpha', source)])

    expect(run.failures).toEqual([])
    expect(run.results[0]?.skipped).toEqual([
      { entryId: '...', reason: expect.stringContaining('cannot be a directory name') },
    ])
    expect(await readFile(join(at.root, 'alpha', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
  })
})

describe('per-target failure isolation', () => {
  it('contains a target that is neither kind, instead of taking its siblings down', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    // `ProjectionTarget` is a published port, so a caller CAN hand over a plain
    // object. The scope used to be computed outside the per-target try, so this
    // threw out of `runProjection` and killed every sibling.
    const offUnion = { targetId: 'off-union' } as unknown as ProjectionMaterialiseTarget

    const run = await project(at, [skill('alpha', source)], {
      targets: [offUnion, target(at.root)],
    })

    expect(run.failures.map((failure) => failure.targetId)).toEqual(['off-union'])
    expect(await readFile(join(at.root, 'alpha', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
  })

  it('fails only the target whose root is unusable', async () => {
    const at = await fixture()
    const source = await writeSource(at, 'alpha.md')
    // A FILE where the root's parent directory belongs: the vendor location is
    // unusable, and every other target must still land.
    const blocker = join(at.homeDir, 'blocked')
    await writeFile(blocker, 'not a directory\n', 'utf8')

    const run = await project(at, [skill('alpha', source)], {
      targets: [target(join(blocker, 'skills'), 'broken-skills'), target(at.root)],
    })

    expect(run.failures.map((failure) => failure.targetId)).toEqual(['broken-skills'])
    expect(run.results.map((result) => result.targetId)).toEqual(['stub-skills'])
    expect(await readFile(join(at.root, 'alpha', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY)
  })
})
