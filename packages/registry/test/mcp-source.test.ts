import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import type { RegistryEntry } from '@panda/contracts'
import { ingestProviders } from '../src/ingest.ts'
import { MACHINE_MCP_SOURCE_ID, createMachineMcpSource } from '../src/mcp-source.ts'
import { MACHINE_SKILLS_SOURCE_ID } from '../src/skills-source.ts'
import type { McpSourceLocation, McpSourceReading } from '../src/mcp-source.ts'
import { RegistryStore } from '../src/store.ts'

// The machine `ToolProvider`: which candidates it offers, which it declines, and
// what it says about the ones it declined.
//
// The READING is injected, exactly as production injects it, because AD-2 keeps
// the vendor formats in a package above this one. That is not a convenience for
// the test: a source that knew how to parse `~/.claude.json` would be the
// topology inversion the option exists to prevent.

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {}))))

async function homeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panda-mcp-source-'))
  tempRoots.push(root)
  return root
}

function entry(id: string, command: string, args: readonly string[] = [], dropped: readonly string[] = []) {
  return { id, command, args, dropped }
}

function location(targetId: string, filePath: string, reading: McpSourceReading | undefined): McpSourceLocation {
  return { targetId, filePath, read: async () => await Promise.resolve(reading) }
}

/** A location that fails on its own terms, the way a malformed document does. */
function refusing(targetId: string, filePath: string, error: unknown): McpSourceLocation {
  return {
    targetId,
    filePath,
    read: () => Promise.reject(error),
  }
}

describe('the ownership identity of every origin is a PINNED literal', () => {
  it('is the exact string a previously ingested entry recorded, for both sources', () => {
    // Both constants document that stability "is the whole of its job", because
    // `ingestProviders` refuses to overwrite an entry owned by a DIFFERENT
    // origin: rename the value and every entry a user already ingested becomes
    // an unrelocatable conflict with no exit through the product. Every other
    // test references the constant, so a renamed VALUE was invisible in all of
    // them — which makes the sentence a guarantee with nothing that fails.
    //
    // Both spelled out, not one: the skills source has the identical gap and
    // fixing one while leaving its twin is how the next rename goes unnoticed.
    expect(MACHINE_MCP_SOURCE_ID).toBe('panda.machine-mcp')
    expect(MACHINE_SKILLS_SOURCE_ID).toBe('panda.machine-skills')
  })
})

describe('E4: a server no ledger claims becomes an mcp-server entry', () => {
  it('carries the vendor’s own id, command and args, and nothing else', async () => {
    const source = createMachineMcpSource({
      locations: [location('claude-mcp', '/a/.claude.json', { entries: [entry('fetch', 'uvx', ['mcp-server-fetch'])], unreadable: [] })],
    })

    const listed = await source.list()

    expect(listed).toEqual([{ type: 'mcp-server', id: 'fetch', command: 'uvx', args: ['mcp-server-fetch'] }])
    expect(source.sourceId).toBe(MACHINE_MCP_SOURCE_ID)
    expect(source.warnings).toEqual([])
    expect(source.excluded).toEqual([])
  })

  it('E1: a location whose file is absent contributes nothing and is not an error', async () => {
    const source = createMachineMcpSource({
      locations: [
        location('claude-mcp', '/a/.claude.json', undefined),
        // CONTROL: the sibling location still contributes, so the silence above
        // is one absent file rather than a loop that stopped.
        location('codex-config', '/a/config.toml', { entries: [entry('time', 'uvx')], unreadable: [] }),
      ],
    })

    expect((await source.list()).map((item) => item.id)).toEqual(['time'])
    expect(source.warnings).toEqual([])
  })

  it('E3: a machine with no servers at all is an empty-source warning and exit 0', async () => {
    const home = await homeDir()
    const store = new RegistryStore({ homeDir: home })
    const source = createMachineMcpSource({
      // Container present and empty reads as zero entries, which is the same
      // fact as a config with no container: the origin worked and had nothing.
      locations: [location('claude-mcp', '/a/.claude.json', { entries: [], unreadable: [] })],
    })

    try {
      const outcome = await ingestProviders(store, { toolProviders: [source] })
      expect(outcome.registered).toEqual([])
      expect(outcome.warnings).toEqual([
        { kind: 'empty-source', sourceId: MACHINE_MCP_SOURCE_ID, detail: expect.stringContaining(MACHINE_MCP_SOURCE_ID) as unknown as string },
      ])
    } finally {
      await store.dispose()
    }
  })
})

describe('E5/D3: an entry the ownership ledger claims is never re-ingested', () => {
  it('matches on targetId AND entryId, never on the rendered native location', async () => {
    const source = createMachineMcpSource({
      locations: [
        location('claude-mcp', '/a/.claude.json', { entries: [entry('ctx', 'npx'), entry('mine', 'node')], unreadable: [] }),
        location('codex-config', '/a/config.toml', { entries: [entry('ctx', 'npx')], unreadable: [] }),
      ],
      // Panda wrote `ctx` into CODEX only. The claude copy is the user's own and
      // must still be offered — which is exactly what a match on the rendered
      // `<container>.<id>` could not express, because both render to a location
      // ending in `.ctx`.
      ownedEntries: [{ targetId: 'codex-config', entryId: 'ctx', nativeLocation: 'mcp_servers.ctx' }],
    })

    const listed = await source.list()

    expect(listed.map((item) => item.id).sort()).toEqual(['ctx', 'mine'])
    // The caller's own record comes back whole, so the location beside an
    // exclusion is the one that caused it rather than a second derivation.
    expect(source.excluded).toEqual([
      { targetId: 'codex-config', entryId: 'ctx', nativeLocation: 'mcp_servers.ctx', filePath: '/a/config.toml' },
    ])
  })

  it('offers nothing at all once panda owns every copy, and the second list() does not double-report', async () => {
    const source = createMachineMcpSource({
      locations: [location('claude-mcp', '/a/.claude.json', { entries: [entry('ctx', 'npx')], unreadable: [] })],
      ownedEntries: [{ targetId: 'claude-mcp', entryId: 'ctx', nativeLocation: 'mcpServers.ctx' }],
    })

    expect(await source.list()).toEqual([])
    await source.list()
    // Replaced rather than appended to: a second list over an unchanged machine
    // must report what it saw, not twice what it saw.
    expect(source.excluded).toHaveLength(1)
  })
})

describe('a config panda could not READ is a per-origin warning, never silence', () => {
  it('reports the file and steps over it, and the other locations still contribute', async () => {
    const source = createMachineMcpSource({
      locations: [
        location('claude-mcp', '/a/.claude.json', { entries: [], unreadable: [], unreadableFile: 'EACCES' }),
        location('codex-config', '/a/config.toml', { entries: [entry('still-here', 'uvx')], unreadable: [] }),
      ],
    })

    const listed = await source.list()

    // CONTROL: the sibling landed, so the warning is one unreadable file rather
    // than a run that stopped. And it is a WARNING, not a throw: `EACCES` on one
    // vendor config must not take the skills half of the same run down with it.
    expect(listed.map((item) => item.id)).toEqual(['still-here'])
    expect(source.warnings).toEqual([
      {
        kind: 'unreadable-config',
        path: '/a/.claude.json',
        detail: expect.stringContaining('EACCES') as unknown as string,
      },
    ])
    // Not silence either: a run that said nothing would tell a user their
    // servers were considered when they were never opened.
    expect(source.warnings[0]!.detail).toContain('not considered')
  })

  it('is a DIFFERENT fact from an absent file, which contributes nothing and warns nothing', async () => {
    const absent = createMachineMcpSource({ locations: [location('claude-mcp', '/a/.claude.json', undefined)] })

    await absent.list()

    expect(absent.warnings).toEqual([])
  })
})

describe('E9: an id the registry contract refuses is reported and skipped', () => {
  it('skips it and lets the rest of the run proceed', async () => {
    const source = createMachineMcpSource({
      locations: [
        location('claude-mcp', '/a/.claude.json', {
          entries: [entry('constructor', 'npx'), entry('__proto__', 'npx'), entry('fine', 'npx')],
          unreadable: [],
        }),
      ],
    })

    const listed = await source.list()

    // CONTROL: `fine` came through, so the two skips are the ids and not a
    // location that was never read.
    expect(listed.map((item) => item.id)).toEqual(['fine'])
    expect(source.warnings.map((item) => item.kind)).toEqual(['unusable-id', 'unusable-id'])
    expect(source.warnings[0]!.detail).toContain('constructor')
    expect(source.warnings[0]!.detail).toContain('/a/.claude.json')
    expect(source.warnings[0]!.detail).toContain('cannot be a registry id')
  })

  it('does NOT blame the id when the fault is in the value', async () => {
    // The registry refuses `command: ''` for a reason that has nothing to do
    // with ids, and printing the id sentence for it sent a user looking at the
    // wrong half of their own entry.
    const source = createMachineMcpSource({
      locations: [location('claude-mcp', '/a/.claude.json', { entries: [entry('fine-id', '')], unreadable: [] })],
    })

    expect(await source.list()).toEqual([])
    expect(source.warnings[0]!.kind).toBe('unreadable-entry')
    expect(source.warnings[0]!.detail).not.toContain('cannot be a registry id')
    expect(source.warnings[0]!.detail).toContain("'command'")
  })

  it('filters BEFORE the driver, because the driver raises for the whole run', async () => {
    const home = await homeDir()
    const store = new RegistryStore({ homeDir: home })
    const source = createMachineMcpSource({
      locations: [location('claude-mcp', '/a/.claude.json', { entries: [entry('constructor', 'npx'), entry('fine', 'npx')], unreadable: [] })],
    })

    try {
      const outcome = await ingestProviders(store, { toolProviders: [source] })
      expect(outcome.registered).toEqual(['mcp-server:fine'])
    } finally {
      await store.dispose()
    }
  })
})

describe('E13-adjacent: an entry the reader could not represent is reported by the source too', () => {
  it('names the id, the file and the reason, and does not stop the run', async () => {
    const source = createMachineMcpSource({
      locations: [
        location('opencode-config', '/a/opencode.json', {
          entries: [entry('good', 'uvx')],
          unreadable: [{ id: 'empty', detail: "'command' is an empty array, so there is no command to run" }],
        }),
      ],
    })

    expect((await source.list()).map((item) => item.id)).toEqual(['good'])
    expect(source.warnings).toEqual([
      {
        kind: 'unreadable-entry',
        path: '/a/opencode.json',
        detail: expect.stringContaining('empty array') as unknown as string,
      },
    ])
  })
})

describe('E12/D10: what did not travel is named with the file it stayed in', () => {
  it('reports the dropped keys of the entry it actually offered', async () => {
    const source = createMachineMcpSource({
      locations: [location('claude-mcp', '/a/.claude.json', { entries: [entry('ctx', 'npx', ['-y'], ['env', 'timeout'])], unreadable: [] })],
    })

    await source.list()

    expect(source.dropped).toEqual([{ entryId: 'ctx', filePath: '/a/.claude.json', keys: ['env', 'timeout'] }])
  })

  it('says nothing about an entry that carried nothing extra', async () => {
    const source = createMachineMcpSource({
      locations: [location('claude-mcp', '/a/.claude.json', { entries: [entry('ctx', 'npx', ['-y'])], unreadable: [] })],
    })

    await source.list()

    expect(source.dropped).toEqual([])
  })
})

describe('E10/E11 — D7: two executors offering one id, split on rendered content', () => {
  it('E10: identical command and args means there is no decision to make', async () => {
    const source = createMachineMcpSource({
      locations: [
        location('claude-mcp', '/a/.claude.json', { entries: [entry('ctx', 'npx', ['-y', 'x'])], unreadable: [] }),
        location('codex-config', '/a/config.toml', { entries: [entry('ctx', 'npx', ['-y', 'x'])], unreadable: [] }),
      ],
    })

    const listed = await source.list()

    expect(listed).toEqual([{ type: 'mcp-server', id: 'ctx', command: 'npx', args: ['-y', 'x'] }])
    expect(source.warnings).toEqual([])
  })

  it('E10: the FIRST-consulted location wins, and the order is the caller’s own', async () => {
    // Not a preference invented here: the order is the one production declares,
    // and it is what makes a second run over an unchanged machine stable.
    const forward = createMachineMcpSource({
      locations: [
        location('claude-mcp', '/a/.claude.json', { entries: [entry('ctx', 'npx', ['-y'], ['env'])], unreadable: [] }),
        location('codex-config', '/a/config.toml', { entries: [entry('ctx', 'npx', ['-y'])], unreadable: [] }),
      ],
    })
    const reversed = createMachineMcpSource({
      locations: [
        location('codex-config', '/a/config.toml', { entries: [entry('ctx', 'npx', ['-y'])], unreadable: [] }),
        location('claude-mcp', '/a/.claude.json', { entries: [entry('ctx', 'npx', ['-y'], ['env'])], unreadable: [] }),
      ],
    })

    await forward.list()
    await reversed.list()

    // Same entry either way — the rendering is identical — but the report names
    // the copy that was actually taken, which is the first one consulted.
    expect(forward.dropped).toEqual([{ entryId: 'ctx', filePath: '/a/.claude.json', keys: ['env'] }])
    expect(reversed.dropped).toEqual([])
  })

  it('E11: a difference in what runs means panda offers NEITHER and names both', async () => {
    const source = createMachineMcpSource({
      locations: [
        location('claude-mcp', '/a/.claude.json', { entries: [entry('ctx', 'npx', ['-y', 'one']), entry('safe', 'node')], unreadable: [] }),
        location('codex-config', '/a/config.toml', { entries: [entry('ctx', 'npx', ['-y', 'two'])], unreadable: [] }),
      ],
    })

    const listed = await source.list()

    // CONTROL: `safe` still travels, so the refusal is about `ctx` alone.
    expect(listed.map((item) => item.id)).toEqual(['safe'])
    expect(source.warnings).toHaveLength(1)
    const [warning] = source.warnings
    expect(warning).toMatchObject({ kind: 'id-collision', path: '/a/.claude.json' })
    // ONE warning naming EVERY location, because a user deciding which copy to
    // keep needs all of them.
    expect(warning!.detail).toContain('/a/.claude.json')
    expect(warning!.detail).toContain('/a/config.toml')
  })

  it('E11: a differing COMMAND is a difference too, not only differing args', async () => {
    const source = createMachineMcpSource({
      locations: [
        location('claude-mcp', '/a/.claude.json', { entries: [entry('ctx', 'npx', ['-y'])], unreadable: [] }),
        location('codex-config', '/a/config.toml', { entries: [entry('ctx', 'uvx', ['-y'])], unreadable: [] }),
      ],
    })

    expect(await source.list()).toEqual([])
    expect(source.warnings.map((item) => item.kind)).toEqual(['id-collision'])
  })
})

describe('a location that fails on its own terms fails the whole run, with nothing written', () => {
  it('E7/E8: the coded refusal reaches the caller and the store is untouched', async () => {
    const home = await homeDir()
    const store = new RegistryStore({ homeDir: home })
    const malformed = new PandaError(PANDA_ERROR_CODES.projectionNativeMalformed, "native config file '/a/.claude.json' is malformed: line 3, column 7")
    const source = createMachineMcpSource({
      locations: [
        refusing('claude-mcp', '/a/.claude.json', malformed),
        location('codex-config', '/a/config.toml', { entries: [entry('would-have-landed', 'uvx')], unreadable: [] }),
      ],
    })

    try {
      const error = await ingestProviders(store, { toolProviders: [source] }).then(
        () => undefined,
        (thrown: unknown) => thrown as PandaError,
      )

      expect(error).toBeInstanceOf(PandaError)
      // The driver's own code for an origin that failed while listing; the
      // location the strategy named survives in the message.
      expect(error!.code).toBe(PANDA_ERROR_CODES.registryProviderRejected)
      expect(error!.message).toMatch(/line \d+, column \d+/)
      // Phase 1 collects everything before phase 2 writes anything, so the
      // sibling entry never lands either.
      expect(await store.list('global')).toEqual([] as RegistryEntry[])
    } finally {
      await store.dispose()
    }
  })
})
