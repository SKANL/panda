import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES } from '@skanl/panda-contracts'
import type { RegistryEntriesByKind } from '@skanl/panda-contracts'
import { readNativeMcpEntries } from '../src/formats.ts'
import type { NativeMcpRead, ProjectionTargetTraits } from '../src/formats.ts'
import { CLAUDE_MCP_TRAITS, createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { CODEX_CONFIG_TRAITS, createCodexConfigTarget } from '../src/targets/codex-config.ts'
import { OPENCODE_CONFIG_TRAITS, createOpenCodeConfigTarget } from '../src/targets/opencode-config.ts'

// The READ direction of the projection (M11.A): `readMcpEntry` on each trait
// record, and the one reader that walks a vendor's container through the SAME
// strategy the writer merges with.
//
// Every fixture below is written in the VENDOR's vocabulary, not panda's, and
// the round-trip clauses assert against `renderMcpEntry`'s own output rather
// than against a hand-copied shape — a hand-copied shape is a second answer that
// drifts from the renderer the first time a vendor changes.

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

async function fileWith(name: string, body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panda-mcp-read-'))
  tempRoots.push(root)
  const filePath = join(root, name)
  await writeFile(filePath, body, 'utf8')
  return filePath
}

async function read(traits: ProjectionTargetTraits, name: string, body: string): Promise<NativeMcpRead> {
  const result = await readNativeMcpEntries(traits, { filePath: await fileWith(name, body) })
  expect(result, 'the fixture file exists, so the reader must not report absence').toBeDefined()
  return result!
}

/** The reader's coded refusal, or a failure naming what it returned instead. */
async function refusal(traits: ProjectionTargetTraits, name: string, body: string): Promise<{ code: string; message: string }> {
  const filePath = await fileWith(name, body)
  const error = await readNativeMcpEntries(traits, { filePath }).then(
    (value) => {
      throw new Error(`expected a refusal, got ${JSON.stringify(value)}`)
    },
    (thrown: unknown) => thrown as { code: string; message: string },
  )
  return error
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

describe('E1/E2: a vendor that has nothing to say contributes nothing, and is not an error', () => {
  it('E1: reports ABSENCE, not failure, when the config file is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'panda-mcp-read-'))
    tempRoots.push(root)

    expect(await readNativeMcpEntries(CLAUDE_MCP_TRAITS, { filePath: join(root, 'nope.json') })).toBeUndefined()
    expect(await readNativeMcpEntries(CODEX_CONFIG_TRAITS, { filePath: join(root, 'nope.toml') })).toBeUndefined()
    // CONTROL: the very same reader DOES answer for a file that exists, so the
    // undefineds above are an absent path rather than a reader that never looks.
    const present = await read(CLAUDE_MCP_TRAITS, '.claude.json', json({ mcpServers: { a: { type: 'stdio', command: 'x' } } }))
    expect(present.entries.map((item) => item.id)).toEqual(['a'])
  })

  it('E2: a config with no container key holds no servers, and says so quietly', async () => {
    const claude = await read(CLAUDE_MCP_TRAITS, '.claude.json', json({ numStartups: 4 }))
    const codex = await read(CODEX_CONFIG_TRAITS, 'config.toml', 'model = "o3"\n')
    const opencode = await read(OPENCODE_CONFIG_TRAITS, 'opencode.json', json({ $schema: 'x' }))

    for (const result of [claude, codex, opencode]) {
      expect(result.entries).toEqual([])
      expect(result.unreadable).toEqual([])
    }
  })

  it('reads an empty JSON document as empty rather than as malformed', async () => {
    // The MERGE seeds a whitespace-only JSON file to `{}` so entries can be
    // added to it. Calling one malformed on the way in would refuse an ingest
    // over a file panda itself is happy to write into.
    expect((await read(CLAUDE_MCP_TRAITS, '.claude.json', '   \n')).entries).toEqual([])
  })
})

describe('E4: one server, in each vendor’s own vocabulary, round-trips through the renderer', () => {
  it.each([
    ['claude-mcp', CLAUDE_MCP_TRAITS, '.claude.json', json({ mcpServers: { fetch: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] } } })],
    ['codex-config', CODEX_CONFIG_TRAITS, 'config.toml', '[mcp_servers.fetch]\ncommand = "uvx"\nargs = ["mcp-server-fetch"]\n'],
    ['opencode-config', OPENCODE_CONFIG_TRAITS, 'opencode.json', json({ mcp: { fetch: { type: 'local', command: ['uvx', 'mcp-server-fetch'] } } })],
  ] as const)('%s reads back exactly what it would render', async (_id, traits, name, body) => {
    const result = await read(traits, name, body)

    expect(result.unreadable).toEqual([])
    expect(result.entries).toEqual([{ id: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], dropped: [] }])
    // The renderer/reader ROUND TRIP is deliberately not asserted here. The
    // obvious form — render both sides from values the line above already
    // proved equal, against a pure function — is a tautology that cannot fail.
    // The real one goes through a projected document on disk and lives in
    // `vendor-conformance.test.ts`, beside the vendor's own declared key set.
  })

  it("un-joins OpenCode's argv in the one place the join lives, and nowhere else", async () => {
    const result = await read(
      OPENCODE_CONFIG_TRAITS,
      'opencode.json',
      json({ mcp: { git: { type: 'local', command: ['uvx', 'mcp-server-git', '--repository', '.'] } } }),
    )

    expect(result.entries[0]).toMatchObject({ command: 'uvx', args: ['mcp-server-git', '--repository', '.'] })
  })
})

describe('E12: a server carrying more than panda can hold is ingested for what panda CAN hold', () => {
  it('names every dropped key, for every vendor, and never invents a root field for it', async () => {
    const claude = await read(
      CLAUDE_MCP_TRAITS,
      '.claude.json',
      json({ mcpServers: { a: { type: 'stdio', command: 'x', args: ['1'], env: { TOKEN: 'k' }, timeout: 30 } } }),
    )
    const codex = await read(
      CODEX_CONFIG_TRAITS,
      'config.toml',
      '[mcp_servers.a]\ncommand = "x"\nargs = ["1"]\nstartup_timeout_sec = 30\n\n[mcp_servers.a.env]\nTOKEN = "k"\n',
    )
    const opencode = await read(
      OPENCODE_CONFIG_TRAITS,
      'opencode.json',
      json({ mcp: { a: { type: 'local', command: ['x', '1'], enabled: true, environment: { TOKEN: 'k' } } } }),
    )

    expect(claude.entries[0]).toEqual({ id: 'a', command: 'x', args: ['1'], dropped: ['env', 'timeout'] })
    // The shape the mutation round found missing: an unconsumed key whose value
    // panda CAN hold. Everything above is an object, a number or a boolean, and
    // all of those are refused one layer earlier as a value no `NativeEntryShape`
    // can carry — so none of them ever reaches the drop list, and the list could
    // return `[]` unconditionally with every suite still green.
    const stringValued = await read(
      CLAUDE_MCP_TRAITS,
      '.claude.json',
      json({ mcpServers: { a: { type: 'stdio', command: 'x', args: ['1'], url: 'https://example.invalid' } } }),
    )
    expect(stringValued.entries[0]).toEqual({ id: 'a', command: 'x', args: ['1'], dropped: ['url'] })
    const stringArrayValued = await read(
      CODEX_CONFIG_TRAITS,
      'config.toml',
      '[mcp_servers.a]\ncommand = "x"\nargs = ["1"]\ntools = ["one", "two"]\n',
    )
    expect(stringArrayValued.entries[0]).toEqual({ id: 'a', command: 'x', args: ['1'], dropped: ['tools'] })
    expect(codex.entries[0]).toEqual({ id: 'a', command: 'x', args: ['1'], dropped: ['env', 'startup_timeout_sec'] })
    expect(opencode.entries[0]).toEqual({ id: 'a', command: 'x', args: ['1'], dropped: ['enabled', 'environment'] })
    // The entry is still CONTRIBUTED. Refusing it because panda cannot carry an
    // env table would drop a working server over a key panda never projects.
    for (const result of [claude, codex, opencode]) expect(result.unreadable).toEqual([])
  })
})

describe('E13 and its siblings: a native entry panda cannot represent is reported, never guessed', () => {
  it('E13: an OpenCode server whose command array is EMPTY has nothing to run', async () => {
    const result = await read(OPENCODE_CONFIG_TRAITS, 'opencode.json', json({ mcp: { a: { type: 'local', command: [] } } }))

    expect(result.entries).toEqual([])
    expect(result.unreadable).toEqual([{ id: 'a', detail: expect.stringContaining('empty array') as unknown as string }])
  })

  it('refuses a server that is not a command at all, in each vendor’s own spelling', async () => {
    const remoteClaude = await read(CLAUDE_MCP_TRAITS, '.claude.json', json({ mcpServers: { a: { type: 'http', url: 'https://x' }, b: { type: 'stdio', command: 'ok' } } }))
    const remoteOpen = await read(OPENCODE_CONFIG_TRAITS, 'opencode.json', json({ mcp: { a: { type: 'remote', url: 'https://x' }, b: { type: 'local', command: ['ok'] } } }))
    const noCommand = await read(CODEX_CONFIG_TRAITS, 'config.toml', '[mcp_servers.a]\nargs = ["1"]\n\n[mcp_servers.b]\ncommand = "ok"\n')

    for (const result of [remoteClaude, remoteOpen, noCommand]) {
      // CONTROL in every case: the sibling that IS readable came through, so the
      // refusal is about that entry and not about a container never walked.
      expect(result.entries.map((item) => item.id)).toEqual(['b'])
      expect(result.unreadable.map((item) => item.id)).toEqual(['a'])
    }
    expect(remoteClaude.unreadable[0]!.detail).toContain('stdio')
    expect(remoteOpen.unreadable[0]!.detail).toContain('local')
    expect(noCommand.unreadable[0]!.detail).toContain('command')
  })

  it('refuses a server whose `args` panda cannot READ, rather than dropping them', async () => {
    // `args` is a field the registry DOES carry, so a value panda cannot read is
    // not a key panda cannot hold. Reporting it as dropped registered the server
    // with NO arguments and then blamed its id — two false statements about one
    // entry, and a projected server that would run differently from the one the
    // user configured.
    const result = await read(
      CLAUDE_MCP_TRAITS,
      '.claude.json',
      json({ mcpServers: { bad: { command: 'uvx', args: ['ok', 7] }, good: { command: 'uvx', args: ['ok'] } } }),
    )

    // CONTROL: the sibling with readable args came through.
    expect(result.entries).toEqual([{ id: 'good', command: 'uvx', args: ['ok'], dropped: [] }])
    expect(result.unreadable).toEqual([{ id: 'bad', detail: expect.stringContaining("'args'") as unknown as string }])
    expect(result.unreadable[0]!.detail).not.toContain('id')
  })

  it('reports an OpenCode argv whose first element names no executable', async () => {
    // `['', 'x']` is not an empty array, and saying so described a file the user
    // does not have.
    const result = await read(OPENCODE_CONFIG_TRAITS, 'opencode.json', json({ mcp: { a: { type: 'local', command: ['', 'x'] } } }))

    expect(result.entries).toEqual([])
    expect(result.unreadable[0]!.detail).toContain('first element')
    expect(result.unreadable[0]!.detail).not.toContain('empty array')
  })

  it('reports a container member that is not an object at all', async () => {
    const result = await read(CLAUDE_MCP_TRAITS, '.claude.json', json({ mcpServers: { a: 'uvx', b: { type: 'stdio', command: 'ok' } } }))

    expect(result.entries.map((item) => item.id)).toEqual(['b'])
    expect(result.unreadable[0]!.detail).toContain('mcpServers.a')
  })

  it("refuses a TOML value panda did not write rather than guessing what it means", async () => {
    // `tomlValue` renders with JSON.stringify, so JSON.parse is its exact
    // inverse. A TOML literal string is legal TOML and is NOT that spelling —
    // and guessing would be reading a quote character as a command.
    const result = await read(CODEX_CONFIG_TRAITS, 'config.toml', "[mcp_servers.a]\ncommand = 'uvx'\n\n[mcp_servers.b]\ncommand = \"ok\"\n")

    expect(result.entries.map((item) => item.id)).toEqual(['b'])
    expect(result.unreadable[0]).toMatchObject({ id: 'a' })
    // The KEY and WHERE, never the value. This asserted `'uvx'` — the document's
    // own bytes echoed back — until M17.A, and that echo printed a planted
    // credential out of a real `config.toml`. The sibling clause above it always
    // named only `mcpServers.a`, which is why the JSONC reader never leaked and
    // is the shape this one was corrected to. `document-quoting.test.ts` is the
    // gate; this clause keeps its own subject, which is refusing to GUESS.
    expect(result.unreadable[0]!.detail).toContain('mcp_servers.a.command')
    expect(result.unreadable[0]!.detail).toContain('line 2, column 10')
  })

  it('reports a location the document spells twice rather than reading one of them', async () => {
    const toml = await read(CODEX_CONFIG_TRAITS, 'config.toml', '[mcp_servers.a]\ncommand = "one"\n\n[mcp_servers.a]\ncommand = "two"\n')
    // Lenient JSONC, so a doubled key parses; strict JSON would already have
    // refused the document, which the E7 clause below covers.
    const jsonc = await read(OPENCODE_CONFIG_TRAITS, 'opencode.json', '{"mcp":{"a":{"type":"local","command":["one"]},"a":{"type":"local","command":["two"]}}}')

    for (const result of [toml, jsonc]) {
      expect(result.entries).toEqual([])
      expect(result.unreadable[0]!.detail).toContain('a')
    }
  })
})

describe.skipIf(process.platform === 'win32')('a config panda may not OPEN is reported, not silently absent', () => {
    // POSIX only, and said out loud rather than skipped quietly: `chmod` is the
    // only portable way to make a real `EACCES`, and on win32 it does not deny
    // read access. CI runs Linux, so this clause does gate the branch — and
    // `mcp-source.test.ts` covers what the SOURCE does with the result on every
    // platform, so the behaviour is not win32-blind.
  it('reports the errno instead of throwing, and instead of saying nothing', async () => {
    const filePath = await fileWith('.claude.json', json({ mcpServers: { a: { command: 'x' } } }))
    // CONTROL FIRST: readable, the server is there. Without it a later empty
    // read would equally prove a fixture that never had a server in it.
    expect((await readNativeMcpEntries(CLAUDE_MCP_TRAITS, { filePath }))?.entries).toHaveLength(1)
    await chmod(filePath, 0o000)

    const result = await readNativeMcpEntries(CLAUDE_MCP_TRAITS, { filePath })

    // NOT undefined: undefined means "this executor is not installed" (AD-5),
    // and a config that is right there is a different fact. NOT a throw either:
    // one unreadable vendor file must not take the skills half of the same run
    // down with it.
    expect(result).toBeDefined()
    expect(result!.unreadableFile).toBe('EACCES')
    expect(result!.entries).toEqual([])
    await chmod(filePath, 0o600)
  })
})

describe('E7/E8: a document panda cannot merge into is refused on the way IN too (D8)', () => {
  it('E7: names the line and column, through the same strategy the writer uses', async () => {
    // Two families, ONE spelling, and it is the writer's own: both refuse
    // through `positionOf`, which spells it `line N, column M`.
    //
    // This clause read `(line N column M)` for the strict family until M17.A —
    // V8's own words, passed through. That is the string the credential
    // travelled in, so it is gone (M17.A/D1) and the strict family now derives
    // its location from jsonc-parser's offsets like the lenient one. The FACT
    // the clause names is unchanged: the user is told where.
    const strict = await refusal(CLAUDE_MCP_TRAITS, '.claude.json', '{"mcpServers": {"a": {"command": "x"},,}}')
    const lenient = await refusal(OPENCODE_CONFIG_TRAITS, 'opencode.json', '{"mcp": {a: {"command": "x"}}}')

    expect(strict.code).toBe(PANDA_ERROR_CODES.projectionNativeMalformed)
    expect(strict.message).toMatch(/line \d+, column \d+/)
    expect(lenient.code).toBe(PANDA_ERROR_CODES.projectionNativeMalformed)
    expect(lenient.message).toMatch(/line \d+, column \d+/)
  })

  it('E7: a JSONC-tolerant target still accepts comments and trailing commas', async () => {
    // The control for the clause above: refusing on ANY parse error would reject
    // working files, which is the defect `allowTrailingComma` exists to avoid.
    const result = await read(
      OPENCODE_CONFIG_TRAITS,
      'opencode.json',
      '{\n  // a comment\n  "mcp": {\n    "a": {"type": "local", "command": ["x"],},\n  },\n}\n',
    )

    expect(result.entries.map((item) => item.id)).toEqual(['a'])
  })

  it('E8: names the container key when it holds something panda cannot address', async () => {
    const held = await refusal(CLAUDE_MCP_TRAITS, '.claude.json', json({ mcpServers: ['a'] }))
    const table = await refusal(CODEX_CONFIG_TRAITS, 'config.toml', '[mcp_servers]\na = "x"\n')
    const assigned = await refusal(CODEX_CONFIG_TRAITS, 'config.toml', 'mcp_servers = { a = "x" }\n')

    expect(held.code).toBe(PANDA_ERROR_CODES.projectionNativeUnclaimable)
    expect(held.message).toContain('mcpServers')
    for (const error of [table, assigned]) {
      expect(error.code).toBe(PANDA_ERROR_CODES.projectionNativeUnclaimable)
      expect(error.message).toContain('mcp_servers')
    }
  })
})

describe('D4 case (ii): content panda WOULD write is already satisfied, not a collision', () => {
  const entries = (command: string, args: readonly string[]): RegistryEntriesByKind => ({
    skill: [],
    'mcp-server': [{ type: 'mcp-server', id: 'ctx', command, args: [...args] }],
  })

  /** The document panda itself produces for that entry, from an empty container. */
  async function pandasOwnOutput(target: ReturnType<typeof createClaudeMcpTarget>, seed: string, kind: RegistryEntriesByKind): Promise<string> {
    return (await target.merge({ nativeText: seed, entries: kind, records: [] })).text
  }

  it.each([
    ['claude-mcp', () => createClaudeMcpTarget({ filePath: '/unused/.claude.json' }), json({ numStartups: 7, mcpServers: {} })],
    ['codex-config', () => createCodexConfigTarget({ filePath: '/unused/config.toml' }), 'model = "o3"\n'],
    ['opencode-config', () => createOpenCodeConfigTarget({ filePath: '/unused/opencode.json' }), json({ $schema: 'x', mcp: {} })],
  ] as const)('%s: an unclaimed entry identical to panda’s own output is silent', async (_id, make, seed) => {
    const target = make()
    // The fixture is what panda itself writes, so "the bytes would be the same
    // bytes" is MEASURED here rather than assumed — which is the claim the
    // original D4 asserted without executing it.
    const written = await pandasOwnOutput(target, seed, entries('npx', ['-y', 'x']))

    const outcome = await target.merge({ nativeText: written, entries: entries('npx', ['-y', 'x']), records: [] })

    expect(outcome.drift).toEqual([])
    expect(outcome.text).toBe(written)
    // NOT ADOPTED: panda did not write those bytes, so it claims nothing. A
    // record here would make the release remediation an authority to delete a
    // server the user owns.
    expect(outcome.records).toEqual([])
    expect(outcome.ownedSpans).toEqual([])
  })

  it.each([
    ['claude-mcp', () => createClaudeMcpTarget({ filePath: '/unused/.claude.json' }), json({ numStartups: 7, mcpServers: {} })],
    ['codex-config', () => createCodexConfigTarget({ filePath: '/unused/config.toml' }), 'model = "o3"\n'],
    ['opencode-config', () => createOpenCodeConfigTarget({ filePath: '/unused/opencode.json' }), json({ $schema: 'x', mcp: {} })],
  ] as const)('%s CONTROL: one argument different and it is STILL a foreign collision', async (_id, make, seed) => {
    const target = make()
    const written = await pandasOwnOutput(target, seed, entries('npx', ['-y', 'x']))

    // A comparison that answers "satisfied" for everything is not a comparison.
    const outcome = await target.merge({ nativeText: written, entries: entries('npx', ['-y', 'somebody-else']), records: [] })

    expect(outcome.drift).toMatchObject([{ kind: 'foreign-collision', entryId: 'ctx' }])
    expect(outcome.text).toBe(written)
    expect(outcome.records).toEqual([])
  })

  it.each([
    [
      'codex-config: args before command, a comment in the table, odd spacing',
      () => createCodexConfigTarget({ filePath: '/unused/config.toml' }),
      '# my servers\n[mcp_servers.ctx]\n# the upstream one\nargs   = ["-y",  "x"]\ncommand="npx"\n',
    ],
    [
      'opencode-config: one line, no type, extra whitespace',
      () => createOpenCodeConfigTarget({ filePath: '/unused/opencode.json' }),
      '{\n  "mcp": { "ctx": {"command":   ["npx", "-y", "x"] } }\n}\n',
    ],
    [
      'claude-mcp: one line, reordered keys, no type',
      () => createClaudeMcpTarget({ filePath: '/unused/.claude.json' }),
      '{\n  "mcpServers": { "ctx": {"args": ["-y", "x"], "command": "npx"} }\n}\n',
    ],
  ] as const)('%s is satisfied, because the comparison is about what RUNS', async (_label, make, handWritten) => {
    // Hand-formatted the way a person writes it, per vendor — key order,
    // spacing, a comment, an absent `type`. A comparison against rendered bytes
    // called every one of these a collision and sent the user to `adopt` for a
    // file that already says the right thing.
    const outcome = await make().merge({ nativeText: handWritten, entries: entries('npx', ['-y', 'x']), records: [] })

    expect(outcome.drift).toEqual([])
    expect(outcome.text).toBe(handWritten)
    expect(outcome.records).toEqual([])
  })

  it.each([
    ['codex-config', () => createCodexConfigTarget({ filePath: '/unused/config.toml' }), '[mcp_servers.ctx]\nargs = ["-y", "x"]\ncommand = "npx"\n'],
    ['opencode-config', () => createOpenCodeConfigTarget({ filePath: '/unused/opencode.json' }), '{"mcp":{"ctx":{"command":["npx","-y","x"]}}}'],
    ['claude-mcp', () => createClaudeMcpTarget({ filePath: '/unused/.claude.json' }), '{"mcpServers":{"ctx":{"command":"npx","args":["-y","x"]}}}'],
  ] as const)('%s CONTROL: hand-formatted but running something ELSE still collides', async (_label, make, handWritten) => {
    const outcome = await make().merge({
      nativeText: handWritten,
      entries: entries('npx', ['-y', 'somebody-else']),
      records: [],
    })

    expect(outcome.drift).toMatchObject([{ kind: 'foreign-collision', entryId: 'ctx' }])
    expect(outcome.text).toBe(handWritten)
  })

  it('is satisfied for the MINIMAL entry a real config holds — no type, no args', async () => {
    // The shape the acceptance fixture never had, and the reason the first build
    // of this comparison passed its own suite while failing every real machine.
    const target = createClaudeMcpTarget({ filePath: '/unused/.claude.json' })
    const minimal = '{\n  "mcpServers": { "ctx": { "command": "npx" } }\n}\n'

    const outcome = await target.merge({ nativeText: minimal, entries: entries('npx', []), records: [] })

    expect(outcome.drift).toEqual([])
    expect(outcome.text).toBe(minimal)
  })

  it('is satisfied for an entry carrying a key panda cannot represent', async () => {
    // The two halves of the story must agree: the reader deliberately INGESTS
    // this entry and reports `env` dropped, so the projection must not then call
    // the same entry a permanent collision whose only exit deletes the `env`.
    const target = createClaudeMcpTarget({ filePath: '/unused/.claude.json' })
    const withEnv = `{\n  "mcpServers": { "ctx": {"type": "stdio", "command": "npx", "args": ["-y", "x"], "env": {"T": "1"}} }\n}\n`

    const outcome = await target.merge({ nativeText: withEnv, entries: entries('npx', ['-y', 'x']), records: [] })

    expect(outcome.drift).toEqual([])
    expect(outcome.text).toBe(withEnv)
  })

  it('ignores formatting, because the comparison is about what RUNS, not about bytes', async () => {
    // Same entry, hand-formatted the way a user writes it: one line, different
    // key order, extra spaces. A byte comparison would call this a collision and
    // send the user to `adopt` for a file that already says the right thing.
    const target = createClaudeMcpTarget({ filePath: '/unused/.claude.json' })
    const handWritten = '{\n  "mcpServers": { "ctx": {"args": ["-y", "x"], "command": "npx", "type": "stdio"} }\n}\n'

    const outcome = await target.merge({ nativeText: handWritten, entries: entries('npx', ['-y', 'x']), records: [] })

    expect(outcome.drift).toEqual([])
    expect(outcome.text).toBe(handWritten)
  })
})

describe('AC5: the inverse is REQUIRED, and its absence is a type error', () => {
  it('refuses a trait record that renders but cannot read, at compile time', () => {
    const incomplete = {
      targetId: 'no-inverse',
      fileFormat: 'jsonc',
      defaultPath: '/unused',
      mcpContainerKey: 'servers',
      renderMcpEntry: (entry: { command: string; args: readonly string[] }) => ({ command: entry.command, args: entry.args }),
    }
    // @ts-expect-error `readMcpEntry` is missing, and a target that can be
    // projected into but never read back is the exact asymmetry M11.A removes.
    const refused: ProjectionTargetTraits = incomplete
    // The clause is the directive above; this keeps the binding live so a
    // reviewer deleting the annotation gets an unused-variable failure too.
    expect(refused.targetId).toBe('no-inverse')
  })

  it('every shipped config target implements it', () => {
    for (const traits of [CLAUDE_MCP_TRAITS, CODEX_CONFIG_TRAITS, OPENCODE_CONFIG_TRAITS]) {
      expect(typeof traits.readMcpEntry, traits.targetId).toBe('function')
      // And it ANSWERS on a shape it cannot use, rather than throwing.
      expect(traits.readMcpEntry({}).ok).toBe(false)
    }
  })
})
