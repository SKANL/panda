import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { ExecutorAdapter, WorkspaceHandle } from '@panda/contracts'
import { runPanda } from '../src'
import type { RunCommandOptions } from '../src'

// Story 4.2's reachability claim, at the binary: a repository whose own
// `.panda/config.json` selects `git-worktree` runs its session inside a REAL
// `git worktree`, and git itself is the witness.
//
// A UUID directory under `.panda/workspaces` is not a worktree entry, so the
// second test here is not decoration: it is the control that makes the first
// one falsifiable. Delete the mount in `run-session.ts` and the first test fails
// while the second still passes.

const run = promisify(execFile)

const GIT_TIMEOUT_MS = 60_000

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: (line) => out.push(line), stderr: (line) => err.push(line), out, err }
}

/**
 * An adapter that answers `ok` and records the workspace it was handed.
 *
 * The handle is the only place the session's workspace path is observable from
 * outside, and it is the production path: `runSession` passes the handle it
 * created straight into the executor's `RunRequest`.
 */
function capturingAdapter(seen: WorkspaceHandle[]): ExecutorAdapter {
  return {
    async run(request) {
      seen.push(request.workspace)
      return { status: 'ok', data: null, summary: 'ran', errors: [] }
    },
  }
}

/** A real repository with a real commit — `git worktree add` needs something to check out. */
async function gitFixture(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'panda-cli-worktree-'))
  await run('git', ['init', '--quiet', repoPath])
  await run('git', ['-C', repoPath, 'config', 'user.email', 'test@panda.local'])
  await run('git', ['-C', repoPath, 'config', 'user.name', 'panda test'])
  await writeFile(join(repoPath, 'README.md'), '# fixture\n', 'utf8')
  await run('git', ['-C', repoPath, 'add', 'README.md'])
  await run('git', ['-C', repoPath, 'commit', '--quiet', '-m', 'fixture'])
  return repoPath
}

async function writeProjectConfig(repoPath: string, document: unknown): Promise<void> {
  await mkdir(join(repoPath, '.panda'), { recursive: true })
  await writeFile(join(repoPath, '.panda', 'config.json'), `${JSON.stringify(document)}\n`, 'utf8')
}

/**
 * `realpathSync.native` on both sides, then one spelling.
 *
 * git prints `C:/Users/...` with forward slashes and its own idea of the real
 * path, where `path.join` produces backslashes and whatever `mkdtemp` handed
 * back — which on Windows can still be an 8.3 alias. Comparing the raw strings
 * is a test that fails for the spelling rather than for the fact.
 */
function sameDirectory(path: string): string {
  return realpathSync.native(path).replaceAll('\\', '/').toLowerCase()
}

async function worktreePaths(repoPath: string): Promise<string[]> {
  const { stdout } = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => sameDirectory(line.slice('worktree '.length)))
}

describe('panda run in a repository that selects the git-worktree provider', () => {
  it('runs the session inside a real git worktree of that repository', { timeout: GIT_TIMEOUT_MS }, async () => {
    const repoPath = await gitFixture()
    await writeProjectConfig(repoPath, { workspace: { provider: 'git-worktree' } })

    const seen: WorkspaceHandle[] = []
    const io = capture()
    const code = await runPanda(['run', 'work in a worktree'], {
      ...io,
      cwd: repoPath,
      createAdapter: () => capturingAdapter(seen),
    })

    expect(code).toBe(0)
    expect(seen).toHaveLength(1)
    const handle = seen[0]
    expect(handle).toBeDefined()
    // git's OWN answer, not panda's: the whole point of the story is that this
    // path is a checkout git knows about, not a directory panda made.
    expect(await worktreePaths(repoPath)).toContain(sameDirectory(handle!.rootPath))
    // The ledger's ordinal naming, so a regression that mounted the local
    // provider under a git-worktree-shaped path would still be caught.
    expect(handle!.id).toMatch(/^w-\d+$/)
  })

  it('does NOT create a worktree entry when nothing selects a provider (the control)', { timeout: GIT_TIMEOUT_MS }, async () => {
    const repoPath = await gitFixture()

    const seen: WorkspaceHandle[] = []
    const io = capture()
    const code = await runPanda(['run', 'work locally'], {
      ...io,
      cwd: repoPath,
      createAdapter: () => capturingAdapter(seen),
    })

    expect(code).toBe(0)
    const handle = seen[0]
    expect(handle).toBeDefined()
    // The default did not change for an existing user (matrix row 1): a UUID
    // directory under `.panda/workspaces`, and git has never heard of it.
    expect(handle!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await worktreePaths(repoPath)).not.toContain(sameDirectory(handle!.rootPath))
  })
})
