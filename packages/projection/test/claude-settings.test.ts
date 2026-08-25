import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTree } from 'jsonc-parser'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PANDA_ERROR_CODES,
  PandaError,
  PROJECTION_GRAMMAR_VERSION,
  PROJECTION_RESERVED_ROOT_KEY,
} from '@panda/contracts'
import { createClaudeSettingsTarget } from '../src/index.ts'
import { renderOwnedSubtree } from '../src/owned-subtree.ts'

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'panda-projection-claude-'))
  tempRoots.push(homeDir)
  return homeDir
}

function gold(name: string): Promise<string> {
  return readFile(new URL(`./goldens/${name}`, import.meta.url), 'utf8')
}

// The same registry state the committed golden snapshot was produced from;
// changing either side deliberately breaks this suite as drift detection.
const REGISTRY_ENTRIES = {
  tool: [
    { type: 'tool', id: 'ripgrep', command: 'rg' },
    { type: 'tool', id: 'fd-find', command: '~/bin/fd' },
  ],
  skill: [{ type: 'skill', id: 'commit-lint', entryPath: '~/.panda/skills/commit-lint.ts' }],
  'mcp-server': [
    { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  ],
  profile: [],
} as const

const OWNED_CONTENT = () => renderOwnedSubtree(REGISTRY_ENTRIES)

function makeTarget(homeDir: string) {
  return createClaudeSettingsTarget({ filePath: join(homeDir, '.claude', 'settings.json') })
}

describe('createClaudeSettingsTarget — sentinel grammar splicing', () => {
  it('projects a messy user file into exactly the committed golden output', async () => {
    const target = makeTarget(await makeHome())
    const outcome = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: await gold('messy-input.json'),
    })
    expect(outcome.drift).toEqual([])
    expect(outcome.text).toBe(await gold('projected-output.json'))
  })

  it('is byte-idempotent: projecting the projection changes nothing', async () => {
    const target = makeTarget(await makeHome())
    const messy = await gold('messy-input.json')
    const first = await target.merge({ entries: REGISTRY_ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: messy })
    const second = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: first.text,
    })
    expect(second.text).toBe(first.text)
  })

  it('preserves every byte outside the reserved key span', async () => {
    const input = await gold('messy-input.json')
    const target = makeTarget(await makeHome())
    const output = (
      await target.merge({ entries: REGISTRY_ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: input })
    ).text

    const root = parseTree(output)
    expect(root).toBeDefined()
    // Remove the whole reserved PROPERTY (key + value); what remains must
    // equal the original user bytes, apart from splice-boundary separators.
    const property = (root!.children ?? []).find(
      (candidate) => candidate.children?.[0]?.value === PROJECTION_RESERVED_ROOT_KEY,
    )
    expect(property).toBeDefined()

    const foreign =
      output.slice(0, property!.offset) + output.slice(property!.offset + property!.length)
    let prefix = 0
    while (prefix < input.length && prefix < foreign.length && input[prefix] === foreign[prefix]) {
      prefix += 1
    }
    let suffix = 0
    while (
      suffix < input.length - prefix &&
      suffix < foreign.length - prefix &&
      input[input.length - 1 - suffix] === foreign[foreign.length - 1 - suffix]
    ) {
      suffix += 1
    }
    const replacedInputBytes = input.slice(prefix, input.length - suffix)
    const introducedBytes = foreign.slice(prefix, foreign.length - suffix)
    expect(replacedInputBytes).toMatch(/^[\s,]*$/)
    expect(introducedBytes).toMatch(/^[\s,]*$/)
  })

  it('writes an explicitly empty owned section for an empty registry', async () => {
    const target = makeTarget(await makeHome())
    const emptyEntries = { tool: [], skill: [], 'mcp-server': [], profile: [] }
    const outcome = await target.merge({
      entries: emptyEntries,
      ownedContent: renderOwnedSubtree(emptyEntries),
      nativeText: '{}',
    })
    expect(JSON.parse(outcome.text)).toEqual({
      panda: { version: PROJECTION_GRAMMAR_VERSION, tools: {}, mcpServers: {}, skills: {} },
    })
  })

  it('treats whitespace-only native text as an empty document owned wholesale', async () => {
    const target = makeTarget(await makeHome())
    const outcome = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: '   \n\t ',
    })
    expect(outcome.drift).toEqual([])
    expect(JSON.parse(outcome.text)[PROJECTION_RESERVED_ROOT_KEY]).toMatchObject({
      version: PROJECTION_GRAMMAR_VERSION,
    })
    // The rendered subtree IS the file content now.
    const withoutPanda = JSON.parse(outcome.text) as Record<string, unknown>
    expect(Object.keys(withoutPanda)).toEqual([PROJECTION_RESERVED_ROOT_KEY])
  })

  it('keeps a leading BOM byte-intact across projections and stays idempotent', async () => {
    const target = makeTarget(await makeHome())
    const body = await gold('messy-input.json')
    const bommed = '\uFEFF' + body

    const first = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: bommed,
    })
    expect(first.drift).toEqual([])
    expect(first.text.startsWith('\uFEFF')).toBe(true)

    const second = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: first.text,
    })
    expect(second.text).toBe(first.text)
    // The BOM'd projection equals the BOM-less golden plus exactly its BOM.
    expect(second.text.slice(1)).toBe(await gold('projected-output.json'))
  })

  it('splices CRLF files with CRLF line endings and stays byte-idempotent', async () => {
    const target = makeTarget(await makeHome())
    const crlfInput = (await gold('messy-input.json')).replaceAll('\n', '\r\n')

    const first = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: crlfInput,
    })
    expect(first.text).toContain('\r\n')
    // Foreign region kept CRLF untouched; every newline of the inserted span
    // uses the detected style too.
    expect(first.text).not.toContain('\r\r')
    const messy = await gold('messy-input.json')
    const lfGolden = await gold('projected-output.json')
    const insertedNewlines =
      lfGolden.split('\n').length - messy.split('\n').length
    expect((first.text.match(/\r\n/g) ?? []).length).toBe(
      (crlfInput.match(/\r\n/g) ?? []).length + insertedNewlines,
    )

    const second = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: first.text,
    })
    expect(second.text).toBe(first.text)
  })

  it('reports profile entries through skippedEntryIds instead of dropping them', async () => {
    const target = makeTarget(await makeHome())
    const outcome = await target.merge({
      entries: { ...REGISTRY_ENTRIES, profile: [{ type: 'profile', id: 'frontend' }] },
      ownedContent: OWNED_CONTENT(),
      nativeText: '{}',
    })
    expect(outcome.skippedEntryIds).toEqual(['frontend'])
  })
})

describe('createClaudeSettingsTarget — malformed native files', () => {
  it.each([
    ['truncated JSON', '{ "model": "opus"'],
    ['JSONC comment', '{ /* hello */ }'],
    ['trailing comma', '{ "a": 1, }'],
    ['number root', '42'],
    ['null root', 'null'],
    ['boolean root', 'true'],
    ['array root', '["not", "an", "object"]'],
    [
      'duplicate reserved keys',
      '{ "panda": {"version": 1, "tools": {}, "mcpServers": {}, "skills": {}}, "panda": {} }',
    ],
  ])('fails ONLY this target with PANDA_PROJECTION_NATIVE_MALFORMED (%s)', async (_name, native) => {
    const filePath = join(await makeHome(), '.claude', 'settings.json')
    const target = createClaudeSettingsTarget({ filePath })
    try {
      await target.merge({ entries: REGISTRY_ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: native })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.projectionNativeMalformed)
      expect((error as PandaError).code).toBe('PANDA_PROJECTION_NATIVE_MALFORMED')
      expect((error as PandaError).message).toContain(filePath)
    }
  })
})

describe('createClaudeSettingsTarget — drift classification', () => {
  it.each([
    ['older grammar version', '{"user": 1, "panda": {"version": 0, "tools": {}}}', 'legacy-marker'],
    [
      'newer grammar version',
      '{"panda": {"version": 2, "tools": {}, "mcpServers": {}, "skills": {}}}',
      'legacy-marker',
    ],
    ['non-object marker', '{"panda": "i was here first"}', 'unknown-shape'],
    [
      'v1 with foreign key',
      '{"panda": {"version": 1, "tools": {}, "mcpServers": {}, "skills": {}, "extra": true}}',
      'unknown-shape',
    ],
    ['v1 with bad section', '{"panda": {"version": 1, "tools": "nope"}}', 'unknown-shape'],
    ['v1 leaf with wrong-typed field', '{"panda": {"version": 1, "tools": {"x": {"command": 123}}}}', 'unknown-shape'],
    ['v1 leaf with unknown field', '{"panda": {"version": 1, "skills": {"x": {"entryPath": "~", "model": "opus"}}}}', 'unknown-shape'],
    ['v1 server leaf with bad args', '{"panda": {"version": 1, "mcpServers": {"x": {"args": [1]}}}}', 'unknown-shape'],
    ['v1 leaf with empty id key', '{"panda": {"version": 1, "tools": {"": {}}}}', 'unknown-shape'],
  ])('classifies %s as %s drift without overwriting it', async (_name, native, kind) => {
    const target = makeTarget(await makeHome())
    const outcome = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: native,
    })
    expect(outcome.drift.length).toBeGreaterThan(0)
    for (const entry of outcome.drift) {
      expect(entry.kind).toBe(kind)
    }
    expect(outcome.drift[0]!.location).toContain(PROJECTION_RESERVED_ROOT_KEY)
    expect(outcome.drift[0]!.detail).not.toBe('')
    // Reported, never silently overwritten.
    expect(outcome.text).toBe(native)
  })

  it('states that the VERSION KEY IS MISSING instead of claiming an undefined version', async () => {
    const target = makeTarget(await makeHome())
    const outcome = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: '{"panda": {"tools": {}}}',
    })
    expect(outcome.drift[0]!.detail).toContain('missing')
    expect(outcome.drift[0]!.detail).not.toContain('undefined')
    expect(outcome.text).toBe('{"panda": {"tools": {}}}')
  })

  it('treats an exact grammar v1 marker as current, re-splicing it deterministically', async () => {
    const target = makeTarget(await makeHome())
    const current = JSON.stringify({
      [PROJECTION_RESERVED_ROOT_KEY]: {
        version: 1,
        tools: {},
        mcpServers: {},
        skills: {},
      },
    })
    const outcome = await target.merge({
      entries: REGISTRY_ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: current,
    })
    expect(outcome.drift).toEqual([])
    const rendered = JSON.parse(
      (await target.merge({ entries: REGISTRY_ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: '{}' }))
        .text,
    )[PROJECTION_RESERVED_ROOT_KEY]
    expect(JSON.parse(outcome.text)[PROJECTION_RESERVED_ROOT_KEY]).toEqual(rendered)
  })
})
