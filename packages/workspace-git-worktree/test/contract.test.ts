import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { WORKSPACE_CLAUSES, runWorkspaceContractSuite } from '@skanl/panda-contracts'
import { GitWorktreeWorkspaceProvider } from '../src'

const run = promisify(execFile)

const root = await mkdtemp(join(tmpdir(), 'panda-worktree-contract-'))
// `maxRetries` is load-bearing on Windows, not defensive padding: a worktree
// directory git has just finished writing can still hold an open handle when
// the suite ends, and the bare `rm` fails the whole file with EBUSY. Measured
// under `pnpm check`, where the packages run concurrently and the window is
// widest.
afterAll(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

/**
 * A real repository with a real commit. `git worktree add` has nothing to check
 * out of a repository with no commits, so a fixture without one would fail every
 * clause for a reason that has nothing to do with the provider.
 */
const repoPath = join(root, 'repo')
await run('git', ['init', '--quiet', repoPath])
await run('git', ['-C', repoPath, 'config', 'user.email', 'test@panda.local'])
await run('git', ['-C', repoPath, 'config', 'user.name', 'panda test'])
await writeFile(join(repoPath, 'README.md'), '# fixture\n', 'utf8')
await run('git', ['-C', repoPath, 'add', 'README.md'])
await run('git', ['-C', repoPath, 'commit', '--quiet', '-m', 'fixture'])

let suiteRun = 0
function subject(): GitWorktreeWorkspaceProvider {
  // A fresh state directory per construction: several clauses dispose the
  // provider they are handed, and two clauses sharing one ledger would make the
  // per-clause run depend on the aggregate run having gone first.
  return new GitWorktreeWorkspaceProvider({
    repoPath,
    stateDir: join(root, `state-${(suiteRun += 1)}`),
  })
}

describe('GitWorktreeWorkspaceProvider against the workspace contract suite', () => {
  it('passes every clause in the aggregate run', async () => {
    const report = await runWorkspaceContractSuite(subject())
    expect(report.suite).toBe('workspace-provider')
    expect(report.clauses).toEqual(WORKSPACE_CLAUSES.map((clause) => clause.name))
    expect(report.violations).toEqual([])
    expect(report.passed).toBe(true)
  })

  // Running each clause against a provider of its own is what keeps a per-clause
  // verdict from depending on the aggregate run having gone first. It also means
  // this one test spawns a couple of dozen git processes; see the package's
  // vitest config for why the timeout is where it is.
  it('passes each clause independently by name', async () => {
    for (const clause of WORKSPACE_CLAUSES) {
      const outcome = await clause.check(subject())
      expect(outcome.ok, `${clause.name} failed: ${outcome.detail ?? ''}`).toBe(true)
    }
  })
})
