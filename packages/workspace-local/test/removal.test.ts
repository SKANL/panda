import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  LOCAL_WORKSPACE_RECORD_FILE as RECORD_FILE,
  LocalWorkspaceProvider,
  inspectLocalWorkspaces,
  removeLocalWorkspace,
} from '../src/index.ts'

// Spec M27.A, driven against a real filesystem. Nothing here is mocked: the
// workspaces are made by the shipped provider, the records are the bytes it
// wrote, and every claim about what survives a removal is a directory listing
// taken after the call.
//
// D2 IS THE WHOLE SUBJECT: a directory is removed if and ONLY if it holds a
// record panda wrote. Every refusal below is paired, in the same fixture and the
// same run, with the case that must go through — a function that refuses
// everything satisfies a lone refusal perfectly.

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function rootDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panda-workspace-local-removal-'))
  roots.push(root)
  return root
}

/** One workspace made the way a run makes one: through the shipped provider. */
async function madeByPanda(root: string): Promise<{ id: string; path: string }> {
  const handle = await new LocalWorkspaceProvider({ rootDir: root }).create()
  return { id: handle.id, path: handle.rootPath }
}

async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort()
}

describe('E4/E5 — the git-worktree store is not panda-local property (D2, measurement 3)', () => {
  it('refuses `trees`, and every worktree under it survives', async () => {
    const root = await rootDir()
    // The git-worktree provider's own worktrees, seeded with the SAME rootDir a
    // run seeds both providers with (`run-session.ts:364`). `acquire('trees')`
    // hands out a read+write handle for this directory, which is why a removal
    // keyed on a path would delete every worktree in the project.
    await mkdir(join(root, 'trees', 'w-1'), { recursive: true })
    await writeFile(join(root, 'trees', 'w-1', 'work.txt'), 'a users work\n', 'utf8')
    // The control, in the same fixture: a real local workspace, which MUST go.
    const mine = await madeByPanda(root)

    const refused = await removeLocalWorkspace(root, 'trees')

    expect(refused.kind).toBe('unknown')
    expect(await entries(join(root, 'trees'))).toEqual(['w-1'])
    expect(await entries(join(root, 'trees', 'w-1'))).toEqual(['work.txt'])
    // The control: the refusal above is D2 discriminating, not a dead function.
    expect((await removeLocalWorkspace(root, mine.id)).kind).toBe('removed')
    expect(await entries(root)).toEqual(['trees'])
  })

  it('refuses `records`, and the ownership proofs under it survive', async () => {
    const root = await rootDir()
    await mkdir(join(root, 'records'), { recursive: true })
    await writeFile(join(root, 'records', 'w-1.json'), '{"version":1,"id":"w-1"}\n', 'utf8')
    const mine = await madeByPanda(root)

    const refused = await removeLocalWorkspace(root, 'records')

    expect(refused.kind).toBe('unknown')
    expect(await entries(join(root, 'records'))).toEqual(['w-1.json'])
    expect((await removeLocalWorkspace(root, mine.id)).kind).toBe('removed')
    expect(await entries(root)).toEqual(['records'])
  })

  it('reports neither as a local workspace it holds', async () => {
    const root = await rootDir()
    await mkdir(join(root, 'trees', 'w-1'), { recursive: true })
    await mkdir(join(root, 'records'), { recursive: true })
    const mine = await madeByPanda(root)

    const inspection = await inspectLocalWorkspaces(root)

    expect(inspection.claimed.map((claim) => claim.id)).toEqual([mine.id])
    expect(inspection.unclaimed.map((entry) => entry.id)).toEqual(['records', 'trees'])
  })
})

describe('E9 — a run writes the record, so a workspace panda made is one it can name', () => {
  it('puts a parseable record inside the directory create() returns', async () => {
    const root = await rootDir()
    const made = await madeByPanda(root)

    const record = JSON.parse(await readFile(join(made.path, RECORD_FILE), 'utf8')) as {
      version: number
      id: string
      path: string
      createdAt: string
    }

    expect(record.version).toBe(1)
    expect(record.id).toBe(made.id)
    expect(record.path).toBe(made.path)
    expect(Number.isFinite(Date.parse(record.createdAt))).toBe(true)
    // The record is what makes the directory removable, and a crash mid-run
    // leaves exactly this state: a directory with a record, which E2 removes.
    expect((await removeLocalWorkspace(root, made.id)).kind).toBe('removed')
  })
})

describe('E1/E2 — two runs, then a removal that takes both back', () => {
  it('lists both as claimed and removes each with its record', async () => {
    const root = await rootDir()
    const first = await madeByPanda(root)
    const second = await madeByPanda(root)

    const before = await inspectLocalWorkspaces(root)
    expect(before.claimed.map((claim) => claim.id).sort()).toEqual([first.id, second.id].sort())
    expect(before.unclaimed).toEqual([])

    for (const workspace of [first, second]) {
      const outcome = await removeLocalWorkspace(root, workspace.id)
      expect(outcome.kind).toBe('removed')
      expect(outcome.path).toBe(workspace.path)
    }

    // E2: the directory and the record are gone TOGETHER — there is no sibling
    // store that could still hold a claim for either id.
    expect(await entries(root)).toEqual([])
    expect((await inspectLocalWorkspaces(root)).claimed).toEqual([])
  })
})

describe('E3 — a UUID-named directory panda did not make', () => {
  it('is reported unclaimed, is never removed, and its contents survive', async () => {
    const root = await rootDir()
    // Shaped EXACTLY like one of panda's own: same parent, a real v4 UUID name.
    // It is still not panda's, because what makes a workspace panda's is the
    // record and never the path (D2, AD-6).
    const foreign = randomUUID()
    await mkdir(join(root, foreign), { recursive: true })
    await writeFile(join(root, foreign, 'notes.md'), '# somebody elses work\n', 'utf8')
    const mine = await madeByPanda(root)

    const inspection = await inspectLocalWorkspaces(root)
    expect(inspection.claimed.map((claim) => claim.id)).toEqual([mine.id])
    expect(inspection.unclaimed.map((entry) => entry.id)).toEqual([foreign])
    // D5's vocabulary: panda names the path and says it predates its records.
    expect(inspection.unclaimed[0]?.detail).toContain('predates')

    const refused = await removeLocalWorkspace(root, foreign)
    expect(refused.kind).toBe('unknown')
    expect(refused.error?.code).toBe('PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID')
    expect(await entries(join(root, foreign))).toEqual(['notes.md'])
    // The control, same fixture, same run: a UUID directory panda DID make goes.
    expect((await removeLocalWorkspace(root, mine.id)).kind).toBe('removed')
  })
})

describe('E6 — a git worktree id belongs to the other store', () => {
  it('is unknown here, so the routing has exactly one store to give it to', async () => {
    const root = await rootDir()
    // The ids are disjoint by construction (D4): `w-<n>` versus a v4 UUID. This
    // store answering `unknown` is what lets `panda workspace remove w-1` route
    // to the worktree removal unambiguously.
    await mkdir(join(root, 'trees', 'w-1'), { recursive: true })
    const mine = await madeByPanda(root)

    expect((await removeLocalWorkspace(root, 'w-1')).kind).toBe('unknown')
    expect(await entries(join(root, 'trees'))).toEqual(['w-1'])
    expect((await removeLocalWorkspace(root, mine.id)).kind).toBe('removed')
  })

  it('refuses an id that is not a single path segment, before it reaches join()', async () => {
    const root = await rootDir()
    const sibling = join(root, '..', 'panda-removal-traversal-witness')
    await mkdir(sibling, { recursive: true })
    roots.push(sibling)

    for (const id of ['..', '../panda-removal-traversal-witness', '.', 'nul']) {
      const outcome = await removeLocalWorkspace(root, id)
      expect(outcome.kind, id).toBe('unknown')
    }
    expect(await entries(sibling)).toEqual([])
    expect((await lstat(sibling)).isDirectory()).toBe(true)
  })
})

describe('E7 — the root is swept, and everything in it is reported', () => {
  it('separates what panda holds from what it merely found', async () => {
    const root = await rootDir()
    const mine = await madeByPanda(root)
    const foreign = randomUUID()
    await mkdir(join(root, foreign), { recursive: true })
    await mkdir(join(root, 'trees', 'w-1'), { recursive: true })

    const inspection = await inspectLocalWorkspaces(root)

    expect(inspection.rootDir).toBe(resolve(root))
    expect(inspection.claimed).toEqual([{ id: mine.id, path: mine.path }])
    expect(inspection.unclaimed.map((entry) => entry.id).sort()).toEqual([foreign, 'trees'].sort())
    // A sweep REPORTS; it removes nothing on its own. Removal is a decision.
    expect(await entries(root)).toEqual([foreign, mine.id, 'trees'].sort())
  })
})

describe('E8 — a record panda cannot use is not a record panda may ignore', () => {
  it('refuses, names the path, and leaves the directory exactly as it was', async () => {
    const root = await rootDir()
    const corrupt = await madeByPanda(root)
    await writeFile(join(corrupt.path, RECORD_FILE), 'not json at all\n', 'utf8')
    await writeFile(join(corrupt.path, 'work.txt'), 'a users work\n', 'utf8')
    const control = await madeByPanda(root)

    const refused = await removeLocalWorkspace(root, corrupt.id)

    expect(refused.kind).toBe('refused')
    expect(refused.detail).toContain(join(corrupt.path, RECORD_FILE))
    expect(refused.error?.code).toBe('PANDA_CONTRACT_WORKSPACE_REMOVAL_REFUSED')
    expect(await entries(corrupt.path)).toEqual([RECORD_FILE, 'work.txt'].sort())
    // Reported too, and NOT with the same sentence an unrecorded directory gets.
    const inspection = await inspectLocalWorkspaces(root)
    expect(inspection.claimed.map((claim) => claim.id)).toEqual([control.id])
    expect(inspection.unclaimed.map((entry) => entry.id)).toEqual([corrupt.id])
    expect(inspection.unclaimed[0]?.detail).toContain('present and unusable')

    // The control: a readable record in the same root still goes.
    expect((await removeLocalWorkspace(root, control.id)).kind).toBe('removed')
  })

  it('refuses a well-formed record that claims a different id', async () => {
    const root = await rootDir()
    const impostor = await madeByPanda(root)
    const control = await madeByPanda(root)
    // The proof has to be proof about THIS directory. A record copied out of
    // another workspace claims another id, and claiming is all it does.
    await writeFile(
      join(impostor.path, RECORD_FILE),
      await readFile(join(control.path, RECORD_FILE), 'utf8'),
      'utf8',
    )

    const refused = await removeLocalWorkspace(root, impostor.id)

    expect(refused.kind).toBe('refused')
    expect(refused.detail).toContain(control.id)
    expect(await entries(root)).toEqual([impostor.id, control.id].sort())
    expect((await removeLocalWorkspace(root, control.id)).kind).toBe('removed')
  })
})

describe('a symlink under the root is not a workspace, however it is named', () => {
  it('is never followed and never removed', async () => {
    const root = await rootDir()
    const target = await rootDir()
    await writeFile(join(target, 'work.txt'), 'a users work\n', 'utf8')
    // A record at the symlink TARGET would make a `stat`-based removal follow it
    // out of panda's root. `acquire()` classifies a symlink unknown; so does this.
    await writeFile(
      join(target, RECORD_FILE),
      `${JSON.stringify({ version: 1, id: 'linked', path: target, createdAt: new Date().toISOString() })}\n`,
      'utf8',
    )
    // `junction` so this needs no privilege on Windows; the type is ignored on
    // POSIX. A failure here fails the clause rather than skipping it silently —
    // a skip would report "panda refused" for a link that was never created.
    await symlink(target, join(root, 'linked'), 'junction')
    expect((await lstat(join(root, 'linked'))).isSymbolicLink()).toBe(true)

    const outcome = await removeLocalWorkspace(root, 'linked')

    expect(outcome.kind).toBe('unknown')
    expect(await entries(target)).toEqual([RECORD_FILE, 'work.txt'].sort())
    expect((await inspectLocalWorkspaces(root)).claimed).toEqual([])
  })
})
