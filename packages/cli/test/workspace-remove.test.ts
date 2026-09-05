import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { worktreeStateDir } from '@skanl/panda-session'
import { runPanda } from '../src/run.ts'
import type { RunCommandOptions } from '../src/run.ts'
import type { WorkspaceHandle } from '@skanl/panda-contracts'

// Spec M27.A at the BINARY, under the DEFAULT provider. `panda run` creates a
// directory per session under `.panda/workspaces/<uuid>` and, before this
// change, nothing removed one and nothing even reported one.
//
// No git anywhere: `local` is what runs when nothing selects otherwise, which is
// the whole reason this half of M27 exists. The git-worktree half of the same
// verb is driven against real git in `worktree-remove.test.ts`.

const projects: string[] = []
afterAll(async () => {
  for (const project of projects) await rm(project, { recursive: true, force: true })
})

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: (line) => out.push(line), stderr: (line) => err.push(line), out, err }
}

/** A project whose own document selects the local provider, explicitly. */
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'panda-cli-ws-remove-'))
  projects.push(dir)
  await mkdir(join(dir, '.panda'), { recursive: true })
  // Written rather than relied on: `local` is the built-in default, and a
  // machine document naming the other provider would otherwise decide this test.
  await writeFile(
    join(dir, '.panda', 'config.json'),
    `${JSON.stringify({ workspace: { provider: 'local' } })}\n`,
    'utf8',
  )
  return dir
}

/**
 * A workspace made the way a run makes one, because it IS a run: `panda run`
 * against an adapter that spawns nothing.
 */
async function makeWorkspace(dir: string): Promise<{ id: string; path: string }> {
  const seen: WorkspaceHandle[] = []
  const io = capture()
  const code = await runPanda(['run', 'make a workspace'], {
    ...io,
    cwd: dir,
    createAdapter: () => ({
      async run(request) {
        seen.push(request.workspace)
        return { status: 'ok', data: null, summary: 'inert', errors: [] }
      },
    }),
  })
  expect(code, io.err.join('\n')).toBe(0)
  const handle = seen[0]
  expect(handle, 'the run produced no workspace handle').toBeDefined()
  return { id: handle!.id, path: handle!.rootPath }
}

async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).sort()
}

describe('panda workspace remove, under the default provider', () => {
  it('E1/E2 — two runs are both claimed, and each is removable by its id', async () => {
    const dir = await project()
    const first = await makeWorkspace(dir)
    const second = await makeWorkspace(dir)

    const sweep = capture()
    expect(await runPanda(['workspace', 'remove'], { ...sweep, cwd: dir }), sweep.err.join('\n')).toBe(0)
    const listed = sweep.err.join('\n')
    expect(listed).toContain(`claimed: ${first.id}`)
    expect(listed).toContain(`claimed: ${second.id}`)
    // A sweep REPORTS; removal is a decision, so neither is gone yet.
    expect(existsSync(first.path)).toBe(true)
    expect(existsSync(second.path)).toBe(true)

    for (const workspace of [first, second]) {
      const io = capture()
      expect(await runPanda(['workspace', 'remove', workspace.id], { ...io, cwd: dir }), io.err.join('\n')).toBe(0)
      expect(io.err.join('\n')).toContain('removed:')
      expect(existsSync(workspace.path)).toBe(false)
    }
    expect(await entries(worktreeStateDir(dir))).toEqual([])
  })

  it('E3 — a UUID directory panda did not make is named, and survives', async () => {
    const dir = await project()
    const mine = await makeWorkspace(dir)
    const foreign = randomUUID()
    await mkdir(join(worktreeStateDir(dir), foreign), { recursive: true })
    await writeFile(join(worktreeStateDir(dir), foreign, 'notes.md'), '# not pandas\n', 'utf8')

    const sweep = capture()
    expect(await runPanda(['workspace', 'remove'], { ...sweep, cwd: dir }), sweep.err.join('\n')).toBe(0)
    expect(sweep.err.join('\n')).toContain(`unclaimed: ${foreign}`)
    expect(sweep.err.join('\n')).toContain('predates')

    // Naming it explicitly is not a licence either: an id panda holds no record
    // for exits 1 and removes nothing.
    const named = capture()
    expect(await runPanda(['workspace', 'remove', foreign], { ...named, cwd: dir })).toBe(1)
    expect(named.err.join('\n')).toContain('PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID')
    // Both stores disclaim it, and the refusal still names the PATH it looked
    // at: an id echoed back with no location is a report a user cannot act on.
    expect(named.err.join('\n')).toContain(join(worktreeStateDir(dir), foreign))
    expect(await entries(join(worktreeStateDir(dir), foreign))).toEqual(['notes.md'])
    // The control, same project, same run: the one panda made still goes.
    const control = capture()
    expect(await runPanda(['workspace', 'remove', mine.id], { ...control, cwd: dir })).toBe(0)
  })

  it('E4/E5 — the git-worktree store survives being named at the verb', async () => {
    const dir = await project()
    const state = worktreeStateDir(dir)
    // The hazard measurement 3 drives: both providers are seeded with THIS root,
    // and `acquire('trees')` hands out a read+write handle for it. A removal
    // keyed on the path would delete every worktree in the project.
    await mkdir(join(state, 'trees', 'w-1'), { recursive: true })
    await writeFile(join(state, 'trees', 'w-1', 'work.txt'), 'a users work\n', 'utf8')
    await mkdir(join(state, 'records'), { recursive: true })
    await writeFile(join(state, 'records', 'w-1.json'), '{"version":1,"id":"w-1"}\n', 'utf8')
    const mine = await makeWorkspace(dir)

    for (const named of ['trees', 'records']) {
      const io = capture()
      expect(await runPanda(['workspace', 'remove', named], { ...io, cwd: dir }), io.err.join('\n')).toBe(1)
      expect(io.err.join('\n')).toContain('PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID')
    }
    expect(await entries(join(state, 'trees', 'w-1'))).toEqual(['work.txt'])
    expect(await entries(join(state, 'records'))).toEqual(['w-1.json'])
    // The control: D2 discriminating, not a verb that refuses everything.
    const control = capture()
    expect(await runPanda(['workspace', 'remove', mine.id], { ...control, cwd: dir })).toBe(0)
    expect(existsSync(mine.path)).toBe(false)
  })

  it('E7 — the sweep reports both stores and does not call one the other', async () => {
    const dir = await project()
    const state = worktreeStateDir(dir)
    await mkdir(join(state, 'trees', 'w-7'), { recursive: true })
    const mine = await makeWorkspace(dir)

    const sweep = capture()
    expect(await runPanda(['workspace', 'remove'], { ...sweep, cwd: dir }), sweep.err.join('\n')).toBe(0)
    const printed = sweep.err.join('\n')

    expect(printed).toContain(`claimed: ${mine.id}`)
    // The OTHER store's leftover, reported by the worktree half of the verb.
    expect(printed).toContain('unclaimed: w-7')
    // And its own directories are NOT reported as local leftovers: they belong
    // to a store that declared them, not to a user who left them behind.
    expect(printed).not.toContain('unclaimed: trees')
    expect(printed).not.toContain('unclaimed: records')

    const report = JSON.parse(sweep.out.join('\n')) as {
      stores: { local: { claimed: unknown[] }; 'git-worktree': { unclaimed: { id: string }[] } }
    }
    expect(report.stores.local.claimed).toHaveLength(1)
    expect(report.stores['git-worktree'].unclaimed.map((entry) => entry.id)).toEqual(['w-7'])
  })

  it('says so and exits 0 when there is nothing to remove', async () => {
    const dir = await project()
    const io = capture()
    expect(await runPanda(['workspace', 'remove'], { ...io, cwd: dir }), io.err.join('\n')).toBe(0)
    expect(io.err.join('\n')).toContain('nothing to remove')
  })
})
