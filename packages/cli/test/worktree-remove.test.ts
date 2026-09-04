import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { inspectWorktrees, worktreeStateDir } from '@panda/session'
import { runPanda } from '../src/run.ts'
import type { RunCommandOptions } from '../src/run.ts'
import type { Diagnosis } from '@panda/environment'
import type { WorkspaceHandle } from '@panda/contracts'

// Spec M16.A at the BINARY: the verb a user actually reaches, driven against
// real git and real worktrees the shipped provider made.
//
// The interruption in the third block is a real one — a separate process,
// SIGKILLed mid-removal by the appearance of its own durable intent marker — and
// the sweep that resolves it is `panda workspace remove` with no id, which calls
// the identical removal the killed process was running.

const run = promisify(execFile)
const GIT_TIMEOUT_MS = 180_000

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: (line) => out.push(line), stderr: (line) => err.push(line), out, err }
}

/** A repository whose own document selects the git-worktree provider. */
async function project(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'panda-cli-wt-remove-'))
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

/**
 * A worktree made the way a run makes one, because it IS a run: `panda run`
 * against an adapter that spawns nothing. Constructing the provider directly
 * would be a second creation path, and `@panda/cli` cannot reach it anyway —
 * the thin-binding pin keeps the implementation packages out of this package
 * entirely, tests included.
 */
async function makeWorktree(repoPath: string): Promise<{ id: string; path: string }> {
  const seen: WorkspaceHandle[] = []
  const io = capture()
  const code = await runPanda(['run', 'make a worktree'], {
    ...io,
    cwd: repoPath,
    createAdapter: () => ({
      async run(request) {
        seen.push(request.workspace)
        return { status: 'ok', data: null, summary: 'inert', errors: [] }
      },
    }),
  })
  expect(code, io.err.join(String.fromCharCode(10))).toBe(0)
  const handle = seen[0]
  expect(handle, 'the run produced no workspace handle').toBeDefined()
  expect(handle!.id).toMatch(/^w-\d+$/)
  return { id: handle!.id, path: handle!.rootPath }
}

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

async function records(repoPath: string): Promise<string[]> {
  try {
    return (await readdir(join(worktreeStateDir(repoPath), 'records'))).sort()
  } catch {
    return []
  }
}

describe('panda workspace remove <id>', () => {
  it('removes the tree, retires the record, and git stops naming it (AC5)', { timeout: GIT_TIMEOUT_MS }, async () => {
    const repoPath = await project()
    const worktree = await makeWorktree(repoPath)
    expect(names(await worktreePaths(repoPath), worktree.path)).toBe(true)

    const io = capture()
    const code = await runPanda(['workspace', 'remove', worktree.id], { ...io, cwd: repoPath })

    expect(code, io.err.join('\n')).toBe(0)
    // git's OWN vocabulary is the criterion (correction-01 C5).
    expect(names(await worktreePaths(repoPath), worktree.path)).toBe(false)
    expect(await records(repoPath)).toEqual([])
    expect(io.err.join('\n')).toContain('removed:')
  })

  it('exits 1 and removes nothing for an id panda does not own', { timeout: GIT_TIMEOUT_MS }, async () => {
    const repoPath = await project()
    const worktree = await makeWorktree(repoPath)

    const io = capture()
    const code = await runPanda(['workspace', 'remove', 'w-9999'], { ...io, cwd: repoPath })

    expect(code).toBe(1)
    expect(io.err.join('\n')).toContain('PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID')
    expect(names(await worktreePaths(repoPath), worktree.path)).toBe(true)
  })

  it('says so and exits 0 when there is nothing to remove (E12)', { timeout: GIT_TIMEOUT_MS }, async () => {
    const repoPath = await project()

    const io = capture()
    const code = await runPanda(['workspace', 'remove'], { ...io, cwd: repoPath })

    expect(code, io.err.join('\n')).toBe(0)
    expect(io.err.join('\n')).toContain('nothing to remove')
  })

  it('reports what it will not touch instead of skipping it in silence (D6)', { timeout: GIT_TIMEOUT_MS }, async () => {
    const repoPath = await project()
    const owned = await makeWorktree(repoPath)
    const impostorPath = join(worktreeStateDir(repoPath), 'trees', 'w-777')
    await run('git', ['-C', repoPath, 'worktree', 'add', '--detach', impostorPath])

    const io = capture()
    const code = await runPanda(['workspace', 'remove'], { ...io, cwd: repoPath })
    const printed = io.err.join('\n')

    expect(code, printed).toBe(0)
    expect(printed).toContain('unclaimed: w-777')
    expect(printed).toContain(`claimed: ${owned.id}`)
    // Neither was removed: a sweep resolves interrupted removals and nothing else.
    expect(names(await worktreePaths(repoPath), impostorPath)).toBe(true)
    expect(names(await worktreePaths(repoPath), owned.path)).toBe(true)
  })
})

describe('an interrupted removal is completed by the sweep, not compounded (AC2)', () => {
  it(
    'survives a real SIGKILL between the intent and the action, and one sweep reaches the clean end state',
    { timeout: GIT_TIMEOUT_MS },
    async () => {
      const repoPath = await project()
      const victim = await makeWorktree(repoPath)
      // The control end state, measured on an identical tree in the same
      // repository by a removal that is NOT interrupted. Without it "the sweep
      // finished" is a claim about a state nobody defined.
      const control = await makeWorktree(repoPath)
      const controlIo = capture()
      expect(await runPanda(['workspace', 'remove', control.id], { ...controlIo, cwd: repoPath })).toBe(0)
      const cleanEndState = {
        gitNamesIt: names(await worktreePaths(repoPath), control.path),
        treeOnDisk: existsSync(control.path),
        recordOnDisk: existsSync(join(worktreeStateDir(repoPath), 'records', `${control.id}.json`)),
        intentOnDisk: existsSync(join(worktreeStateDir(repoPath), 'records', `${control.id}.removing.json`)),
      }
      expect(cleanEndState).toEqual({
        gitNamesIt: false,
        treeOnDisk: false,
        recordOnDisk: false,
        intentOnDisk: false,
      })

      const stateDir = worktreeStateDir(repoPath)
      const observationPath = join(repoPath, 'interrupted-at.json')
      const child = await run(process.execPath, [
        '--conditions=panda-source',
        join(import.meta.dirname, 'interrupted-removal-child.ts'),
        stateDir,
        victim.id,
        victim.path,
        observationPath,
      ]).then(
        () => ({ killed: false }),
        (error: NodeJS.ErrnoException) => ({ killed: true, error }),
      )
      // If the child ever completed, the interruption did not happen and
      // everything below would be testing an ordinary removal.
      expect(child.killed, 'the child finished its removal; nothing was interrupted').toBe(true)

      // The state a killed removal leaves: the durable intent is there, and the
      // record it belongs to still is too.
      const marker = join(stateDir, 'records', `${victim.id}.removing.json`)
      expect(existsSync(marker), 'no intent marker was written before the kill').toBe(true)
      // D3's ORDERING, and the end-state assertions below cannot see it: at the
      // instant the intent became durable the tree had not been touched yet.
      // Swapping the two lines in `removeWorktree` so the intent is written last
      // leaves every other clause in this file green — measured — because an
      // interruption after the tree is gone reaches the same end state.
      expect(JSON.parse(await readFile(observationPath, 'utf8'))).toEqual({ treeStillThere: true })
      const interrupted = await inspectWorktrees(stateDir)
      expect(interrupted.interrupted.map((entry) => entry.id)).toEqual([victim.id])

      // ONE sweep, through the verb, and it calls the same removal the killed
      // process was running.
      const io = capture()
      const code = await runPanda(['workspace', 'remove'], { ...io, cwd: repoPath })
      expect(code, io.err.join('\n')).toBe(0)

      expect({
        gitNamesIt: names(await worktreePaths(repoPath), victim.path),
        treeOnDisk: existsSync(victim.path),
        recordOnDisk: existsSync(join(stateDir, 'records', `${victim.id}.json`)),
        intentOnDisk: existsSync(marker),
      }).toEqual(cleanEndState)
      // Not compounded: a second sweep finds nothing left and says so.
      const again = capture()
      expect(await runPanda(['workspace', 'remove'], { ...again, cwd: repoPath })).toBe(0)
      expect(again.err.join('\n')).toContain('nothing to remove')
    },
  )
})

describe('panda project doctor reports a leftover with a way out (D4 / E11)', () => {
  it(
    'names the leftover and the command that resolves it, and stops reporting it once it is resolved',
    { timeout: GIT_TIMEOUT_MS },
    async () => {
      const repoPath = await project()
      const victim = await makeWorktree(repoPath)
      const stateDir = worktreeStateDir(repoPath)
      await run(process.execPath, [
        '--conditions=panda-source',
        join(import.meta.dirname, 'interrupted-removal-child.ts'),
        stateDir,
        victim.id,
        victim.path,
        join(repoPath, 'interrupted-at.json'),
      ]).catch(() => undefined)
      expect(existsSync(join(stateDir, 'records', `${victim.id}.removing.json`))).toBe(true)

      const before = capture()
      const code = await runPanda(['project', 'doctor'], { ...before, cwd: repoPath })
      const diagnosis = JSON.parse(before.out.join('\n')) as Diagnosis
      const leftover = diagnosis.findings.find((found) => found.kind === 'worktree-leftover')

      expect(code).toBe(1)
      expect(leftover, JSON.stringify(diagnosis.findings.map((f) => f.kind))).toBeDefined()
      expect(leftover?.severity).toBe('problem')
      expect(leftover?.filePath).toBe(victim.path)
      // M4.C: every state panda reports has an exit, and the exit is spelled out
      // with this leftover's own id rather than left as a template.
      expect(leftover?.resolution).toContain(`panda workspace remove ${victim.id}`)

      const sweep = capture()
      expect(await runPanda(['workspace', 'remove'], { ...sweep, cwd: repoPath })).toBe(0)

      const after = capture()
      await runPanda(['project', 'doctor'], { ...after, cwd: repoPath })
      const resolved = JSON.parse(after.out.join('\n')) as Diagnosis
      expect(resolved.findings.map((found) => found.kind)).not.toContain('worktree-leftover')
    },
  )
})
