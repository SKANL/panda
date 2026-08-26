import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// The ONLY import in this file, and that is the assertion: everything a consumer
// needs — populating the registry, running init, reading the result, observing
// the run — comes from this package's single public entry. An
// `@panda/environment`-only install cannot resolve `@panda/registry`,
// `@panda/projection` or `@panda/kernel` under pnpm's strict layout, so a test
// that reached for any of them would be proving the claim on a monorepo's terms.
import {
  PROJECTION_ACTION_ID,
  RegistryStore,
  createMemoryLogSink,
  diagnose,
  initMachine,
  initProject,
} from '../src/index.ts'

/**
 * The POSITIVE proof of FR-29: anything `panda init` / `panda project init` can
 * do, a third party can do by importing this package, with no `@panda/cli`
 * installed. A negative scan of CLI source can be evaded — this cannot, because
 * it never mentions the CLI. It composes the capability the way a consumer
 * would and asserts the result in the EXECUTOR'S OWN TERMS: the bytes Claude
 * Code reads, at the path Claude Code reads them from.
 *
 * What makes it fail: move any part of the capability into `@panda/cli` and this
 * file stops writing `.mcp.json`. Concretely — delete the `runProjection` call
 * from `src/init.ts` and the file never appears; drop the `mcpServers` key or
 * the `type: 'stdio'` field from what the target renders and the vendor-shaped
 * assertion fails while a "3 targets written" summary would still have passed;
 * stop threading the sink and the record assertions go empty.
 */
async function fixture(): Promise<{ homeDir: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'panda-env-consumer-'))
  const homeDir = join(root, 'home')
  const projectDir = join(root, 'project')
  await mkdir(homeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  return { homeDir, projectDir }
}

describe('a consumer with no @panda/cli installed', () => {
  it('projects the registry into the file Claude Code reads, in Claude Code vocabulary', async () => {
    const { homeDir, projectDir } = await fixture()
    // Claude Code's own state file, with its own content. Its presence is the
    // filesystem evidence detection runs on, and every byte of it must survive.
    await writeFile(join(homeDir, '.claude.json'), '{\n  "numStartups": 7\n}\n', 'utf8')

    const store = new RegistryStore({ homeDir })
    await store.register(
      { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      'global',
    )
    await store.dispose()

    const log = createMemoryLogSink()
    const result = await initProject({ homeDir, projectDir, log })

    // The acceptance criterion, phrased in the external tool's terms rather than
    // panda's: Claude Code reads MCP servers for a project from `.mcp.json` at
    // the project root, under `mcpServers.<id>`, shaped `{type:'stdio', command, args}`.
    const mcpPath = join(projectDir, '.mcp.json')
    expect(JSON.parse(await readFile(mcpPath, 'utf8'))).toEqual({
      mcpServers: {
        context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      },
    })

    expect(result.scope).toBe('project')
    expect(result.entryCount).toBe(1)
    expect(result.targets).toEqual([
      {
        executorId: 'claude-code',
        targetId: 'claude-mcp',
        filePath: mcpPath,
        written: true,
        drift: [],
        unprojectable: [],
      },
    ])
    // Detection is honest: the two executors that are not installed are reported
    // as absent WITH the paths that were consulted, not omitted.
    expect(result.detected.map((detection) => [detection.executorId, detection.present])).toEqual([
      ['claude-code', true],
      ['codex', false],
      ['opencode', false],
    ])

    // Panda's own state exists afterwards, and the run went through the record sink.
    expect((await stat(result.pandaDir)).isDirectory()).toBe(true)
    expect((await stat(result.registryPath)).isFile()).toBe(true)
    await log.drain()
    expect(log.records.map((record) => record.event)).toEqual(['action.invoked', 'action.completed'])
    expect(log.records.every((record) => record.subject === `${PROJECTION_ACTION_ID}#claude-mcp`)).toBe(true)

    // Second run over the same registry: nothing written, byte-identical file.
    const before = await readFile(mcpPath, 'utf8')
    const second = await initProject({ homeDir, projectDir })
    expect(second.targets[0]?.written).toBe(false)
    expect(second.targets[0]?.drift).toEqual([])
    expect(await readFile(mcpPath, 'utf8')).toBe(before)
  })

  it('prepares the machine and projects into the machine-scope config, keeping foreign bytes', async () => {
    const { homeDir } = await fixture()
    const claudeJson = join(homeDir, '.claude.json')
    await writeFile(claudeJson, '{\n  "numStartups": 7\n}\n', 'utf8')

    const store = new RegistryStore({ homeDir })
    await store.register({ type: 'mcp-server', id: 'ctx', command: 'ctx-server', args: [] }, 'global')
    await store.dispose()

    const result = await initMachine({ homeDir })

    expect(result.scope).toBe('machine')
    expect(result.pandaDir).toBe(join(homeDir, '.panda'))
    expect(result.targets[0]).toMatchObject({ executorId: 'claude-code', filePath: claudeJson, written: true })

    const merged = await readFile(claudeJson, 'utf8')
    // Foreign state untouched, panda's entry in the vendor's own vocabulary.
    expect(merged).toContain('"numStartups": 7')
    expect(JSON.parse(merged)).toEqual({
      numStartups: 7,
      mcpServers: { ctx: { type: 'stdio', command: 'ctx-server', args: [] } },
    })
    // Ownership is durable and panda-side; no marker was injected into the vendor file.
    expect((await stat(result.ledgerPath)).isFile()).toBe(true)
    expect(merged).not.toContain('panda')
  })

  /**
   * The same FR-29 claim for `panda doctor`: a third party diagnoses an
   * environment through this package alone. It is asserted in the EXECUTOR'S OWN
   * TERMS — the file Claude Code reads, the key it reads the server under — and
   * the diagnosis is checked against what applying then actually does, because a
   * report that cannot be trusted to match the write is the failure mode this
   * command exists to not have.
   *
   * What makes it fail: move the diagnosis into `@panda/cli` and there is nothing
   * to import here; compute it from a second code path and the `wouldWrite`
   * prediction stops matching `written`; let it prepare state and the byte
   * comparison of the untouched project directory fails.
   */
  it('diagnoses without writing, and what it predicted is what applying does', async () => {
    const { homeDir, projectDir } = await fixture()
    await writeFile(join(homeDir, '.claude.json'), '{\n  "numStartups": 7\n}\n', 'utf8')

    const store = new RegistryStore({ homeDir })
    await store.register({ type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, 'global')
    await store.dispose()

    const mcpPath = join(projectDir, '.mcp.json')
    const before = await readdir(projectDir)
    const diagnosis = await diagnose({ homeDir, scope: 'project', projectDir })

    // It named the file Claude Code reads for this project, and said projecting
    // would write it — without creating it, or panda's own directory beside it.
    expect(diagnosis.targets).toEqual([
      {
        executorId: 'claude-code',
        targetId: 'claude-mcp',
        filePath: mcpPath,
        wouldWrite: true,
        drift: [],
        unprojectable: [],
      },
    ])
    expect(diagnosis.findings.map((found) => found.kind)).toEqual(['not-initialised', 'out-of-date'])
    expect(await readdir(projectDir)).toEqual(before)
    await expect(stat(mcpPath)).rejects.toMatchObject({ code: 'ENOENT' })

    // Applying does exactly what the diagnosis said it would, and a second
    // diagnosis over the converged state is clean.
    const applied = await initProject({ homeDir, projectDir })
    expect(applied.targets[0]).toMatchObject({ filePath: mcpPath, written: true })
    expect(JSON.parse(await readFile(mcpPath, 'utf8'))).toEqual({
      mcpServers: {
        context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      },
    })
    expect((await diagnose({ homeDir, scope: 'project', projectDir })).findings).toEqual([])
  })
})
