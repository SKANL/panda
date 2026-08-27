import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRecord } from '@panda/contracts'
import type { ProjectionMcpEntry, RegistryEntriesByKind } from '@panda/contracts'
import * as projection from '../src/index.ts'
import type { ProjectionTargetTraits } from '../src/formats.ts'
import { createProjectionTargetFromTraits } from '../src/formats.ts'

// VENDOR SCHEMA CONFORMANCE — the assertion this whole story exists for.
//
// The previous build shipped green tests while writing a vocabulary no executor
// reads, because every criterion was phrased in panda's own terms. Here both
// halves are the VENDORS': the declared keys are extracted mechanically from a
// verbatim excerpt of each CLI's own schema, vendored under `vendor-schemas/`
// with its URL and commit, and the native locations are asserted as full paths.
// A table transcribed from our spec could only prove our trait records match
// our spec; this fails when panda writes a key the vendor never declared, and
// it fails when the table itself drifts from the source.

function vendored(name: string): string {
  return readFileSync(new URL(`./vendor-schemas/${name}`, import.meta.url), 'utf8')
}

/** Rust: every `pub <field>:` inside the vendored struct, minus serde renames. */
function rustStructFields(source: string): string[] {
  const fields = [...source.matchAll(/^\s*pub (\w+):/gm)].map((match) => match[1]!)
  // `_name` is `#[serde(rename = "name")]` in the excerpt; the TOML key is `name`.
  return fields.map((field) => (field === '_name' ? 'name' : field))
}

/** Effect Schema: every `<field>: Schema.` inside the vendored struct. */
function effectStructFields(source: string): string[] {
  return [...source.matchAll(/^\s{2}(\w+): Schema\./gm)].map((match) => match[1]!)
}

/** Docs: every key of every `mcpServers.<name>` object in a fenced JSON block. */
function documentedEntryKeys(source: string): string[] {
  const keys = new Set<string>()
  for (const block of source.matchAll(/```json\n([\s\S]*?)```/g)) {
    const parsed: unknown = JSON.parse(block[1]!)
    const servers = (parsed as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers
    for (const entry of Object.values(servers ?? {})) for (const key of Object.keys(entry)) keys.add(key)
  }
  return [...keys]
}

interface VendorMcpSchema {
  readonly label: string
  /** The exact file the vendor reads MCP servers from. */
  readonly defaultPath: string
  /** The vendor's own container key. */
  readonly containerKey: string
  /** Keys the VENDORED SOURCE declares, extracted from it mechanically. */
  readonly declaredKeys: readonly string[]
  /** The vendor's transport discriminator and the values it accepts, if any. */
  readonly transport?: { readonly key: string; readonly values: readonly string[] }
  /** True when the authority is published documentation, not source. */
  readonly documentationOnly?: boolean
}

const VENDOR_SCHEMAS: Readonly<Record<string, VendorMcpSchema>> = {
  // Claude Code: settings.json declares NO mcpServers key. User-scope servers
  // live in ~/.claude.json, project-scope in <project>/.mcp.json.
  [projection.CLAUDE_MCP_TARGET_ID]: {
    label: 'Claude Code',
    defaultPath: join(homedir(), '.claude.json'),
    containerKey: 'mcpServers',
    declaredKeys: documentedEntryKeys(vendored('claude-code-mcp.md')),
    transport: { key: 'type', values: ['stdio', 'sse', 'http'] },
    documentationOnly: true,
  },
  // OpenCode ConfigV1 McpLocalConfig: `mcp.<id>` with a local entry whose
  // `command` IS the argv array — there is deliberately no `args` field.
  [projection.OPENCODE_CONFIG_TARGET_ID]: {
    label: 'OpenCode',
    defaultPath: join(homedir(), '.config', 'opencode', 'opencode.json'),
    containerKey: 'mcp',
    declaredKeys: effectStructFields(vendored('opencode-mcp-local.ts.txt')),
    transport: { key: 'type', values: ['local'] },
  },
  // Codex RawMcpServerConfig: the key is `mcp_servers`, snake_case, and the
  // struct is `deny_unknown_fields` — which is what --strict-config enforces.
  [projection.CODEX_CONFIG_TARGET_ID]: {
    label: 'Codex',
    defaultPath: join(homedir(), '.codex', 'config.toml'),
    containerKey: 'mcp_servers',
    declaredKeys: rustStructFields(vendored('codex-mcp-server-config.rs.txt')),
  },
}

const SAMPLE_ENTRY: ProjectionMcpEntry = {
  id: 'context7',
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp'],
}

const SAMPLE_REGISTRY: RegistryEntriesByKind = {
  skill: [],
  'mcp-server': [
    { type: 'mcp-server', id: SAMPLE_ENTRY.id, command: SAMPLE_ENTRY.command, args: SAMPLE_ENTRY.args },
  ],
}

/** Keys a trait record emits that its vendor's own source does not declare. */
function undeclaredTraitKeys(traits: ProjectionTargetTraits, schema: VendorMcpSchema): string[] {
  return Object.keys(traits.renderMcpEntry(SAMPLE_ENTRY)).filter(
    (key) => !schema.declaredKeys.includes(key),
  )
}

/** Keys actually present at panda's native location in a projected document. */
function writtenDocumentKeys(traits: ProjectionTargetTraits, text: string, entryId: string): string[] {
  if (traits.fileFormat === 'jsonc') {
    const container = (JSON.parse(text) as Record<string, Record<string, Record<string, unknown>>>)[
      traits.mcpContainerKey
    ]
    expect(container, `'${traits.mcpContainerKey}' is missing from the projected document`).toBeDefined()
    const entry = container![entryId]
    expect(entry, `'${entryId}' is missing from '${traits.mcpContainerKey}'`).toBeDefined()
    return Object.keys(entry!)
  }
  // TOML: read back exactly the table panda wrote, key by key.
  const lines = text.split('\n').map((line) => line.trimEnd())
  const header = lines.indexOf(`[${traits.mcpContainerKey}.${entryId}]`)
  expect(
    header,
    `'[${traits.mcpContainerKey}.${entryId}]' is missing from the projected document`,
  ).toBeGreaterThanOrEqual(0)
  const keys: string[] = []
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.startsWith('[')) break
    const assignment = /^([A-Za-z0-9_-]+)\s*=/.exec(line)
    if (assignment) keys.push(assignment[1]!)
  }
  return keys
}

/**
 * Every trait record the package exports. Derived from the barrel and never
 * hand-maintained: a fourth target is conformance-tested the moment it exists.
 */
const ALL_TRAITS: readonly (readonly [string, Record<string, unknown>])[] = Object.entries(projection)
  .filter(([name, value]) => name.endsWith('_TRAITS') && isRecord(value))
  .map(([name, value]) => [name, value as unknown as Record<string, unknown>] as const)

/** An MCP config trait: the only kind whose vendor conformance this file judges. */
function isMcpTraits(value: Record<string, unknown>): boolean {
  return 'mcpContainerKey' in value
}

/** A materialisation trait: a root, and no vendor key to conform to. */
function isSkillsTraits(value: Record<string, unknown>): boolean {
  return 'defaultRoot' in value && !('mcpContainerKey' in value)
}

const SHIPPED_TRAITS: readonly ProjectionTargetTraits[] = ALL_TRAITS.filter(([, value]) =>
  isMcpTraits(value),
).map(([, value]) => value as unknown as ProjectionTargetTraits)

describe('the shipped target set', () => {
  it('classifies EVERY exported trait record, so none can be silently excluded', () => {
    // The discovery used to key on the `_TRAITS` name alone, and narrowing it to
    // a shape made a new export without that shape drop out SILENTLY instead of
    // failing loudly — a strictly weaker check than the one it replaced. So the
    // partition is asserted to be total: an export that is neither an MCP trait
    // record nor a skills trait record turns this red, whatever it is called.
    expect(ALL_TRAITS.length).toBeGreaterThanOrEqual(6)
    for (const [name, value] of ALL_TRAITS) {
      expect(
        isMcpTraits(value) || isSkillsTraits(value),
        `'${name}' is a trait record no suite knows how to judge; give it a vendor schema or a root`,
      ).toBe(true)
    }
    // And each kind is actually populated, or the partition above passes by
    // being empty on one side.
    expect(ALL_TRAITS.filter(([, value]) => isSkillsTraits(value)).length).toBeGreaterThanOrEqual(3)
  })

  it('is discovered from the exports, and every target has a vendor schema', () => {
    expect(SHIPPED_TRAITS.length).toBeGreaterThanOrEqual(3)
    for (const traits of SHIPPED_TRAITS) {
      expect(
        VENDOR_SCHEMAS[traits.targetId],
        `target '${traits.targetId}' ships with no vendored vendor schema to conform to`,
      ).toBeDefined()
    }
  })

  it('extracts a non-empty key set from every vendored source', () => {
    // Guards the extractors themselves: a regex that stops matching would
    // otherwise make every conformance assertion below pass vacuously.
    for (const schema of Object.values(VENDOR_SCHEMAS)) {
      expect(schema.declaredKeys.length, `${schema.label} declared no keys`).toBeGreaterThan(2)
      expect(schema.declaredKeys).toContain('command')
    }
    expect(VENDOR_SCHEMAS[projection.CODEX_CONFIG_TARGET_ID]!.declaredKeys).toEqual(
      expect.arrayContaining(['command', 'args', 'env']),
    )
    expect(VENDOR_SCHEMAS[projection.OPENCODE_CONFIG_TARGET_ID]!.declaredKeys).toEqual(
      expect.arrayContaining(['type', 'command', 'environment', 'enabled']),
    )
    // Claude Code is closed source; its authority is documentation, and the
    // fixture says so rather than passing itself off as a schema file.
    expect(VENDOR_SCHEMAS[projection.CLAUDE_MCP_TARGET_ID]!.documentationOnly).toBe(true)
  })
})

describe.each(SHIPPED_TRAITS)('vendor conformance — $targetId', (traits) => {
  const schema = VENDOR_SCHEMAS[traits.targetId]!

  it('writes ONLY keys the vendor’s own source declares', () => {
    expect(
      undeclaredTraitKeys(traits, schema),
      `${schema.label} does not declare these keys for an MCP server entry`,
    ).toEqual([])
  })

  it('writes them at the container key the vendor reads', () => {
    expect(traits.mcpContainerKey).toBe(schema.containerKey)
  })

  it('defaults to the EXACT file the vendor reads MCP servers from', () => {
    // Full path, not basename: a perfectly shaped table in ~/.config/codex/
    // instead of ~/.codex/ is this story's own failure mode one directory up.
    expect(traits.defaultPath).toBe(schema.defaultPath)
  })

  it('uses a transport value the vendor accepts, or none at all', () => {
    const shape = traits.renderMcpEntry(SAMPLE_ENTRY)
    if (schema.transport === undefined) {
      expect(Object.keys(shape)).not.toContain('type')
      return
    }
    expect(schema.transport.values).toContain(shape[schema.transport.key])
  })

  it('lands a document whose keys at panda’s location are all vendor-declared', async () => {
    const target = createProjectionTargetFromTraits(traits, { filePath: `/unused/vendor-check` })
    const outcome = await target.merge({ entries: SAMPLE_REGISTRY, records: [], nativeText: '' })
    const written = writtenDocumentKeys(traits, outcome.text, SAMPLE_ENTRY.id)
    expect(written.length).toBeGreaterThan(0)
    expect(written.filter((key) => !schema.declaredKeys.includes(key))).toEqual([])
  })
})

describe('the conformance assertion is mechanical', () => {
  it('FAILS a trait record that emits a key its vendor never declared', () => {
    // Negative control: without this, "every key is declared" could be true
    // because the check never actually looks at anything.
    const rogue: ProjectionTargetTraits = {
      ...projection.CLAUDE_MCP_TRAITS,
      renderMcpEntry: (entry) => ({
        ...projection.CLAUDE_MCP_TRAITS.renderMcpEntry(entry),
        pandaOwned: 'true',
      }),
    }
    expect(undeclaredTraitKeys(rogue, VENDOR_SCHEMAS[projection.CLAUDE_MCP_TARGET_ID]!)).toEqual([
      'pandaOwned',
    ])
  })

  it('FAILS a document carrying an undeclared key at panda’s location', async () => {
    const schema = VENDOR_SCHEMAS[projection.CODEX_CONFIG_TARGET_ID]!
    const rogue: ProjectionTargetTraits = {
      ...projection.CODEX_CONFIG_TRAITS,
      renderMcpEntry: (entry) => ({
        ...projection.CODEX_CONFIG_TRAITS.renderMcpEntry(entry),
        panda_version: '1',
      }),
    }
    const target = createProjectionTargetFromTraits(rogue, { filePath: '/unused/config.toml' })
    const outcome = await target.merge({ entries: SAMPLE_REGISTRY, records: [], nativeText: '' })
    const written = writtenDocumentKeys(rogue, outcome.text, SAMPLE_ENTRY.id)
    expect(written.filter((key) => !schema.declaredKeys.includes(key))).toEqual(['panda_version'])
  })

  it('FAILS a target whose default path drifts to a plausible wrong directory', () => {
    const schema = VENDOR_SCHEMAS[projection.CODEX_CONFIG_TARGET_ID]!
    const rogue = { ...projection.CODEX_CONFIG_TRAITS, defaultPath: join(homedir(), '.config', 'codex', 'config.toml') }
    expect(rogue.defaultPath).not.toBe(schema.defaultPath)
  })
})
