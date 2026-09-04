import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitWorktreeWorkspaceProvider, WorktreeLedger, inspectWorktrees, removeWorktree } from '../src/index.ts'

// Story 4.3 / spec M16.A, driven against REAL git. Nothing here is mocked: the
// repositories are real, the worktrees are real `git worktree` checkouts made by
// the shipped provider, and every claim about what git does is git's answer in
// this process rather than a sentence copied out of a spec.
//
// Every absence carries its control. "Panda refused" proves nothing on its own —
// a function that refuses everything satisfies it — so each refusal below is
// paired, in the same run and against the same fixture, with the case that must
// go through.

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 120_000

interface Fixture {
  readonly repoPath: string
  readonly stateDir: string
  readonly provider: GitWorktreeWorkspaceProvider
  readonly ledger: WorktreeLedger
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'panda-wt-removal-'))
  const repoPath = join(root, 'repo')
  await mkdir(repoPath, { recursive: true })
  await run('git', ['init', '--quiet', repoPath])
  await run('git', ['-C', repoPath, 'config', 'user.email', 'test@panda.local'])
  await run('git', ['-C', repoPath, 'config', 'user.name', 'panda test'])
  await writeFile(join(repoPath, 'README.md'), '# fixture\n', 'utf8')
  await run('git', ['-C', repoPath, 'add', 'README.md'])
  await run('git', ['-C', repoPath, 'commit', '--quiet', '-m', 'fixture'])
  const stateDir = join(repoPath, '.panda', 'workspaces')
  return {
    repoPath,
    stateDir,
    provider: new GitWorktreeWorkspaceProvider({ repoPath, stateDir }),
    ledger: new WorktreeLedger(stateDir),
  }
}

/** git's OWN vocabulary for what it holds (correction-01 C5, AC5). */
async function worktreePaths(repoPath: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).replaceAll('\\', '/').toLowerCase())
}

function names(paths: readonly string[], candidate: string): boolean {
  return paths.includes(candidate.replaceAll('\\', '/').toLowerCase())
}

/** A commit made INSIDE the worktree, on its detached HEAD. Returns the sha. */
async function commitInside(treePath: string, message: string): Promise<string> {
  await writeFile(join(treePath, 'work.txt'), `${message}\n`, 'utf8')
  await run('git', ['-C', treePath, 'add', 'work.txt'])
  await run('git', ['-C', treePath, 'commit', '--quiet', '-m', message])
  const { stdout } = await run('git', ['-C', treePath, 'rev-parse', 'HEAD'])
  return stdout.trim()
}

async function recordFiles(stateDir: string): Promise<string[]> {
  try {
    return (await readdir(join(stateDir, 'records'))).sort()
  } catch {
    return []
  }
}

describe('a commit made inside a panda worktree is never lost (AC1)', () => {
  it(
    'REFUSES naming the commit, and in the same run removes the identical tree at a reachable commit',
    { timeout: GIT_TIMEOUT_MS },
    async () => {
      const { repoPath, stateDir, provider } = await fixture()
      const carrying = await provider.create()
      const control = await provider.create()

      // The hazard: a commit on the detached HEAD, reachable from no ref. git's
      // own answer is asserted here rather than assumed, because the whole story
      // rests on it: `git worktree remove` would take this silently.
      const orphan = await commitInside(carrying.rootPath, 'work that exists nowhere else')
      const { stdout: containing } = await run('git', ['-C', repoPath, 'branch', '--contains', orphan])
      expect(containing.trim(), 'the fixture did not produce an unreachable commit').toBe('')

      const refused = await removeWorktree(stateDir, carrying.id)
      expect(refused.kind).toBe('refused')
      expect(refused.error?.code).toBe('PANDA_CONTRACT_WORKSPACE_REMOVAL_REFUSED')
      expect(refused.detail).toContain(orphan)
      // Nothing moved: the tree, git's registration and the record are all there.
      expect(names(await worktreePaths(repoPath), carrying.rootPath)).toBe(true)
      expect(await recordFiles(stateDir)).toContain(`${carrying.id}.json`)
      // And no marker was left behind, because a refusal is not an interruption.
      expect(await recordFiles(stateDir)).not.toContain(`${carrying.id}.removing.json`)

      // THE CONTROL, same run, same fixture: the same shape of tree at a commit
      // a ref DOES contain is removed. Without this the clause above proves only
      // that this function refuses.
      const removed = await removeWorktree(stateDir, control.id)
      expect(removed.kind, JSON.stringify(removed)).toBe('removed')
      expect(names(await worktreePaths(repoPath), control.rootPath)).toBe(false)
      expect(await recordFiles(stateDir)).not.toContain(`${control.id}.json`)
    },
  )

  it(
    'takes a tree whose commit only a TAG contains — the plant that reddens branch --contains',
    { timeout: GIT_TIMEOUT_MS },
    async () => {
      // The shape the check was not designed around. `git branch --contains` is
      // the obvious spelling and the spec's own measurement used it; against a
      // commit kept alive by a tag it answers "no branch" and panda would refuse
      // a removal that loses nothing. The check uses `for-each-ref` instead, and
      // this is what tells the two apart.
      const { repoPath, stateDir, provider } = await fixture()
      const tagged = await provider.create()
      const sha = await commitInside(tagged.rootPath, 'kept alive by a tag')
      await run('git', ['-C', repoPath, 'tag', 'keeper', sha])
      const { stdout: branches } = await run('git', ['-C', repoPath, 'branch', '--contains', sha])
      expect(branches.trim(), 'the plant is only interesting while no branch contains it').toBe('')

      const outcome = await removeWorktree(stateDir, tagged.id)
      expect(outcome.kind, JSON.stringify(outcome)).toBe('removed')
      expect(names(await worktreePaths(repoPath), tagged.rootPath)).toBe(false)
      // The commit itself survives, which is the point: nothing was lost.
      await expect(run('git', ['-C', repoPath, 'cat-file', '-e', `${sha}^{commit}`])).resolves.toBeDefined()
    },
  )
})

describe('git keeps its own refusals, and panda surfaces them (E2)', () => {
  it('reports git`s sentence for a dirty tree and changes nothing', { timeout: GIT_TIMEOUT_MS }, async () => {
    const { repoPath, stateDir, provider } = await fixture()
    const dirty = await provider.create()
    await writeFile(join(dirty.rootPath, 'untracked.txt'), 'mine\n', 'utf8')

    const outcome = await removeWorktree(stateDir, dirty.id)
    expect(outcome.kind).toBe('refused')
    // git's OWN words, not a translation of them.
    expect(outcome.detail).toContain('contains modified or untracked files')
    expect(names(await worktreePaths(repoPath), dirty.rootPath)).toBe(true)
    expect(await recordFiles(stateDir)).toEqual([`${dirty.id}.json`])
  })
})

describe('panda removes nothing it does not own (AC3 / D2 / E5)', () => {
  it(
    'leaves a directory shaped EXACTLY like a panda worktree, with no record, and reports it',
    { timeout: GIT_TIMEOUT_MS },
    async () => {
      const { repoPath, stateDir, provider } = await fixture()
      const owned = await provider.create()
      // Shaped exactly like panda's: same parent, the same `w-<n>` naming, and a
      // REAL git worktree of the same repository inside it. Everything about it
      // says panda except the one thing that decides — the ownership record.
      const impostorPath = join(stateDir, 'trees', 'w-4242')
      await run('git', ['-C', repoPath, 'worktree', 'add', '--detach', impostorPath])

      const inspection = await inspectWorktrees(stateDir)
      expect(inspection.unclaimed.map((entry) => entry.id)).toEqual(['w-4242'])
      expect(inspection.claimed.map((entry) => entry.id)).toEqual([owned.id])

      const outcome = await removeWorktree(stateDir, 'w-4242')
      expect(outcome.kind).toBe('unknown')
      expect(outcome.error?.code).toBe('PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID')
      // It survives, and git still knows it.
      expect(names(await worktreePaths(repoPath), impostorPath)).toBe(true)
      expect((await readdir(join(stateDir, 'trees'))).sort()).toEqual([owned.id, 'w-4242'].sort())
    },
  )

  it('refuses an id that tries to leave the records directory', async () => {
    const { stateDir } = await fixture()
    for (const hostile of ['../../etc', '..', 'w-1/../../x', '']) {
      const outcome = await removeWorktree(stateDir, hostile)
      expect(outcome.kind, hostile).toBe('unknown')
    }
  })
})

describe('the ordinal is never reused (AC4 / D5)', () => {
  it('issues a HIGHER ordinal after a removal, never the retired one', { timeout: GIT_TIMEOUT_MS }, async () => {
    const { stateDir, provider } = await fixture()
    const first = await provider.create()
    expect(first.id).toBe('w-0')
    expect((await removeWorktree(stateDir, first.id)).kind).toBe('removed')

    const next = await provider.create()
    expect(next.id).not.toBe(first.id)
    expect(Number(next.id.slice('w-'.length))).toBeGreaterThan(Number(first.id.slice('w-'.length)))
    // And the ledger's counter did not go backwards either.
    expect((await new WorktreeLedger(stateDir).reserveOrdinal()) > 1).toBe(true)
  })
})

describe('the tails of an interrupted removal (E6 / E9 / E10)', () => {
  it('retires a record whose tree is already gone, without erroring (E6)', { timeout: GIT_TIMEOUT_MS }, async () => {
    const { repoPath, stateDir, provider } = await fixture()
    const handle = await provider.create()
    // Exactly what a completed `git worktree remove` leaves if panda died before
    // retiring: git no longer knows the path and the directory is gone.
    await run('git', ['-C', repoPath, 'worktree', 'remove', handle.rootPath])

    const outcome = await removeWorktree(stateDir, handle.id)
    expect(outcome.kind, JSON.stringify(outcome)).toBe('retired')
    expect(outcome.error).toBeUndefined()
    expect(await recordFiles(stateDir)).toEqual([])
  })

  it('reports the repository path when the repository is gone, and attempts nothing (E9)', { timeout: GIT_TIMEOUT_MS }, async () => {
    const { repoPath, stateDir, provider } = await fixture()
    const handle = await provider.create()
    // The state directory lives inside the repository, so the record is copied
    // to a store that survives the repository going away.
    const orphanState = await mkdtemp(join(tmpdir(), 'panda-wt-orphan-'))
    const record = await new WorktreeLedger(stateDir).readRecord(handle.id)
    expect(record).toBeDefined()
    await new WorktreeLedger(orphanState).writeRecord(record!)
    await rm(repoPath, { recursive: true, force: true })

    const outcome = await removeWorktree(orphanState, handle.id)
    expect(outcome.kind).toBe('refused')
    expect(outcome.error?.code).toBe('PANDA_CONTRACT_WORKSPACE_REMOVAL_REFUSED')
    expect(outcome.detail).toContain(record!.repoPath)
    // The record is untouched: panda reported, it did not act.
    expect(await recordFiles(orphanState)).toEqual([`${handle.id}.json`])
  })

  it('gives the loser of two removals a coded refusal naming the holder (E10)', { timeout: GIT_TIMEOUT_MS }, async () => {
    const { stateDir, provider } = await fixture()
    const handle = await provider.create()
    const ledger = new WorktreeLedger(stateDir)
    // A live holder: this very process, which is exactly what the winner of a
    // real race would have written.
    const held = await ledger.claimRemoval(handle.id)
    expect(held.pid).toBe(process.pid)

    const loser = await removeWorktree(stateDir, handle.id)
    expect(loser.kind).toBe('refused')
    expect(loser.error?.code).toBe('PANDA_CONTRACT_WORKSPACE_CONTENTION')
    expect(loser.detail).toContain(`${process.pid}@${hostname()}`)

    // THE CONTROL: with the holder gone the same call goes through, so the
    // clause above is about contention and not about this id being unremovable.
    await ledger.releaseClaim(handle.id)
    expect((await removeWorktree(stateDir, handle.id)).kind).toBe('removed')
  })
})
