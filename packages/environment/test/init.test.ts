import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryLogSink } from '@panda/kernel'
import type { LogSink } from '@panda/kernel'
import { RegistryStore } from '@panda/registry'
import { describe, expect, it } from 'vitest'
import { PROJECTION_ACTION_ID, deliveryFor, initMachine, initProject, noExecutorsDetected } from '../src/init.ts'

async function fixture(): Promise<{ homeDir: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'panda-env-'))
  const homeDir = join(root, 'home')
  const projectDir = join(root, 'project')
  await mkdir(homeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  return { homeDir, projectDir }
}

/** A real skill source, in the shape all three executors require. */
const SKILL_SOURCE = ['---', 'name: derived', 'description: x', '---', '', 'Do nothing.', ''].join(
  String.fromCharCode(10),
)

async function register(homeDir: string, entry: Record<string, unknown>): Promise<void> {
  const store = new RegistryStore({ homeDir })
  await store.register(entry, 'global')
  await store.dispose()
}

/** Claude Code present and its MCP file readable; the shape most rows start from. */
async function withClaude(homeDir: string, body = '{}\n'): Promise<string> {
  const path = join(homeDir, '.claude.json')
  await writeFile(path, body, 'utf8')
  return path
}

async function withCodex(homeDir: string): Promise<string> {
  await mkdir(join(homeDir, '.codex'), { recursive: true })
  return join(homeDir, '.codex', 'config.toml')
}

describe('panda init prepares the machine', () => {
  it('leaves panda directories and a readable registry store behind, and is idempotent', async () => {
    const { homeDir } = await fixture()

    const first = await initMachine({ homeDir })
    expect(first.pandaDir).toBe(join(homeDir, '.panda'))
    expect((await stat(first.pandaDir)).isDirectory()).toBe(true)
    expect(first.registryPath).toBe(join(homeDir, '.panda', 'registry.json'))
    const store = await readFile(first.registryPath, 'utf8')

    const second = await initMachine({ homeDir })
    expect(second.registryPath).toBe(first.registryPath)
    expect(await readFile(second.registryPath, 'utf8')).toBe(store)
  })

  it('reports every executor it looked for and where, when it detects none', async () => {
    const { homeDir } = await fixture()
    const result = await initMachine({ homeDir })

    // The caller's non-zero-exit condition, and the payload that makes it
    // actionable: what was looked for, and the exact path checked for each.
    expect(noExecutorsDetected(result)).toBe(true)
    expect(result.targets).toEqual([])
    expect(result.detected.flatMap((detection) => detection.evidence.map((item) => item.path)).length).toBe(6)
    for (const detection of result.detected) expect(detection.present).toBe(false)
  })
})

describe('the init payload keeps the shape callers print', () => {
  it('pins the key order of a target row, with and without an error', async () => {
    // `written` silently moved from index 3 to LAST, after `error`, when the row
    // was rebuilt by spread — with both suites green. This is a documented
    // payload a caller prints, so its order is authored, not inherited.
    const { homeDir } = await fixture()
    await withClaude(homeDir, 'this is not json')
    await withCodex(homeDir)

    const result = await initMachine({ homeDir })

    const failed = result.targets.find((target) => target.error !== undefined)
    const clean = result.targets.find((target) => target.error === undefined)
    expect(Object.keys(clean!)).toEqual([
      'executorId',
      'targetId',
      'filePath',
      'written',
      'drift',
      'unprojectable',
    ])
    expect(Object.keys(failed!)).toEqual([
      'executorId',
      'targetId',
      'filePath',
      'written',
      'drift',
      'unprojectable',
      'error',
    ])
  })
})

describe('projection results are specific per target', () => {
  it('distinguishes written from unchanged across two runs', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: ['--port', '1'] })

    const first = await initMachine({ homeDir })
    expect(first.targets[0]?.written).toBe(true)
    const afterFirst = await readFile(claudeJson, 'utf8')

    const second = await initMachine({ homeDir })
    expect(second.targets[0]).toMatchObject({ written: false, drift: [], unprojectable: [] })
    expect(second.targets[0]?.error).toBeUndefined()
    expect(await readFile(claudeJson, 'utf8')).toBe(afterFirst)
  })

  it('reports a user-edited entry as drift and never overwrites it', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] })
    await initMachine({ homeDir })

    const edited = (await readFile(claudeJson, 'utf8')).replace('"ctx-server"', '"ctx-server-edited"')
    await writeFile(claudeJson, edited, 'utf8')

    const result = await initMachine({ homeDir })
    expect(result.targets[0]?.written).toBe(false)
    expect(result.targets[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'edited', entryId: 'ctx', location: 'mcpServers.ctx' }),
    ])
    expect(await readFile(claudeJson, 'utf8')).toBe(edited)
  })

  it('reports an entry no target can express, with the reason, and writes nothing for it', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await register(homeDir, { type: 'profile', id: 'frontend' })

    const result = await initMachine({ homeDir })
    expect(result.targets[0]?.unprojectable).toEqual([
      { entryId: 'frontend', reason: "'claude-code' has no native representation for a profile entry (correction-01 C5)" },
    ])
    expect(result.targets[0]?.written).toBe(false)
    expect(JSON.parse(await readFile(claudeJson, 'utf8'))).toEqual({})
  })

  it('reports an mcp-server with no command as unprojectable rather than deleting it', async () => {
    const { homeDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'halfway' })

    const result = await initMachine({ homeDir })
    expect(result.targets[0]?.unprojectable).toEqual([
      {
        entryId: 'halfway',
        reason: "the mcp-server entry declares no command, so there is nothing to render into 'claude-code'",
      },
    ])
  })

  it('isolates a broken vendor file: that target fails, the others still project', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir, 'this is not json')
    const codexToml = await withCodex(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: ['--x'] })

    const log = createMemoryLogSink()
    const result = await initMachine({ homeDir, log })

    // ONE row per planned target, never one per outcome: a target that wrote and
    // then failed its ledger update must not split into a written row and a
    // `written: false` row that contradicts it.
    expect(result.targets).toHaveLength(2)
    const claude = result.targets.find((target) => target.executorId === 'claude-code')
    const codex = result.targets.find((target) => target.executorId === 'codex')
    expect(claude?.error?.code).toBe('PANDA_PROJECTION_NATIVE_MALFORMED')
    expect(claude?.written).toBe(false)
    expect(await readFile(claudeJson, 'utf8')).toBe('this is not json')

    expect(codex?.written).toBe(true)
    // Codex's own vocabulary: snake_case table, `command` and `args`, nothing else.
    const toml = await readFile(codexToml, 'utf8')
    expect(toml).toContain('[mcp_servers.ctx]')
    expect(toml).toContain('command = "ctx-server"')
    expect(toml).not.toContain('mcpServers')

    // What `panda init` prints IS this object — the CLI adds `JSON.stringify`
    // and nothing else. A live `Error` in the result would survive this file's
    // other assertions and print as `{}` for every user of the command, which is
    // why the failure is flattened to a code and a message at the boundary.
    expect(JSON.parse(JSON.stringify(result, null, 2))).toEqual(result)

    // Every projected target reached the record sink, failures included — and
    // every detected executor now has TWO: its configuration file and its
    // skills root. A skills target that never reached the sink would make the
    // record stream silent about the one surface where panda deletes.
    await log.drain()
    expect(log.records.map((record) => `${record.event} ${record.subject}`).sort()).toEqual([
      `action.completed ${PROJECTION_ACTION_ID}#claude-skills`,
      `action.completed ${PROJECTION_ACTION_ID}#codex-config`,
      `action.completed ${PROJECTION_ACTION_ID}#codex-skills`,
      `action.failed ${PROJECTION_ACTION_ID}#claude-mcp`,
      `action.invoked ${PROJECTION_ACTION_ID}#claude-mcp`,
      `action.invoked ${PROJECTION_ACTION_ID}#claude-skills`,
      `action.invoked ${PROJECTION_ACTION_ID}#codex-config`,
      `action.invoked ${PROJECTION_ACTION_ID}#codex-skills`,
    ])
  })
})

describe('panda project init binds a project', () => {
  it('projects the merged registry into project-scope files and skips executors that have none', async () => {
    const { homeDir, projectDir } = await fixture()
    await withClaude(homeDir)
    await withCodex(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'global-one', command: 'g' })

    const projectStore = new RegistryStore({ homeDir, projectDir })
    await projectStore.register({ type: 'mcp-server', id: 'project-one', command: 'p' }, 'project')
    await projectStore.dispose()

    const result = await initProject({ homeDir, projectDir })

    expect(result.registryPath).toBe(join(projectDir, '.panda', 'registry.json'))
    expect(result.entryCount).toBe(2)
    expect(result.targets.map((target) => target.executorId)).toEqual(['claude-code'])
    expect(result.targets[0]?.filePath).toBe(join(projectDir, '.mcp.json'))
    // Codex is installed and was NOT written to: panda invents no location.
    expect(result.skipped).toEqual([
      {
        executorId: 'codex',
        reason: "'codex' has no project-scope configuration file; panda will not invent a location it does not read",
      },
    ])
    expect(await stat(join(homeDir, '.codex')).then((entry) => entry.isDirectory())).toBe(true)
    await expect(readFile(join(homeDir, '.codex', 'config.toml'), 'utf8')).rejects.toThrow()

    // Both scopes reached the project's file: the project entry over the machine's.
    expect(JSON.parse(await readFile(join(projectDir, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        'global-one': { type: 'stdio', command: 'g', args: [] },
        'project-one': { type: 'stdio', command: 'p', args: [] },
      },
    })
  })

  it('keeps the machine and project ledgers separate, so neither disowns the other', async () => {
    const { homeDir, projectDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server' })

    await initMachine({ homeDir })
    await initProject({ homeDir, projectDir })
    // A second machine run after the project run must still see its OWN entry as
    // its own: the ledger is scoped by target AND file, and a shared ledger that
    // was not would report one of the two as a foreign collision.
    const again = await initMachine({ homeDir })
    expect(again.targets[0]).toMatchObject({ written: false, drift: [] })
  })
})

/** OpenCode present and its config location readable. */
async function withOpenCode(homeDir: string): Promise<string> {
  await mkdir(join(homeDir, '.config', 'opencode'), { recursive: true })
  return join(homeDir, '.config', 'opencode', 'opencode.json')
}

describe('OpenCode is projected into, in OpenCode vocabulary', () => {
  it('writes mcp.<id> with type local and an argv command array, machine scope', async () => {
    const { homeDir } = await fixture()
    const configPath = await withOpenCode(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: ['--port', '1'] })

    const result = await initMachine({ homeDir })
    expect(result.targets.map((target) => target.executorId)).toEqual(['opencode'])
    expect(result.targets[0]?.written).toBe(true)

    // OpenCode's own schema: `mcp.<id>`, `type: 'local'`, and `command` IS the
    // argv — there is no `args` field, so the split panda keeps internally is
    // joined exactly here and nowhere else.
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      mcp: { ctx: { type: 'local', command: ['ctx-server', '--port', '1'] } },
    })
  })

  it('writes the project-root opencode.json on project init, keeping foreign keys', async () => {
    const { homeDir, projectDir } = await fixture()
    await withOpenCode(homeDir)
    const projectConfig = join(projectDir, 'opencode.json')
    await writeFile(projectConfig, '{\n  "theme": "system"\n}\n', 'utf8')
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server' })

    const result = await initProject({ homeDir, projectDir })
    expect(result.targets[0]).toMatchObject({ executorId: 'opencode', filePath: projectConfig, written: true })

    const merged = await readFile(projectConfig, 'utf8')
    expect(merged).toContain('"theme": "system"')
    expect(JSON.parse(merged)).toEqual({
      theme: 'system',
      mcp: { ctx: { type: 'local', command: ['ctx-server'] } },
    })
  })
})

describe('the scopes panda is pointed at are a trust boundary', () => {
  it('refuses a project directory that does not exist, and creates nothing', async () => {
    const { homeDir, projectDir } = await fixture()
    const missing = join(projectDir, 'no', 'such', 'project')
    await expect(initProject({ homeDir, projectDir: missing })).rejects.toMatchObject({
      code: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE',
    })
    // `panda project init <typo>` used to BUILD the whole tree and write a
    // vendor config into it. Panda binds an existing project; it never makes one.
    await expect(stat(join(projectDir, 'no'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a project path that is a file', async () => {
    const { homeDir, projectDir } = await fixture()
    const file = join(projectDir, 'README.md')
    await writeFile(file, '#', 'utf8')
    await expect(initProject({ homeDir, projectDir: file })).rejects.toMatchObject({
      code: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE',
    })
  })

  it('refuses an empty home directory instead of relocating the machine scope into the CWD', async () => {
    // `process.env.HOME ?? ''` is exactly the shape a consumer writes, and
    // resolve('') is the current working directory: a reviewer's probe left a
    // real .mcp.json inside a package of this repo.
    await expect(initMachine({ homeDir: '' })).rejects.toMatchObject({
      code: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE',
    })
    await expect(stat(join(process.cwd(), '.mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to build its own state directory over a file, with the path in the message', async () => {
    const { homeDir } = await fixture()
    await writeFile(join(homeDir, '.panda'), 'not a directory', 'utf8')
    await expect(initMachine({ homeDir })).rejects.toMatchObject({
      code: 'PANDA_ENVIRONMENT_SCOPE_UNAVAILABLE',
      message: expect.stringContaining(join(homeDir, '.panda')),
    })
  })

  it('names the file and the reason when a vendor config path is a directory', async () => {
    const { homeDir } = await fixture()
    const claudeJson = join(homeDir, '.claude.json')
    await mkdir(claudeJson, { recursive: true })
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server' })

    // Detected as present (the path exists), then coded rather than a bare EISDIR.
    const result = await initMachine({ homeDir })
    expect(result.targets[0]?.error?.code).toBe('PANDA_PROJECTION_NATIVE_UNCLAIMABLE')
    expect(result.targets[0]?.error?.message).toContain(claudeJson)
  })
})

describe('the facts a caller acts on are not fabricated', () => {
  it('never explains a skipped id with a RETIRED entry that shares it', async () => {
    // The guard is one `continue` in `runScope`, and it stated the bug it
    // prevents in its own comment while nothing measured it. Without it, `byId`
    // holds the retired row too, and the reason a target gives for skipping
    // `inert` becomes "'claude-code' has no native representation for a tool
    // entry" -- panda naming a type it no longer declares, as the explanation
    // for an entry no target was ever handed.
    const { homeDir } = await fixture()
    await withClaude(homeDir)
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(
      join(homeDir, '.panda', 'registry.json'),
      JSON.stringify({ version: 1, entries: [{ type: 'tool', id: 'inert', command: 'rg' }] }),
      'utf8',
    )
    await register(homeDir, { type: 'profile', id: 'inert' })

    const result = await initMachine({ homeDir })

    expect(result.targets[0]?.unprojectable).toEqual([
      {
        entryId: 'inert',
        reason: "'claude-code' has no native representation for a profile entry (correction-01 C5)",
      },
    ])
  })

  it('does not blame a projected mcp-server for a profile that shares its id', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    // Registry identity is `type:id`, so these are two entries. Only the profile
    // is unprojectable; the mcp-server is written in this very run.
    await register(homeDir, { type: 'profile', id: 'ctx' })
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server' })

    const result = await initMachine({ homeDir })
    expect(result.targets[0]?.unprojectable).toEqual([
      {
        entryId: 'ctx',
        reason: "'claude-code' has no native representation for a profile entry (correction-01 C5)",
      },
    ])
    expect(result.targets[0]?.written).toBe(true)
    expect(JSON.parse(await readFile(claudeJson, 'utf8'))).toEqual({
      mcpServers: { ctx: { type: 'stdio', command: 'ctx-server', args: [] } },
    })
  })

  it('surfaces the ledger warning when panda has lost its ownership records', async () => {
    const { homeDir } = await fixture()
    await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server' })
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(join(homeDir, '.panda', 'projection-ledger.json'), '{ broken', 'utf8')

    const result = await initMachine({ homeDir })
    // A run that cannot read the ledger is not a failed run, but it is also not
    // a silent one: panda is projecting without being able to claim what it wrote.
    expect(result.warnings.map((warning) => warning.code)).toEqual(['PANDA_PROJECTION_LEDGER_UNAVAILABLE'])
    expect(result.warnings[0]?.detail).toContain(join(homeDir, '.panda', 'projection-ledger.json'))
  })

  it('reports targets in catalogue order however they finished', async () => {
    const { homeDir } = await fixture()
    await withClaude(homeDir, 'this is not json')
    await withCodex(homeDir)
    await withOpenCode(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server' })

    // claude FAILS and the other two succeed; reporting by outcome instead of by
    // catalogue would put the failure last and reshuffle the report run to run.
    const result = await initMachine({ homeDir })
    expect(result.targets.map((target) => target.executorId)).toEqual(['claude-code', 'codex', 'opencode'])
  })

  it('completes even when the record sink throws on every record', async () => {
    const { homeDir } = await fixture()
    const claudeJson = await withClaude(homeDir)
    await register(homeDir, { type: 'mcp-server', id: 'ctx', command: 'ctx-server' })

    const hostile: LogSink = {
      record() {
        throw new Error('this sink is broken')
      },
      drain: () => Promise.resolve(),
      state: { status: 'degraded', dropped: 0, everDegraded: true, pending: 0 },
    }
    // A diagnostic never aborts what it describes — the same containment rule the
    // kernel applies to its own call sites.
    const result = await initMachine({ homeDir, log: hostile })
    expect(result.targets[0]?.written).toBe(true)
    expect(JSON.parse(await readFile(claudeJson, 'utf8'))).toMatchObject({ mcpServers: { ctx: {} } })
  })
})

// `deliveryFor` is what `panda add` reports its next step FROM, and it had no
// test in this package at all — the CLI rows exercised the happy paths through
// the binding, and the `catch` that contains a throwing planner survived being
// replaced by a rethrow. That mutation matters: the caller has already
// REGISTERED the entry by the time this runs, so a throw here would turn a
// completed write into exit 2, which is the exact outcome its comment claims to
// prevent.
describe('deliveryFor', () => {
  it('names the executors the planner found for the scope that was written', async () => {
    const homeDir = (await fixture()).homeDir
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await writeFile(join(homeDir, '.codex', 'config.toml'), '')
    const entryPath = join(homeDir, 'source.md')
    await writeFile(entryPath, SKILL_SOURCE)
    const delivery = await deliveryFor({ type: 'skill', id: 'x', entryPath }, 'machine', homeDir, homeDir)
    expect(delivery).toMatchObject({ scope: 'machine', command: 'panda init', executorIds: ['codex'] })
    expect(delivery.undetermined).toBeUndefined()
  })

  it('answers the OTHER scope when nothing at this one takes the entry', async () => {
    const homeDir = (await fixture()).homeDir
    const projectDir = (await fixture()).projectDir
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await writeFile(join(homeDir, '.codex', 'config.toml'), '')
    const entryPath = join(homeDir, 'source.md')
    await writeFile(entryPath, SKILL_SOURCE)
    const delivery = await deliveryFor({ type: 'skill', id: 'x', entryPath }, 'project', homeDir, projectDir)
    expect(delivery.executorIds).toEqual([])
    expect(delivery.elsewhere).toMatchObject({ scope: 'machine', command: 'panda init', executorIds: ['codex'] })
  })

  it('reports a planner it could not run instead of throwing out of a completed registration', async () => {
    // A REAL throwing target, not a synthetic one: `collectMcpEntries` raises a
    // coded PandaError for an mcp-server id that can never be a native config
    // key, so asking a config target about one throws from inside `merge`.
    //
    // The binding cannot reach this id — registration rejects it first — but the
    // containment is what matters, not this input: the entry is already
    // PERSISTED by the time `deliveryFor` runs, so any throw from a target would
    // turn a completed registration into exit 2. Replacing the catch with a
    // rethrow used to survive, because nothing here called this function at all.
    const homeDir = (await fixture()).homeDir
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await writeFile(join(homeDir, '.codex', 'config.toml'), '')
    const delivery = await deliveryFor(
      { type: 'mcp-server', id: '__proto__', command: 'npx' },
      'machine',
      homeDir,
      homeDir,
    )
    expect(delivery.undetermined, 'a planner that cannot answer must be reported, not thrown').toContain(
      'PANDA_REGISTRY_INVALID_ENTRY',
    )
    expect(delivery.executorIds).toEqual([])
    // The grammar fact stays true and is all that is claimed.
    expect(delivery.command).toBe('panda init')
  })})
