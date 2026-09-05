import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PandaError } from '@skanl/panda-contracts'
import { GitWorktreeWorkspaceProvider, WorktreeLedger } from '../src'

const run = promisify(execFile)

const root = await mkdtemp(join(tmpdir(), 'panda-worktree-provider-'))
// `maxRetries`: a worktree directory git has just finished writing can still
// hold an open handle on Windows, and a bare `rm` fails the whole file with
// EBUSY. See the contract suite's copy of this note.
afterAll(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

async function makeRepo(name: string): Promise<string> {
  const repoPath = join(root, name)
  await run('git', ['init', '--quiet', repoPath])
  await run('git', ['-C', repoPath, 'config', 'user.email', 'test@panda.local'])
  await run('git', ['-C', repoPath, 'config', 'user.name', 'panda test'])
  await writeFile(join(repoPath, 'README.md'), '# fixture\n', 'utf8')
  await run('git', ['-C', repoPath, 'add', 'README.md'])
  await run('git', ['-C', repoPath, 'commit', '--quiet', '-m', 'fixture'])
  return repoPath
}

const repoPath = await makeRepo('repo')

let counter = 0
let stateDir: string
beforeEach(() => {
  stateDir = join(root, `state-${(counter += 1)}`)
})

function provider(): GitWorktreeWorkspaceProvider {
  return new GitWorktreeWorkspaceProvider({ repoPath, stateDir })
}

async function codeOf(action: Promise<unknown>): Promise<string> {
  try {
    await action
    return 'RESOLVED — expected a rejection'
  } catch (error) {
    return error instanceof PandaError ? error.code : `uncoded: ${String(error)}`
  }
}

describe('creation and ownership', () => {
  // Matrix row 1 + 2.
  it('creates real, distinct worktrees and records ownership for each', async () => {
    const subject = provider()
    const first = await subject.create()
    const second = await subject.create()

    expect(first.id).not.toBe(second.id)
    expect(first.rootPath).not.toBe(second.rootPath)

    // The tree is a real checkout, not just a directory. Compared without the
    // line ending: git's `core.autocrlf` rewrites it on checkout on Windows, and
    // what this asserts is that the file was checked out at all.
    expect(await readFile(join(first.rootPath, 'README.md'), 'utf8')).toContain('# fixture')

    // Git prints worktree paths with forward slashes even on Windows, where
    // `join` produced backslashes. Both spellings name the same directory, so
    // the comparison is made in one of them.
    const listing = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])
    const registered = listing.stdout.replaceAll('\\', '/')
    expect(registered).toContain(first.rootPath.replaceAll('\\', '/'))
    expect(registered).toContain(second.rootPath.replaceAll('\\', '/'))

    const record = await new WorktreeLedger(stateDir).readRecord(first.id)
    expect(record?.path).toBe(first.rootPath)
    expect(record?.repoPath).toBe(repoPath)
  })

  // Matrix row 13 — the reason a workspace is worth having at all.
  it('keeps state written into a worktree across release and re-acquire', async () => {
    const subject = provider()
    const handle = await subject.create()
    await writeFile(join(handle.rootPath, 'work.txt'), 'in progress', 'utf8')
    await subject.release(handle)

    const reacquired = await new GitWorktreeWorkspaceProvider({ repoPath, stateDir }).acquire(handle.id)
    expect(reacquired.rootPath).toBe(handle.rootPath)
    await expect(readFile(join(reacquired.rootPath, 'work.txt'), 'utf8')).resolves.toBe('in progress')
  })
})

describe('names are retired permanently (FR-18, AD-6)', () => {
  // Matrix row 3. The guard is the monotonic ordinal; remove it and this fails.
  it('never reissues the name of a worktree that has been removed', async () => {
    const subject = provider()
    const first = await subject.create()

    // Remove the tree the way a user would, and drop panda's record with it, so
    // nothing but the ledger's counter can prevent the name coming back.
    await run('git', ['-C', repoPath, 'worktree', 'remove', '--force', first.rootPath])
    await rm(join(stateDir, 'records', `${first.id}.json`), { force: true })

    const second = await subject.create()
    expect(second.id).not.toBe(first.id)
    expect(second.rootPath).not.toBe(first.rootPath)
  })

  // Matrix row 4 — the crash window. Reserving is what a create that died right
  // after reservation leaves behind; the leaked ordinal must never be issued.
  it('never issues an ordinal that a crashed create had already reserved', async () => {
    const leaked = await new WorktreeLedger(stateDir).reserveOrdinal()

    const handle = await provider().create()
    expect(handle.id).not.toBe(`w-${leaked}`)

    const ledger: unknown = JSON.parse(await readFile(join(stateDir, 'worktrees.json'), 'utf8'))
    expect((ledger as { nextOrdinal: number }).nextOrdinal).toBeGreaterThan(leaked + 1)
  })

  // Matrix row 16. Two provider INSTANCES over one state directory are the pair
  // the module-level queue exists for — an instance-level queue would let both
  // read the same counter.
  it('gives concurrent creates on separate instances distinct names', async () => {
    const [a, b] = await Promise.all([
      new GitWorktreeWorkspaceProvider({ repoPath, stateDir }).create(),
      new GitWorktreeWorkspaceProvider({ repoPath, stateDir }).create(),
    ])
    expect(a.id).not.toBe(b.id)
    expect(a.rootPath).not.toBe(b.rootPath)
  })
})

describe('a directory panda cannot prove it created is external', () => {
  // Matrix row 6 — the "never auto-modified" clause, executable.
  it('refuses a directory in the trees folder that carries no record, and leaves it alone', async () => {
    const intruder = join(stateDir, 'trees', 'w-99')
    await mkdir(intruder, { recursive: true })
    await writeFile(join(intruder, 'someone-elses.txt'), 'not panda', 'utf8')

    expect(await codeOf(provider().acquire('w-99'))).toBe('PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID')

    // Untouched: the file is still there and panda wrote no record claiming it.
    await expect(readFile(join(intruder, 'someone-elses.txt'), 'utf8')).resolves.toBe('not panda')
    await expect(readFile(join(stateDir, 'records', 'w-99.json'), 'utf8')).rejects.toThrow()
  })

  // Matrix rows 7 and 8 — an id that was never issued, and ids shaped to escape.
  it('refuses ids that were never issued, including traversal and device names', async () => {
    const subject = provider()
    for (const id of ['w-404', '../../etc', '/etc/passwd', 'nul', '.', '..']) {
      expect(await codeOf(subject.acquire(id)), id).toBe('PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID')
    }
  })
})

describe('failures are reported, never guessed at', () => {
  // Matrix row 15 — the silent one. Falling back to ordinal 0 here would reissue
  // every name the store ever handed out.
  it('refuses a malformed ledger instead of restarting the counter', async () => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'worktrees.json'), '{ not json at all', 'utf8')

    expect(await codeOf(provider().create())).toBe('PANDA_CONTRACT_WORKSPACE_UNAVAILABLE')
  })

  it('refuses a ledger whose counter is not a usable ordinal', async () => {
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'worktrees.json'), '{"version":1,"nextOrdinal":-3}', 'utf8')

    expect(await codeOf(provider().create())).toBe('PANDA_CONTRACT_WORKSPACE_UNAVAILABLE')
  })

  // A corrupt record must not read as "panda never made this".
  it('refuses a corrupt ownership record instead of classifying it external', async () => {
    const subject = provider()
    const handle = await subject.create()
    await writeFile(join(stateDir, 'records', `${handle.id}.json`), 'corrupted', 'utf8')

    expect(await codeOf(subject.acquire(handle.id))).toBe('PANDA_CONTRACT_WORKSPACE_UNAVAILABLE')
  })

  // Matrix row 14 — git itself cannot deliver.
  it('reports a repository git will not cut a worktree from as unavailable', async () => {
    const notARepo = join(root, 'not-a-repo')
    await mkdir(notARepo, { recursive: true })

    const subject = new GitWorktreeWorkspaceProvider({ repoPath: notARepo, stateDir })
    expect(await codeOf(subject.create())).toBe('PANDA_CONTRACT_WORKSPACE_UNAVAILABLE')
  })
})
