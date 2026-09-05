import { parse as parseJsonc } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { REGISTRY_ENTRY_TYPES } from '@skanl/panda-contracts'
import type { ProjectionMergeOutcome, RegistryEntriesByKind } from '@skanl/panda-contracts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { createCodexConfigTarget } from '../src/targets/codex-config.ts'
import { createOpenCodeConfigTarget } from '../src/targets/opencode-config.ts'
import { withoutOwnedSpans } from './clause-suite.ts'

// Each target lands the SAME registry entry in a DIFFERENT vendor's vocabulary
// at that vendor's own location. These are the I/O matrix rows for the three
// executors, asserted in the executors' terms — including the two facts that
// made the previous build inert: Claude reads MCP servers from ~/.claude.json
// (never settings.json), and OpenCode's `command` IS the argv.

const ENTRIES: RegistryEntriesByKind = {
  skill: [{ type: 'skill', id: 'commit-lint', entryPath: '~/.panda/skills/commit-lint.ts' }],
  'mcp-server': [
    { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  ],
}

const CLAUDE_NATIVE = `{
  "numStartups": 42,
  "mcpServers": {
    "linear": {
      "type": "sse",
      "url": "https://mcp.linear.app/sse"
    }
  },
  "installMethod": "native"
}
`

const OPENCODE_NATIVE = `{
  // theme picked by the user
  "theme": "vercel",
  "mcp": {
    "linear": {
      "type": "remote",
      "url": "https://mcp.linear.app/sse",
    },
  },
}
`

const CODEX_NATIVE = `# User's codex configuration
model = "gpt-5-codex"

[mcp_servers.linear]
url = "https://mcp.linear.app/sse"
`

/** Projecting the outcome again, carrying its ledger, must change nothing. */
async function reproject(
  target: ReturnType<typeof createClaudeMcpTarget>,
  outcome: ProjectionMergeOutcome,
): Promise<ProjectionMergeOutcome> {
  return target.merge({ entries: ENTRIES, records: outcome.records, nativeText: outcome.text })
}

describe('Claude Code — mcpServers in ~/.claude.json', () => {
  const target = createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })

  it('writes a stdio entry under mcpServers and leaves every other byte identical', async () => {
    const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText: CLAUDE_NATIVE })
    expect(outcome.drift).toEqual([])
    const document = JSON.parse(outcome.text) as {
      mcpServers: Record<string, Record<string, unknown>>
    }
    expect(document.mcpServers['context7']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
    })
    // The user's own MCP server and the rest of Claude's state file survive.
    expect(document.mcpServers['linear']).toEqual({ type: 'sse', url: 'https://mcp.linear.app/sse' })
    expect(withoutOwnedSpans(outcome.text, outcome.ownedSpans)).toBe(CLAUDE_NATIVE)
  })

  it('defaults to ~/.claude.json, because settings.json has no mcpServers key', () => {
    expect(createClaudeMcpTarget().filePath.endsWith('.claude.json')).toBe(true)
    expect(createClaudeMcpTarget().filePath).not.toContain('settings.json')
  })

  it('projects project scope into <project>/.mcp.json with the same shape', async () => {
    const projectTarget = createClaudeMcpTarget({ filePath: '/work/project/.mcp.json' })
    const outcome = await projectTarget.merge({ entries: ENTRIES, records: [], nativeText: '' })
    expect(JSON.parse(outcome.text)).toEqual({
      mcpServers: { context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
    })
  })

  it('reports the kinds it does not project instead of approximating them', async () => {
    const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText: CLAUDE_NATIVE })
    expect(outcome.skippedEntryIds).toEqual(['commit-lint'])
  })

  it('reports EVERY declared kind this format has no location for, derived from the contract', async () => {
    // The loop in `formats.ts` says "derived, so a word added to or removed from
    // `REGISTRY_ENTRY_TYPES` cannot leave a stale literal here" — and replacing
    // it with today's literal left every suite green. This builds one entry per
    // DECLARED kind from the contract itself, so a source list that stops
    // following the contract fails here instead of silently skipping a word.
    const entries = Object.fromEntries(
      REGISTRY_ENTRY_TYPES.map((kind) => [
        kind,
        // The one kind this format DOES render needs a command, or it is skipped
        // for lacking one and the row stops measuring the vocabulary.
        [kind === 'mcp-server' ? { type: kind, id: `id-${kind}`, command: 'x', args: [] } : { type: kind, id: `id-${kind}` }],
      ]),
    ) as unknown as RegistryEntriesByKind
    const outcome = await target.merge({ entries, records: [], nativeText: CLAUDE_NATIVE })
    expect([...(outcome.skippedEntryIds ?? [])].sort()).toEqual(
      REGISTRY_ENTRY_TYPES.filter((kind) => kind !== 'mcp-server')
        .map((kind) => `id-${kind}`)
        .sort(),
    )
  })

  it('is byte-identical on a second projection and writes no new records', async () => {
    const first = await target.merge({ entries: ENTRIES, records: [], nativeText: CLAUDE_NATIVE })
    const second = await reproject(target, first)
    expect(second.text).toBe(first.text)
    expect(second.records).toEqual(first.records)
  })
})

describe('OpenCode — mcp in opencode.json', () => {
  const target = createOpenCodeConfigTarget({ filePath: '/home/u/.config/opencode/opencode.json' })

  it('joins argv into `command` and emits NO `args` field', async () => {
    const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText: OPENCODE_NATIVE })
    // opencode.json is JSONC. Parsing it as JSONC checks the document the
    // vendor actually reads; stripping comments first would check a document
    // nobody has.
    const entry = (parseJsonc(outcome.text) as { mcp: Record<string, Record<string, unknown>> }).mcp[
      'context7'
    ]!
    expect(entry).toEqual({ type: 'local', command: ['npx', '-y', '@upstash/context7-mcp'] })
    // ConfigV1.Info has no `args`: writing one would be an undeclared key.
    expect(Object.keys(entry)).not.toContain('args')
  })

  it('preserves comments and trailing commas byte-for-byte', async () => {
    const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText: OPENCODE_NATIVE })
    expect(outcome.text).toContain('// theme picked by the user')
    expect(withoutOwnedSpans(outcome.text, outcome.ownedSpans)).toBe(OPENCODE_NATIVE)
  })

  it('is byte-identical on a second projection', async () => {
    const first = await target.merge({ entries: ENTRIES, records: [], nativeText: OPENCODE_NATIVE })
    expect((await reproject(target, first)).text).toBe(first.text)
  })
})

describe('Codex — [mcp_servers.<id>] in config.toml', () => {
  const target = createCodexConfigTarget({ filePath: '/home/u/.codex/config.toml' })

  it('appends a snake_case native table carrying only command and args', async () => {
    const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText: CODEX_NATIVE })
    expect(outcome.text).toBe(
      `${CODEX_NATIVE}\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n`,
    )
    // Nothing is written into [tools] or [skills]: those are fixed vendor
    // structs, and foreign sub-keys there are what --strict-config rejects.
    expect(outcome.text).not.toContain('[tools.')
    expect(outcome.text).not.toContain('[skills.')
    expect(outcome.text).not.toContain('mcpServers')
    expect(withoutOwnedSpans(outcome.text, outcome.ownedSpans)).toBe(CODEX_NATIVE)
  })

  it('never writes a panda-managed block, and never touches one it finds', async () => {
    // A file a PREVIOUS panda build wrote. Removing that block is correction-01
    // C6 and belongs to its own story; what this pins is that the corrected
    // build neither reads it, adds another, nor edits it.
    const legacy = `${CODEX_NATIVE}# BEGIN panda-managed v1
version = 1

[mcpServers.context7]
command = "npx"
# END panda-managed v1
`
    const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText: legacy })

    expect(outcome.text.startsWith(legacy)).toBe(true)
    expect(outcome.text.match(/panda-managed/g)).toHaveLength(2)
    // The new table is native and snake_case; the legacy camelCase one is
    // foreign bytes panda leaves exactly where they are.
    expect(outcome.text.slice(legacy.length)).toContain('[mcp_servers.context7]')
    expect(outcome.text.slice(legacy.length)).not.toContain('panda')
  })

  it('is byte-identical on a second projection', async () => {
    const first = await target.merge({ entries: ENTRIES, records: [], nativeText: CODEX_NATIVE })
    expect((await reproject(target, first)).text).toBe(first.text)
  })

  it('quotes an id that is not a bare TOML key', async () => {
    const outcome = await target.merge({
      entries: { ...ENTRIES, 'mcp-server': [{ type: 'mcp-server', id: 'my.server', command: 'run' }] },
      records: [],
      nativeText: '',
    })
    expect(outcome.text).toContain('[mcp_servers."my.server"]')
  })
})

describe('line endings and byte-order marks are foreign state', () => {
  const CRLF_CLAUDE = CLAUDE_NATIVE.replaceAll('\n', '\r\n')
  const CRLF_CODEX = CODEX_NATIVE.replaceAll('\n', '\r\n')

  it('splices a CRLF JSON file in its own line ending and stays idempotent', async () => {
    const target = createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })
    const first = await target.merge({ entries: ENTRIES, records: [], nativeText: CRLF_CLAUDE })
    expect(first.text).not.toContain('\r\r')
    // Every newline the splice introduced uses the file's own style.
    expect(withoutOwnedSpans(first.text, first.ownedSpans)).toBe(CRLF_CLAUDE)
    for (const [start, end] of first.ownedSpans) {
      expect(first.text.slice(start, end).replaceAll('\r\n', '')).not.toContain('\n')
    }
    expect((await reproject(target, first)).text).toBe(first.text)
  })

  it('appends a CRLF TOML table and removes exactly what it appended', async () => {
    const target = createCodexConfigTarget({ filePath: '/home/u/.codex/config.toml' })
    const first = await target.merge({ entries: ENTRIES, records: [], nativeText: CRLF_CODEX })
    expect(first.text.startsWith(CRLF_CODEX)).toBe(true)
    expect(first.text.slice(CRLF_CODEX.length)).not.toContain('\r\r')
    expect((await reproject(target, first)).text).toBe(first.text)

    const removed = await target.merge({
      entries: { ...ENTRIES, 'mcp-server': [] },
      records: first.records,
      nativeText: first.text,
    })
    expect(removed.text).toBe(CRLF_CODEX)
  })

  it('keeps a leading BOM byte-intact across projections', async () => {
    const target = createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })
    const bommed = `\uFEFF${CLAUDE_NATIVE}`
    const first = await target.merge({ entries: ENTRIES, records: [], nativeText: bommed })
    expect(first.text.startsWith('\uFEFF')).toBe(true)
    expect(withoutOwnedSpans(first.text, first.ownedSpans)).toBe(bommed)
    expect((await reproject(target, first)).text).toBe(first.text)
  })
})

describe('a native file that is absent or holds only whitespace', () => {
  it('creates the whole document when there is something to write', async () => {
    const target = createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })
    const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText: '' })
    expect(JSON.parse(outcome.text)).toEqual({
      mcpServers: { context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
    })
    // The projection IS the file, so panda owns all of it — the one input for
    // which "foreign bytes survive" has no foreign bytes to survive.
    expect(outcome.ownedSpans).toEqual([[0, outcome.text.length]])
    expect((await reproject(target, outcome)).text).toBe(outcome.text)
  })

  it('replaces whitespace-only content wholesale rather than splicing into it', async () => {
    const target = createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })
    const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText: '   \n\t ' })
    expect(Object.keys(JSON.parse(outcome.text))).toEqual(['mcpServers'])
    expect(outcome.ownedSpans).toEqual([[0, outcome.text.length]])
  })

  it('writes NOTHING when there is nothing to write', async () => {
    const target = createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })
    for (const nativeText of ['', '   \n\t ']) {
      const outcome = await target.merge({
        entries: { skill: [], 'mcp-server': [] },
        records: [],
        nativeText,
      })
      expect(outcome.text).toBe(nativeText)
      expect(outcome.ownedSpans).toEqual([])
      expect(outcome.records).toEqual([])
    }
  })
})

// --- A malformed vendor file is refused, not spliced (Spec M7.E) -----------
//
// `parseTree` RECOVERS: handed a broken document it returns a tree built from a
// guess, and panda splices by OFFSET into whatever it returns. Before this, a
// file whose only fault was an unquoted key parsed as an object and panda wrote
// its own block INSIDE one of the user's own server definitions.
//
// The accept rows are not filler. They are what makes the refusal safe: without
// `allowTrailingComma`, legitimate JSONC reports the SAME error code a genuinely
// doubled comma does, and refusing on any error would reject working files.

describe('OpenCode — a broken config is refused with its location', () => {
  const target = createOpenCodeConfigTarget({ filePath: '/home/u/.config/opencode/opencode.json' })
  const KEEP = '{ "type": "local", "command": ["x"] }'

  const ACCEPTED: readonly (readonly [string, string])[] = [
    ['a line comment', `{\n  // mine\n  "mcp": {\n    "keep": ${KEEP}\n  }\n}\n`],
    ['a block comment', `{\n  /* mine */\n  "mcp": {\n    "keep": ${KEEP}\n  }\n}\n`],
    ['a trailing comma', `{\n  "mcp": {\n    "keep": ${KEEP},\n  },\n}\n`],
    ['a trailing comma inside an array', `{\n  "x": [1, 2, ],\n  "mcp": {\n    "keep": ${KEEP}\n  }\n}\n`],
  ]

  it.each(ACCEPTED)('accepts %s and preserves it byte-for-byte', async (_label, nativeText) => {
    const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText })
    expect(outcome.text).toContain('context7')
    expect(withoutOwnedSpans(outcome.text, outcome.ownedSpans)).toBe(nativeText)
  })

  // `merge` is declared async and refuses SYNCHRONOUSLY — `validate()` runs
  // before the first await — so `expect(merge(...)).rejects` never receives a
  // promise to reject. This catches both shapes, and fails loudly on the one
  // outcome the whole story is about: merge returning instead of refusing.
  async function refusal(nativeText: string): Promise<{ code?: string; message: string }> {
    try {
      await target.merge({ entries: ENTRIES, records: [], nativeText })
    } catch (error) {
      return error as { code?: string; message: string }
    }
    throw new Error('merge accepted a malformed document and spliced into it')
  }

  // Each location was verified by hand against the body above it, because a
  // position that is merely PRESENT is worse than none: it sends the user to the
  // wrong line with panda's authority behind it.
  const REFUSED: readonly (readonly [string, string, string])[] = [
    ['an unquoted key', `{\n  mcp: {\n    "keep": ${KEEP}\n  }\n}\n`, 'InvalidSymbol at line 2, column 3'],
    [
      'a doubled comma',
      `{\n  "mcp": {\n    "keep": ${KEEP},,\n  }\n}\n`,
      'PropertyNameExpected at line 3, column 51',
    ],
    [
      'a missing close brace',
      `{\n  "mcp": {\n    "keep": ${KEEP}\n`,
      'CloseBraceExpected at line 4, column 1',
    ],
    [
      'an unterminated string',
      `{\n  "mcp": {\n    "keep": { "type": "local", "command": ["unterminat\n`,
      'UnexpectedEndOfString at line 3, column 44',
    ],
  ]

  it.each(REFUSED)('refuses %s, naming the fault and where it is', async (_label, nativeText, detail) => {
    const error = await refusal(nativeText)
    expect(error.code).toBe('PANDA_PROJECTION_NATIVE_MALFORMED')
    expect(error.message).toContain(detail)
  })

  it('still refuses a non-object root in the words it always used', async () => {
    // The one fault a recovering parse DOES surface as a shape rather than an
    // error, so its existing message stays correct and stays.
    const error = await refusal('[1, 2, 3]\n')
    expect(error.code).toBe('PANDA_PROJECTION_NATIVE_MALFORMED')
    expect(error.message).toContain('document root is not an object')
  })

  it('reports the very first byte as line 1, column 1', async () => {
    // The offset-0 edge, which the arithmetic handles without a special case:
    // `lastIndexOf('\n', -1)` is -1 and the +1 makes `lineStart` 0. Pinned
    // because a special case WAS written here, measured to be unreachable, and
    // deleted — this is what proves deleting it changed nothing.
    expect((await refusal('oops\n')).message).toContain('line 1, column 1')
  })
})

// --- The strict target LOCATES a fault, it does not quote it (Spec M17.A) ---
//
// M7.E's clause here was "the strict target keeps V8 as its parser", asserting
// `position 21` — V8's own message reaching the user, which is the exact string
// a planted credential travelled in through `doctor`, `init` and `ingest`.
//
// It is not replaced in place, because M17.A closes a RULE and not a site: no
// error panda raises about a document quotes that document's content, over all
// six documents panda parses. That lives in ONE gate,
// `test/document-quoting.test.ts`, which drives this target among the rest —
// splitting it across files would be six promises to keep in step.
