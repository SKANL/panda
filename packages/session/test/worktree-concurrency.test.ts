import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { ExecutorAdapter, WorkspaceHandle } from '@skanl/panda-contracts'
import { readExecutorConfigLayers } from '../src/executors.ts'
import { runSession } from '../src/run-session.ts'

// AC clause 1 of Story 4.2, in the only shape the ledger makes deterministic:
// two sessions, ONE process, ONE state directory. `LEDGER_QUEUES` in
// `@skanl/panda-workspace-git-worktree` is module-level, so two providers constructed
// over the same directory share one read-modify-write queue and cannot reserve
// the same ordinal. Two panda PROCESSES over one state directory are a named,
// coded boundary rather than a gap this story closes — see `deferred-work.md`.

const run = promisify(execFile)

const GIT_TIMEOUT_MS = 120_000
const BARRIER_BUDGET_MS = 60_000

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

async function gitFixture(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'panda-session-worktree-'))
  await run('git', ['init', '--quiet', repoPath])
  await run('git', ['-C', repoPath, 'config', 'user.email', 'test@panda.local'])
  await run('git', ['-C', repoPath, 'config', 'user.name', 'panda test'])
  await writeFile(join(repoPath, 'README.md'), '# fixture\n', 'utf8')
  await run('git', ['-C', repoPath, 'add', 'README.md'])
  await run('git', ['-C', repoPath, 'commit', '--quiet', '-m', 'fixture'])
  await mkdir(join(repoPath, '.panda'), { recursive: true })
  await writeFile(
    join(repoPath, '.panda', 'config.json'),
    `${JSON.stringify({ workspace: { provider: 'git-worktree' } })}\n`,
    'utf8',
  )
  return repoPath
}

/** A promise that fails by NAME rather than by the runner's timeout. */
function withDeadline<T>(attempt: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    attempt,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not happen within ${BARRIER_BUDGET_MS}ms`)), BARRIER_BUDGET_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

describe('two concurrent sessions over one state directory', () => {
  it(
    'run in two distinct worktrees at the same time, with no contention error',
    { timeout: GIT_TIMEOUT_MS },
    async () => {
      const repoPath = await gitFixture()
      const configLayers = await readExecutorConfigLayers({ projectDir: repoPath })

      // The ordering is FORCED, not raced. Each session's adapter announces its
      // arrival and then blocks until BOTH have arrived, so neither run can
      // release its lease or stop its kernel while the other is still starting.
      // The same shape `packages/registry/test/contention.test.ts` uses for its
      // cross-process holder — a signal waited on against a deadline, never a
      // sleep — with an in-process promise standing in for the ready file
      // because both halves are in this process by construction.
      const arrived: WorkspaceHandle[] = []
      let openTheGate: () => void = () => {}
      const bothArrived = new Promise<void>((resolve) => {
        openTheGate = resolve
      })
      // Read while BOTH sessions are provably live. Measured after either one
      // finished, this assertion would still pass against a provider that
      // reused one worktree serially — which is the regression it exists to
      // catch.
      let listedWhileBothLive: readonly string[] = []

      const barrierAdapter = (): ExecutorAdapter => ({
        async run(request) {
          arrived.push(request.workspace)
          if (arrived.length === 2) {
            listedWhileBothLive = await worktreePaths(repoPath)
            openTheGate()
          }
          await withDeadline(bothArrived, 'the second session')
          return { status: 'ok', data: null, summary: 'ran', errors: [] }
        },
      })

      const envelopes = await Promise.all([
        runSession({ prompt: 'first', cwd: repoPath, configLayers, createAdapter: barrierAdapter }),
        runSession({ prompt: 'second', cwd: repoPath, configLayers, createAdapter: barrierAdapter }),
      ])

      expect(envelopes.map((envelope) => envelope.status)).toEqual(['ok', 'ok'])
      expect(arrived).toHaveLength(2)

      const [first, second] = arrived
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      // Two distinct ids, from one monotonic ordinal: names are retired
      // permanently, so a shared queue that handed out the same one would show
      // up here before it showed up on disk.
      expect(first!.id).not.toBe(second!.id)
      expect([first!.id, second!.id].sort()).toEqual(['w-0', 'w-1'])
      expect(sameDirectory(first!.rootPath)).not.toBe(sameDirectory(second!.rootPath))

      // Two distinct entries in git's OWN listing, both present at the instant
      // both sessions were inside their run.
      expect(listedWhileBothLive).toContain(sameDirectory(first!.rootPath))
      expect(listedWhileBothLive).toContain(sameDirectory(second!.rootPath))
    },
  )
})
