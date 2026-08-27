import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProjectionConfigTarget, ProjectionLedgerRecord, RegistryEntriesByKind } from '@panda/contracts'
import { runProjection } from '../src/engine.ts'
import { ProjectionLedger } from '../src/ledger.ts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { createCodexConfigTarget } from '../src/targets/codex-config.ts'

// Drift is a LEDGER-versus-disk comparison, which is the whole reason
// ownership moved out of the vendor's file: a marker can only say "panda was
// here", while the ledger separates an entry the user EDITED from one the user
// DELETED from one panda never wrote at all. None of the three is resolved by
// writing.

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

const ENTRIES: RegistryEntriesByKind = {
  skill: [],
  'mcp-server': [
    { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  ],
  profile: [],
}

const EMPTY_REGISTRY: RegistryEntriesByKind = { skill: [], 'mcp-server': [], profile: [] }

const CLAUDE_NATIVE = `{
  "numStartups": 42,
  "mcpServers": {
    "linear": {
      "type": "sse",
      "url": "https://mcp.linear.app/sse"
    }
  }
}
`

const CODEX_NATIVE = `# User's codex configuration
model = "gpt-5-codex"

[mcp_servers.linear]
url = "https://mcp.linear.app/sse"
`

const claude = (): ProjectionConfigTarget => createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })
const codex = (): ProjectionConfigTarget => createCodexConfigTarget({ filePath: '/home/u/.codex/config.toml' })

async function project(target: ProjectionConfigTarget, nativeText: string) {
  return target.merge({ entries: ENTRIES, records: [], nativeText })
}

describe('a panda entry the user edited', () => {
  it('is reported as drift naming the entry and is NEVER overwritten', async () => {
    const target = claude()
    const first = await project(target, CLAUDE_NATIVE)
    const edited = first.text.replace('"command": "npx"', '"command": "npx --node-16"')

    const second = await target.merge({ entries: ENTRIES, records: first.records, nativeText: edited })

    expect(second.text).toBe(edited)
    expect(second.drift).toEqual([
      {
        kind: 'edited',
        entryId: 'context7',
        location: 'mcpServers.context7',
        detail: expect.stringContaining('edited since panda wrote it'),
      },
    ])
    // The claim survives, so the next run reports it again rather than
    // forgetting the entry and re-adding panda's version over the user's.
    expect(second.records).toEqual(first.records)
  })
})

describe('a panda entry the user removed', () => {
  it('is reported as removed-by-user and is not silently re-added', async () => {
    const target = claude()
    const first = await project(target, CLAUDE_NATIVE)

    // The ledger still claims context7; the file no longer has it.
    const second = await target.merge({
      entries: ENTRIES,
      records: first.records,
      nativeText: CLAUDE_NATIVE,
    })

    expect(second.text).toBe(CLAUDE_NATIVE)
    expect(second.drift).toEqual([
      {
        kind: 'removed-by-user',
        entryId: 'context7',
        location: 'mcpServers.context7',
        detail: expect.stringContaining('is gone'),
      },
    ])
    expect(second.records).toEqual(first.records)
  })
})

describe('a foreign entry with the same id', () => {
  it('is never touched and is reported as a collision panda will not resolve', async () => {
    const foreign = CLAUDE_NATIVE.replace('"linear"', '"context7"')
    const outcome = await project(claude(), foreign)

    expect(outcome.text).toBe(foreign)
    expect(outcome.records).toEqual([])
    expect(outcome.drift).toEqual([
      {
        kind: 'foreign-collision',
        entryId: 'context7',
        location: 'mcpServers.context7',
        detail: expect.stringContaining('ledger does not claim it'),
      },
    ])
  })
})

describe('an entry that left the registry', () => {
  it('removes EXACTLY the ledger-recorded region from a JSON file', async () => {
    const target = claude()
    const first = await project(target, CLAUDE_NATIVE)
    expect(first.text).not.toBe(CLAUDE_NATIVE)

    const second = await target.merge({
      entries: EMPTY_REGISTRY,
      records: first.records,
      nativeText: first.text,
    })

    expect(second.text).toBe(CLAUDE_NATIVE)
    expect(second.drift).toEqual([])
    expect(second.records).toEqual([])
  })

  it('removes EXACTLY the ledger-recorded table from a TOML file', async () => {
    const target = codex()
    const first = await project(target, CODEX_NATIVE)
    expect(first.text).toContain('[mcp_servers.context7]')

    const second = await target.merge({
      entries: EMPTY_REGISTRY,
      records: first.records,
      nativeText: first.text,
    })

    expect(second.text).toBe(CODEX_NATIVE)
    expect(second.records).toEqual([])
  })

  it('refuses to remove a region the user has since edited', async () => {
    const target = codex()
    const first = await project(target, CODEX_NATIVE)
    const edited = first.text.replace('command = "npx"', 'command = "npx-edited"')

    const second = await target.merge({
      entries: EMPTY_REGISTRY,
      records: first.records,
      nativeText: edited,
    })

    expect(second.text).toBe(edited)
    expect(second.drift[0]).toMatchObject({ kind: 'edited', entryId: 'context7' })
    expect(second.records).toEqual(first.records)
  })

  it('drops the claim silently when the region is already gone', async () => {
    const target = claude()
    const first = await project(target, CLAUDE_NATIVE)
    const second = await target.merge({
      entries: EMPTY_REGISTRY,
      records: first.records,
      nativeText: CLAUDE_NATIVE,
    })
    expect(second.drift).toEqual([])
    expect(second.records).toEqual([])
  })
})

describe('drift through the engine, on disk', () => {
  it('leaves the edited file byte-identical and reports the entry', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-drift-'))
    tempRoots.push(homeDir)
    const filePath = join(homeDir, '.claude.json')
    const target = createClaudeMcpTarget({ filePath })
    const ledger = new ProjectionLedger({ homeDir })
    await writeFile(filePath, CLAUDE_NATIVE, 'utf8')

    await runProjection({ entries: ENTRIES, targets: [target], ledger })
    const projected = await readFile(filePath, 'utf8')
    const edited = projected.replace('"command": "npx"', '"command": "my-own-npx"')
    await writeFile(filePath, edited, 'utf8')

    const run = await runProjection({ entries: ENTRIES, targets: [target], ledger })

    expect(run.failures).toEqual([])
    expect(run.results[0]).toMatchObject({ written: false, byteDelta: 0 })
    expect(run.results[0]!.drift[0]).toMatchObject({ kind: 'edited', entryId: 'context7' })
    expect(await readFile(filePath, 'utf8')).toBe(edited)
  })
})

describe('removal authority comes from the REGISTRY, never from unprojectability', () => {
  it('leaves an entry panda cannot render exactly where it is', async () => {
    const target = claude()
    const first = await project(target, CLAUDE_NATIVE)
    // `command` is optional in the canonical envelope: an entry can lose it
    // without leaving the registry. Deleting the user's server from every
    // config on that basis — and calling it "skipped" — is data loss.
    const commandless: RegistryEntriesByKind = {
      ...ENTRIES,
      'mcp-server': [{ type: 'mcp-server', id: 'context7' }],
    }

    const second = await target.merge({
      entries: commandless,
      records: first.records,
      nativeText: first.text,
    })

    expect(second.text).toBe(first.text)
    expect(second.records).toEqual(first.records)
    expect(second.skippedEntryIds).toContain('context7')
  })
})

describe('a record is authority only for its own key', () => {
  const foreignRecords = [
    ['another target', { targetId: 'someone-else' }],
    ['another file', { filePath: '/home/u/somewhere-else.json' }],
    ['another container key', { nativeLocation: 'panda.context7' }],
  ] as const

  it.each(foreignRecords)('ignores a record scoped to %s', async (_label, override) => {
    const target = claude()
    const first = await project(target, CLAUDE_NATIVE)
    const stale = { ...first.records[0]!, ...override }

    // Panda's own entry is on disk with a matching hash, but this record does
    // not address it. Treating it as authority would let a stale build's claim
    // license an overwrite — or a deletion — at the current key.
    const second = await target.merge({
      entries: EMPTY_REGISTRY,
      records: [stale],
      nativeText: first.text,
    })

    expect(second.text).toBe(first.text)
    expect(second.records).toEqual([])
  })
})

describe('formatting that changes nothing semantic is not an edit', () => {
  it('still owns its entries after the file is normalised to CRLF', async () => {
    const target = claude()
    const first = await project(target, CLAUDE_NATIVE)
    // git autocrlf, an editor, or Claude Code itself rewriting ~/.claude.json.
    const normalised = first.text.replaceAll('\n', '\r\n')

    const second = await target.merge({
      entries: ENTRIES,
      records: first.records,
      nativeText: normalised,
    })

    expect(second.drift).toEqual([])
    expect(second.records).toEqual(first.records)
  })

  it('still owns a TOML table after its header is re-spelled and re-indented', async () => {
    const target = codex()
    const first = await project(target, CODEX_NATIVE)
    const reformatted = first.text
      .replace('[mcp_servers.context7]', '[ mcp_servers."context7" ]')
      .replace('command = "npx"', '  command = "npx"')

    const second = await target.merge({
      entries: ENTRIES,
      records: first.records,
      nativeText: reformatted,
    })

    expect(second.drift).toEqual([])
    // Owned, so panda re-renders it in its own canonical form.
    expect(second.text).toContain('[mcp_servers.context7]')
  })

  it('still reports a REAL content change as edited', async () => {
    const target = claude()
    const first = await project(target, CLAUDE_NATIVE)
    const edited = first.text.replaceAll('\n', '\r\n').replace('"npx"', '"npx-mine"')

    const second = await target.merge({
      entries: ENTRIES,
      records: first.records,
      nativeText: edited,
    })

    expect(second.drift[0]).toMatchObject({ kind: 'edited', entryId: 'context7' })
    expect(second.text).toBe(edited)
  })
})

describe('the container panda created', () => {
  it('is reclaimed when panda removes its last entry, and only then', async () => {
    const target = createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })
    const bare = '{\n  "numStartups": 42\n}\n'
    const first = await target.merge({ entries: ENTRIES, records: [], nativeText: bare })
    expect(first.text).toContain('"mcpServers"')

    const second = await target.merge({
      entries: EMPTY_REGISTRY,
      records: first.records,
      nativeText: first.text,
    })

    // Byte-for-byte back to the file the user had: no empty scaffolding left.
    expect(second.text).toBe(bare)
  })

  it('is left alone when a foreign entry still lives in it', async () => {
    const target = claude()
    const first = await project(target, CLAUDE_NATIVE)
    const second = await target.merge({
      entries: EMPTY_REGISTRY,
      records: first.records,
      nativeText: first.text,
    })
    expect(second.text).toBe(CLAUDE_NATIVE)
    expect(second.text).toContain('"linear"')
  })

  it('does not accumulate blank lines across repeated renames', async () => {
    const target = createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })
    let text = '{\n  "numStartups": 42\n}\n'
    let records: readonly ProjectionLedgerRecord[] = []
    for (const id of ['one', 'two', 'three', 'four']) {
      const outcome = await target.merge({
        entries: { ...EMPTY_REGISTRY, 'mcp-server': [{ type: 'mcp-server', id, command: id }] },
        records,
        nativeText: text,
      })
      text = outcome.text
      records = outcome.records
    }
    expect(text).not.toMatch(/\n[ \t]*\n/)
    expect(text.match(/"mcpServers"/g)).toHaveLength(1)
  })
})
