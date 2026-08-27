import { describe, expect, it } from 'vitest'
import type { RegistryEntriesByKind } from '@panda/contracts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { createCodexConfigTarget } from '../src/targets/codex-config.ts'

// "locate found nothing" is NOT "the location is free".
//
// Every document below already defines the server panda is about to write, in
// a spelling panda cannot claim. Appending anyway produces a SECOND definition
// of the same TOML table — a hard parse error that stops the user's entire
// config.toml from loading, in DEFAULT mode, no flag required. That is the
// catastrophe correction-01 exists to eliminate, and it is reachable through
// nothing more exotic than a space inside the brackets.

const ENTRIES: RegistryEntriesByKind = {
  skill: [],
  'mcp-server': [{ type: 'mcp-server', id: 'ctx', command: 'npx', args: ['-y', 'ctx'] }],
  profile: [],
}

const codex = () => createCodexConfigTarget({ filePath: '/home/u/.codex/config.toml' })
const claude = () => createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })

describe('a Codex config that already defines the server', () => {
  it.each([
    ['whitespace inside the brackets', '[ mcp_servers.ctx ]\ncommand = "mine"\n'],
    ['a basic-quoted key', '[mcp_servers."ctx"]\ncommand = "mine"\n'],
    ['a literal-quoted key', "[mcp_servers.'ctx']\ncommand = \"mine\"\n"],
    ['a trailing comment', '[mcp_servers.ctx] # mine, hands off\ncommand = "mine"\n'],
    ['a dotted assignment', 'mcp_servers.ctx = { command = "mine" }\n'],
    ['an inline table', 'mcp_servers = { ctx = { command = "mine" } }\n'],
    ['a container table', '[mcp_servers]\nctx = { command = "mine" }\n'],
  ])('never appends a duplicate definition when it uses %s', async (_label, native) => {
    const outcome = await codex().merge({ entries: ENTRIES, records: [], nativeText: native })

    expect(outcome.text).toBe(native)
    // One definition in, one definition out.
    expect(outcome.text.match(/mcp_servers/g)).toHaveLength(native.match(/mcp_servers/g)!.length)
    expect(outcome.drift).toHaveLength(1)
    expect(outcome.drift[0]).toMatchObject({ kind: 'foreign-collision', entryId: 'ctx' })
    expect(outcome.records).toEqual([])
  })

  it('reports a doubly-defined table without adding a third', async () => {
    const native = '[mcp_servers.ctx]\ncommand = "a"\n\n[ mcp_servers."ctx" ]\ncommand = "b"\n'
    const outcome = await codex().merge({ entries: ENTRIES, records: [], nativeText: native })

    expect(outcome.text).toBe(native)
    expect(outcome.drift[0]).toMatchObject({ kind: 'foreign-collision', entryId: 'ctx' })
    expect(outcome.drift[0]!.detail).toContain('defined 2 times')
  })

  it('refuses to REMOVE through an unclaimable container too', async () => {
    // The ledger claims ctx, the registry dropped it — but the document now
    // spells the container in a form panda cannot address. Removing by guess
    // is how a config loses a server the user still wants.
    const native = '[mcp_servers]\nctx = { command = "mine" }\n'
    const outcome = await codex().merge({
      entries: { skill: [], 'mcp-server': [], profile: [] },
      records: [
        {
          targetId: 'codex-config',
          filePath: '/home/u/.codex/config.toml',
          nativeLocation: 'mcp_servers.ctx',
          entryId: 'ctx',
          contentHash: 'whatever',
        },
      ],
      nativeText: native,
    })

    expect(outcome.text).toBe(native)
    expect(outcome.drift[0]).toMatchObject({ kind: 'foreign-collision', entryId: 'ctx' })
  })

  it('still projects normally into a document with an unrelated container', async () => {
    // The conflict scan must not fire on a foreign table that merely mentions
    // the container name deeper in the document.
    const native = '[profiles]\nmcp_servers = "not ours"\n'
    const outcome = await codex().merge({ entries: ENTRIES, records: [], nativeText: native })
    expect(outcome.text).toContain('[mcp_servers.ctx]')
    expect(outcome.drift).toEqual([])
  })
})

describe('a JSON config that declares the same id twice', () => {
  it('writes nothing: panda would edit the first while every vendor reads the last', async () => {
    const native = '{"mcpServers": {"ctx": {"command": "first"}, "ctx": {"command": "last"}}}'
    const outcome = await claude().merge({ entries: ENTRIES, records: [], nativeText: native })

    expect(outcome.text).toBe(native)
    expect(outcome.drift[0]).toMatchObject({ kind: 'foreign-collision', entryId: 'ctx' })
    expect(outcome.drift[0]!.detail).toContain('more than once')
    expect(outcome.records).toEqual([])
  })
})
