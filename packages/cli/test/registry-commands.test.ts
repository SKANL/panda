import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REGISTRY_ENTRY_TYPES, REMOVABLE_ENTRY_TYPES } from '@panda/environment'
import { runPanda } from '../src'
import type { RunCommandOptions } from '../src'

// `panda add` / `panda remove` / `panda list` — the surface FR-11 named and
// four stories of projection machinery were reachable without.
//
// What is pinned here is the CLI's whole job and nothing else: argv, output and
// exit codes. Which entries are VALID is `@panda/contracts` and is proven in
// `packages/contracts/test/registry.test.ts`; what a store does with them is
// `@panda/registry`'s. The rows below that end in a refusal therefore assert
// only that the refusal arrives CODED and non-zero, never the sentence — the
// binding must not be able to satisfy them by inventing a rule of its own.

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: (line) => out.push(line), stderr: (line) => err.push(line), out, err }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'panda-registry-cli-'))
}

async function storedEntries(root: string): Promise<{ type: string; id: string }[]> {
  const raw = await readFile(join(root, '.panda', 'registry.json'), 'utf8')
  return (JSON.parse(raw) as { entries: { type: string; id: string }[] }).entries
}

describe('panda add', () => {
  it('registers at the global scope and names the entry, its scope, its store and the next step', async () => {
    const homeDir = await tempDir()
    const io = capture()
    const code = await runPanda(['add', 'skill', 'my-skill', '--entry-path', './s.md'], { ...io, homeDir })
    expect(code).toBe(0)
    const payload = JSON.parse(io.out.join('\n')) as Record<string, unknown>
    expect(payload).toMatchObject({
      scope: 'global',
      registryPath: join(homeDir, '.panda', 'registry.json'),
      entry: { type: 'skill', id: 'my-skill', entryPath: './s.md' },
    })
    const stderr = io.err.join('\n')
    expect(stderr).toContain('skill')
    expect(stderr).toContain('my-skill')
    expect(stderr).toContain('global')
    expect(stderr).toContain(join(homeDir, '.panda', 'registry.json'))
    // `add` does not project, and says which command does. Coupling them would
    // make registration fail for projection reasons.
    expect(stderr).toContain('`panda init`')
    expect(await storedEntries(homeDir)).toEqual([{ type: 'skill', id: 'my-skill', entryPath: './s.md' }])
  })

  it('registers at the project scope through the project grammar, in the resolved directory', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const io = capture()
    const code = await runPanda(['project', 'add', 'mcp-server', 'fmt', '--command', 'prettier', projectDir], {
      ...io,
      homeDir,
    })
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({
      scope: 'project',
      registryPath: join(projectDir, '.panda', 'registry.json'),
      entry: { type: 'mcp-server', id: 'fmt', command: 'prettier' },
    })
    expect(io.err.join('\n')).toContain('`panda project init`')
    expect(await storedEntries(projectDir)).toEqual([{ type: 'mcp-server', id: 'fmt', command: 'prettier' }])
    // The machine scope was not touched: the grammar chose the scope, not a flag.
    await expect(storedEntries(homeDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps every --arg, in order, including the ones that look like flags', async () => {
    const homeDir = await tempDir()
    const io = capture()
    // `-y` is an ordinary argument here — `npx -y @mcp/fs` is the documented
    // invocation of half the servers that exist — so the "a value may not start
    // with a dash" guard the other flags carry must NOT apply to this one.
    const code = await runPanda(
      ['add', 'mcp-server', 'fs', '--command', 'npx', '--arg', '-y', '--arg', '@mcp/fs'],
      { ...io, homeDir },
    )
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({
      entry: { type: 'mcp-server', id: 'fs', command: 'npx', args: ['-y', '@mcp/fs'] },
    })
  })

  it('needs no field flag for a type that has no fields', async () => {
    const homeDir = await tempDir()
    const io = capture()
    const code = await runPanda(['add', 'profile', 'p'], { ...io, homeDir })
    expect(code).toBe(0)
    expect(await storedEntries(homeDir)).toEqual([{ type: 'profile', id: 'p' }])
  })

  it('lets the CONTRACT refuse a field that does not belong on the type, and holds no table of its own', async () => {
    const homeDir = await tempDir()
    const io = capture()
    const code = await runPanda(['add', 'mcp-server', 't', '--entry-path', './x'], { ...io, homeDir })
    expect(code).toBe(2)
    // The CODE is asserted, not the sentence: the sentence is the contract's to
    // write, and pinning it here would be the binding claiming the rule.
    expect(io.err.join('\n')).toContain('PANDA_REGISTRY_INVALID_ENTRY')
    await expect(storedEntries(homeDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never persists an id that could not be projected, and says so coded', async () => {
    const homeDir = await tempDir()
    const io = capture()
    const code = await runPanda(['add', 'skill', '__proto__', '--entry-path', './s.md'], { ...io, homeDir })
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('PANDA_REGISTRY_INVALID_ENTRY')
    await expect(storedEntries(homeDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is a usage error with no type, and names the types panda has', async () => {
    const homeDir = await tempDir()
    for (const argv of [['add'], ['add', 'widget', 'x']]) {
      const io = capture()
      const code = await runPanda(argv, { ...io, homeDir })
      expect(code, argv.join(' ')).toBe(2)
      const stderr = io.err.join('\n')
      for (const type of ['skill', 'mcp-server', 'profile']) {
        expect(stderr, argv.join(' ')).toContain(type)
      }
    }
  })

  it('is a usage error with a type and no id', async () => {
    const homeDir = await tempDir()
    const io = capture()
    const code = await runPanda(['add', 'skill'], { ...io, homeDir })
    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('id')
  })

  it('surfaces registry contention coded rather than hanging or half-writing', async () => {
    const homeDir = await tempDir()
    const registryPath = join(homeDir, '.panda', 'registry.json')
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    // A holder document naming THIS process, which is alive, so the lock is
    // neither stale nor breakable — Story 2.1's guarantee, now reachable from
    // the binary for the first time.
    await writeFile(
      `${registryPath}.lock`,
      JSON.stringify({ pid: process.pid, host: 'test', acquiredAt: new Date().toISOString(), token: 'held' }),
    )
    const io = capture()
    const code = await runPanda(['add', 'profile', 'p'], { ...io, homeDir })
    expect(code).toBe(2)
    const stderr = io.err.join('\n')
    expect(stderr).toContain('PANDA_REGISTRY_CONTENTION')
    expect(stderr).toContain(String(process.pid))
  })
})

/** A real skill source, in the shape all three executors require. */
const SKILL_SOURCE = `---
name: derived
description: x
---

Do nothing.
`

/**
 * A home where `codex` is DETECTED, plus a real skill source. Codex is the one
 * shipped executor with a verified machine-scope skills root and no
 * project-scope configuration at all, so it is the executor that makes the two
 * scopes answer differently — which is the whole subject of these rows.
 */
async function withCodex(): Promise<{ homeDir: string; projectDir: string; entryPath: string }> {
  const homeDir = await tempDir()
  const projectDir = await tempDir()
  await mkdir(join(homeDir, '.codex'), { recursive: true })
  await writeFile(join(homeDir, '.codex', 'config.toml'), '')
  // OUTSIDE the home on purpose: a path under it is stored with the NFR-6 `~/`
  // marker, which is the store's business and is pinned there, not here.
  const entryPath = join(await tempDir(), 'source.md')
  await writeFile(entryPath, SKILL_SOURCE)
  return { homeDir, projectDir, entryPath }
}

// The next step `add` reports is DERIVED from the same planner `panda init`
// runs, never written beside the command. The bug these rows exist for: a
// project-scope skill can reach NO executor — nothing plans a project-scope
// skills root, and machine-scope projection cannot see a project-scope entry —
// while `add` cheerfully pointed at `panda project init`. The printed-command
// invariant cannot catch that: the command it named IS dispatchable, and
// running it delivers nothing.
// Rows for the states a reviewer reached by driving the binary. Every one of
// them was green before the fix beside it.
describe('the guards that keep two scopes two documents, and an id nameable', () => {
  it('refuses a project directory that IS the home directory, instead of aliasing the two scopes', async () => {
    // `storePath` puts the global store at `<home>/.panda/registry.json` and the
    // project store at `<project>/.panda/registry.json`, so a project directory
    // that is the home directory makes them ONE FILE. Before the guard:
    // `panda project list` showed every global entry twice, once under an
    // invented `project` scope, and `panda project remove` reported a
    // project-scope removal while EMPTYING the global registry, exit 0.
    const homeDir = await tempDir()
    expect(await runPanda(['add', 'mcp-server', 'g1', '--command', 'rg'], { ...capture(), homeDir })).toBe(0)
    for (const argv of [
      ['project', 'list', homeDir],
      ['project', 'add', 'mcp-server', 'g2', '--command', 'rg', homeDir],
      ['project', 'remove', 'mcp-server', 'g1', homeDir],
    ]) {
      const io = capture()
      expect(await runPanda(argv, { ...io, homeDir }), argv.join(' ')).toBe(2)
      expect(io.err.join(String.fromCharCode(10)), argv.join(' ')).toContain('PANDA_REGISTRY_STORE_UNAVAILABLE')
    }
    // The global document is exactly as it was: nothing was doubled, nothing
    // was emptied.
    expect(await storedEntries(homeDir)).toEqual([{ type: 'mcp-server', id: 'g1', command: 'rg' }])
  })

  it('binds a project directory and never creates one', async () => {
    // `scopeDirectory` is the trust boundary, and replacing it with a bare
    // `resolve` made `panda project add … <missing tree>` BUILD the whole tree
    // and exit 0 — against its own comment. Nothing pinned it.
    const homeDir = await tempDir()
    const missing = join(await tempDir(), 'no', 'such', 'tree')
    const io = capture()
    const code = await runPanda(['project', 'add', 'mcp-server', 't', '--command', 'rg', missing], { ...io, homeDir })
    expect(code).toBe(2)
    expect(io.err.join(String.fromCharCode(10))).toContain('PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE')
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cannot express `--scope agent`, which is the whole reason the grammar has no scope flag', async () => {
    // The agent scope is an in-memory Map that dies with the process, so a flag
    // for it would accept the flag, exit 0 and persist nothing. Two argv guards
    // make it inexpressible; disabled together, `panda add skill s --scope agent`
    // exited 0 and persisted at GLOBAL — verbatim the lie the boundary argued
    // away. Both guards were untested, precisely because the argument for why no
    // guard was needed read like a reason not to test one.
    const homeDir = await tempDir()
    for (const argv of [
      ['add', 'skill', 's', '--scope', 'agent'],
      ['add', 'skill', 's', '--scope=agent'],
      ['list', '--scope', 'agent'],
      ['remove', 'skill', 's', '--scope', 'agent'],
    ]) {
      const io = capture()
      expect(await runPanda(argv, { ...io, homeDir }), argv.join(' ')).toBe(2)
      expect(io.err.join(String.fromCharCode(10)), argv.join(' ')).toContain("unrecognized option '--scope")
    }
    await expect(storedEntries(homeDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('names an id that begins with a dash, after `--`, and removes it again', async () => {
    // `ingestProviders` accepts such an id and the envelope does not forbid one,
    // so an entry could exist that no spelling of `panda remove` could name —
    // while `panda doctor` pointed the user straight at that command.
    const homeDir = await tempDir()
    const added = capture()
    expect(
      await runPanda(['add', 'mcp-server', '--command', 'npx', '--', '--fs'], { ...added, homeDir }),
    ).toBe(0)
    expect(await storedEntries(homeDir)).toEqual([{ type: 'mcp-server', id: '--fs', command: 'npx' }])
    const removed = capture()
    expect(await runPanda(['remove', 'mcp-server', '--', '--fs'], { ...removed, homeDir })).toBe(0)
    expect(await storedEntries(homeDir)).toEqual([])
    // Past the terminator every token is an id, so an entry may be called
    // `--help` without the help path swallowing it.
    const help = capture()
    expect(await runPanda(['remove', 'profile', '--', '--help'], { ...help, homeDir })).toBe(1)
    expect(help.err.join(String.fromCharCode(10))).toContain('nothing was removed')
  })
})

describe('what panda remove reports', () => {
  it('states the rule panda applies, not a removal it may refuse to perform', async () => {
    // The old sentence — "`panda init` takes it out of every executor panda
    // wrote it into" — is FALSE, not merely vacuous: over a location the user
    // edited, `panda init` answers "panda will not remove a tree it no longer
    // recognises" and the content stays. Asserted literally, because this is the
    // one printed sentence the invariant test cannot check: it is a claim about
    // what a command DOES, not about whether it exists.
    const homeDir = await tempDir()
    expect(await runPanda(['add', 'profile', 'p'], { ...capture(), homeDir })).toBe(0)
    const io = capture()
    expect(await runPanda(['remove', 'profile', 'p'], { ...io, homeDir })).toBe(0)
    const stderr = io.err.join(String.fromCharCode(10))
    expect(stderr).toContain('removes it from every location panda still owns')
    expect(stderr).toContain('reports the ones it no longer recognises rather than deleting them')
    expect(stderr).not.toContain('takes it out of every executor')
  })

  it('empties the scope it was asked for and leaves the other document untouched', async () => {
    // The mutation `remove(type, id, 'global')` in the project branch survived:
    // nothing asserted that a project-scope removal leaves the machine document
    // alone.
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    expect(await runPanda(['add', 'mcp-server', 'shared', '--command', 'rg'], { ...capture(), homeDir })).toBe(0)
    expect(
      await runPanda(['project', 'add', 'mcp-server', 'shared', '--command', 'fmt', projectDir], {
        ...capture(),
        homeDir,
      }),
    ).toBe(0)
    expect(await runPanda(['project', 'remove', 'mcp-server', 'shared', projectDir], { ...capture(), homeDir })).toBe(0)
    expect(await storedEntries(projectDir)).toEqual([])
    expect(await storedEntries(homeDir)).toEqual([{ type: 'mcp-server', id: 'shared', command: 'rg' }])
  })
})

describe('what panda add reports as the next step', () => {
  it('names the executors the planner found, when the scope has a location for the entry', async () => {
    const { homeDir, entryPath } = await withCodex()
    const io = capture()
    expect(await runPanda(['add', 'skill', 'derived', '--entry-path', entryPath], { ...io, homeDir })).toBe(0)
    const stderr = io.err.join('\n')
    expect(stderr).toContain('`panda init`')
    // The EXECUTOR is named because the planner named it — not because this
    // binding knows that a skill has a machine-scope home.
    expect(stderr).toContain('codex')
    expect(stderr).not.toContain('NOTHING TAKES IT HERE')
  })

  it('says nothing takes a project-scope skill, and names the scope that does', async () => {
    const { homeDir, projectDir, entryPath } = await withCodex()
    const io = capture()
    const code = await runPanda(
      ['project', 'add', 'skill', 'deadend', '--entry-path', entryPath, projectDir],
      { ...io, homeDir },
    )
    // Registration SUCCEEDED — the entry is in the store, and saying so is not
    // in tension with saying it reaches nobody.
    expect(code).toBe(0)
    expect(await storedEntries(projectDir)).toEqual([
      { type: 'skill', id: 'deadend', entryPath },
    ])
    const stderr = io.err.join('\n')
    expect(stderr).toContain('NOTHING TAKES IT HERE')
    expect(stderr).toContain('would take this skill entry at the project scope')
    // NOT "no detected executor has a project-scope location for a skill":
    // that explained WHY, conflating "no target exists for this surface" with
    // "a target existed and refused THIS entry".
    expect(stderr).not.toContain('has a project-scope location')
    // The exit: the scope that WOULD take it, and the two commands to get there.
    expect(stderr).toContain('the machine scope takes it (codex)')
    expect(stderr).toContain('`panda add`')
    expect(stderr).toContain('`panda init`')
  })

  it('changes with DETECTION, which is what proves the sentence is read and not written', async () => {
    // The same entry and the same scope as the first row, on a machine where no
    // executor is detected. An authored sentence could not tell the difference.
    const homeDir = await tempDir()
    const entryPath = join(await tempDir(), 'source.md')
    await writeFile(entryPath, SKILL_SOURCE)
    const io = capture()
    expect(await runPanda(['add', 'skill', 'derived', '--entry-path', entryPath], { ...io, homeDir })).toBe(0)
    const stderr = io.err.join('\n')
    expect(stderr).toContain('NOTHING TAKES IT HERE')
    expect(stderr).not.toContain('codex')
    // No scope takes it, so no scope is promised — the one thing this must not
    // do is name a command that would deliver nothing.
    expect(stderr).toContain('no other scope takes it either')
  })

  it('renders a target REFUSAL as a refusal, and never as a missing location', async () => {
    // The headline used to say "no detected executor has a machine-scope
    // location for a skill entry" seconds after codex had used exactly such a
    // location — the source file simply could not be read. Two different facts
    // wearing one sentence.
    const { homeDir } = await withCodex()
    const io = capture()
    expect(
      await runPanda(['add', 'skill', 'ghost', '--entry-path', join(homeDir, 'absent.md')], { ...io, homeDir }),
    ).toBe(0)
    const stderr = io.err.join(String.fromCharCode(10))
    expect(stderr).toContain('refused: codex:')
    expect(stderr).toContain('ENOENT')
    expect(stderr).not.toContain('has a machine-scope location')
  })

  it('says no target gave a reason, rather than inventing one', async () => {
    // An mcp-server with no command is skipped by every config target WITHOUT a
    // reason — `skippedEntryIds` carries ids alone. The message says that
    // instead of explaining on the targets' behalf.
    const { homeDir } = await withCodex()
    const io = capture()
    expect(await runPanda(['add', 'mcp-server', 'm3', '--arg', 'x'], { ...io, homeDir })).toBe(0)
    const stderr = io.err.join(String.fromCharCode(10))
    expect(stderr).toContain('NOTHING TAKES IT HERE')
    expect(stderr).toContain('no target said why')
  })

  it('carries the same answer in the JSON payload a script reads', async () => {
    const { homeDir, projectDir, entryPath } = await withCodex()
    const io = capture()
    expect(
      await runPanda(['project', 'add', 'skill', 'deadend', '--entry-path', entryPath, projectDir], {
        ...io,
        homeDir,
      }),
    ).toBe(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({
      delivery: {
        scope: 'project',
        command: 'panda project init',
        executorIds: [],
        elsewhere: { scope: 'machine', command: 'panda init', executorIds: ['codex'] },
      },
    })
  })
})

describe('panda remove', () => {
  it('takes the entry out of the global scope and exits 0', async () => {
    const homeDir = await tempDir()
    expect(await runPanda(['add', 'skill', 'my-skill', '--entry-path', './s.md'], { ...capture(), homeDir })).toBe(0)
    const io = capture()
    const code = await runPanda(['remove', 'skill', 'my-skill'], { ...io, homeDir })
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({
      scope: 'global',
      removed: { type: 'skill', id: 'my-skill' },
    })
    expect(await storedEntries(homeDir)).toEqual([])
  })

  it('says the entry was not there and exits non-zero, never a silent 0 (AD-5)', async () => {
    const homeDir = await tempDir()
    const io = capture()
    const code = await runPanda(['remove', 'skill', 'absent'], { ...io, homeDir })
    expect(code).toBe(1)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ removed: null, type: 'skill', id: 'absent' })
    expect(io.err.join('\n')).toContain('nothing was removed')
  })

  it('reads the scope it is writing, so an entry inherited from the machine is not reported as removed', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    expect(await runPanda(['add', 'profile', 'shared'], { ...capture(), homeDir })).toBe(0)
    const io = capture()
    // Visible to the project through inheritance, and NOT stored there: the
    // merged view would have reported a removal that did not happen.
    const code = await runPanda(['project', 'remove', 'profile', 'shared', projectDir], { ...io, homeDir })
    expect(code).toBe(1)
    expect(io.err.join('\n')).toContain('nothing was removed')
    expect(await storedEntries(homeDir)).toEqual([{ type: 'profile', id: 'shared' }])
  })
})

describe('panda list', () => {
  it('exits 0 on an empty registry, because an empty list is a result', async () => {
    const homeDir = await tempDir()
    const io = capture()
    const code = await runPanda(['list'], { ...io, homeDir })
    expect(code).toBe(0)
    expect(JSON.parse(io.out.join('\n'))).toMatchObject({ entries: [] })
    expect(io.err.join('\n')).toContain('empty')
  })

  it('shows every entry with its type, its id and the scope it came from', async () => {
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    expect(await runPanda(['add', 'mcp-server', 'rg', '--command', 'rg'], { ...capture(), homeDir })).toBe(0)
    expect(
      await runPanda(['project', 'add', 'mcp-server', 'fmt', '--command', 'prettier', projectDir], {
        ...capture(),
        homeDir,
      }),
    ).toBe(0)
    const io = capture()
    const code = await runPanda(['project', 'list', projectDir], { ...io, homeDir })
    expect(code).toBe(0)
    expect((JSON.parse(io.out.join('\n')) as { entries: unknown[] }).entries).toEqual([
      { scope: 'global', type: 'mcp-server', id: 'rg', command: 'rg' },
      { scope: 'project', type: 'mcp-server', id: 'fmt', command: 'prettier' },
    ])
    const stderr = io.err.join('\n')
    expect(stderr).toContain('global')
    expect(stderr).toContain('project')
    expect(stderr).toContain('rg')
    expect(stderr).toContain('fmt')
  })
})

describe('the new verbs are in the usage block', () => {
  it('advertises all three under both grammars', async () => {
    const io = capture()
    expect(await runPanda(['--help'], io)).toBe(0)
    const usage = io.out.join('\n')
    for (const line of [
      'panda add ',
      'panda project add ',
      'panda remove ',
      'panda project remove ',
      'panda list',
      'panda project list',
    ]) {
      expect(usage, line).toContain(line)
    }
  })

  it('answers --help for each of them rather than treating it as an argument', async () => {
    for (const argv of [
      ['add', '--help'],
      ['add', 'skill', 'x', '--entry-path', './s.md', '--help'],
      ['remove', '--help'],
      ['list', '--help'],
      ['project', 'add', '--help'],
      ['project', 'remove', '--help'],
      ['project', 'list', '--help'],
    ]) {
      const io = capture()
      expect(await runPanda(argv), argv.join(' ')).toBe(0)
      expect(await runPanda(argv, io), argv.join(' ')).toBe(0)
      expect(io.out.join('\n'), argv.join(' ')).toContain('usage: panda run')
    }
  })
})

// Story M4.E, end to end through the binary: `tool` left the vocabulary, and the
// entries an older build already wrote have to stay reachable AND removable.
describe('a retired entry type through the binary', () => {
  /**
   * A registry an older build could have written: the `tool` row is exactly what
   * the shipped binary produced for `panda add tool rg --command rg`, beside a
   * still-declared entry, so removing the retired one has something to leave.
   */
  async function withRetired(root: string): Promise<void> {
    await mkdir(join(root, '.panda'), { recursive: true })
    await writeFile(
      join(root, '.panda', 'registry.json'),
      JSON.stringify(
        { version: 1, entries: [{ type: 'tool', id: 'rg', command: 'rg' }, { type: 'skill', id: 'demo', entryPath: './d.md' }] },
        null,
        2,
      ),
      'utf8',
    )
  }

  it('refuses `panda add tool`, names the remaining types, and persists nothing', async () => {
    const homeDir = await tempDir()
    const io = capture()
    expect(await runPanda(['add', 'tool', 'rg', '--command', 'rg'], { ...io, homeDir })).toBe(2)
    const stderr = io.err.join('\n')
    for (const type of ['skill', 'mcp-server', 'profile']) expect(stderr).toContain(type)
    // And it points at the one command that DOES take the word, so a user
    // upgrading is not told the entry they already have is unreachable.
    expect(stderr).toContain('`panda remove tool <id>`')
    await expect(storedEntries(homeDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drops it from the synopsis of `add` and keeps it in the synopsis of `remove`', async () => {
    const io = capture()
    expect(await runPanda(['--help'], { ...io, homeDir: await tempDir() })).toBe(0)
    const help = io.out.join('\n')
    // DERIVED — and the comment above these lines used to say so while they were
    // LITERALS, which is how replacing the interpolation in `run.ts` with its
    // currently-correct spelling left the whole package green: the stale-help
    // defect Spec Change Log 1 exists to abolish, restored and undetected.
    // Reordering `REGISTRY_ENTRY_TYPES` now fails here unless the synopsis
    // follows it.
    expect(help).toContain(`panda add <${REGISTRY_ENTRY_TYPES.join('|')}> <id>`)
    expect(help).toContain(`panda project add <${REGISTRY_ENTRY_TYPES.join('|')}> <id>`)
    expect(help).toContain(`panda remove <${REMOVABLE_ENTRY_TYPES.join('|')}> <id>`)
    expect(help).toContain(`panda project remove <${REMOVABLE_ENTRY_TYPES.join('|')}> <id>`)
    // And the two lists are not one list: `add` must not offer a word the binary
    // refuses, while `remove` must still take it.
    expect(help).not.toContain(`panda add <${REMOVABLE_ENTRY_TYPES.join('|')}>`)
  })

  it('removes a retired entry through the PROJECT grammar too, which doctor also prints', async () => {
    // T3's other spelling. `panda project doctor` prints
    // `panda project remove <type> <id>` for a project-scope entry and nothing
    // dispatched it — the half of the invariant that proves a command DELIVERS
    // was measured for the machine grammar alone.
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    await withRetired(projectDir)

    const io = capture()
    expect(await runPanda(['project', 'remove', 'tool', 'rg', projectDir], { ...io, homeDir })).toBe(0)
    expect(await storedEntries(projectDir)).toEqual([{ type: 'skill', id: 'demo', entryPath: './d.md' }])
  })

  it('refuses `panda project add tool` in the PROJECT grammar, naming commands that work there', async () => {
    // The machine sentence, reused verbatim at project scope, asserted the entry
    // is listed by `panda list` (which does not read a project registry) and
    // named `panda remove tool <id>` (which exits 1 for a project entry): a
    // refusal handing out two commands that do not do what it says.
    const homeDir = await tempDir()
    const projectDir = await tempDir()
    const io = capture()
    const code = await runPanda(['project', 'add', 'tool', 'rg', '--command', 'rg', projectDir], { ...io, homeDir })
    expect(code).toBe(2)
    const stderr = io.err.join('\n')
    expect(stderr).toContain('`panda project list`')
    expect(stderr).toContain('`panda project remove tool <id>`')
  })

  it('lists it, and removes it with the spelling `panda doctor` prints', async () => {
    const homeDir = await tempDir()
    await withRetired(homeDir)

    const listed = capture()
    expect(await runPanda(['list'], { ...listed, homeDir })).toBe(0)
    expect(listed.err.join('\n')).toContain('global · tool · rg')

    // The T3 half: the command doctor prints is RUN, verbatim, and the entry is
    // gone afterwards. That a command dispatches does not prove it delivers.
    const removed = capture()
    expect(await runPanda(['remove', 'tool', 'rg'], { ...removed, homeDir })).toBe(0)
    expect(await storedEntries(homeDir)).toEqual([{ type: 'skill', id: 'demo', entryPath: './d.md' }])

    const after = capture()
    expect(await runPanda(['list'], { ...after, homeDir })).toBe(0)
    expect(after.err.join('\n')).not.toContain('tool')
  })

  it('says so and exits non-zero when the retired entry is already gone', async () => {
    const homeDir = await tempDir()
    const io = capture()
    expect(await runPanda(['remove', 'tool', 'rg'], { ...io, homeDir })).toBe(1)
    expect(io.err.join('\n')).toContain("no tool entry 'rg' is registered")
  })
})
