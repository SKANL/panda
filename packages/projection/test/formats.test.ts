import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PandaError,
  PANDA_ERROR_CODES,
  PANDA_MANAGED_BLOCK_BEGIN,
  PANDA_MANAGED_BLOCK_END,
  PROJECTION_GRAMMAR_VERSION,
  PROJECTION_RESERVED_ROOT_KEY,
} from '@panda/contracts'
import type { RegistryEntriesByKind } from '@panda/contracts'
import { createClaudeSettingsTarget } from '../src/targets/claude-settings.ts'
import { createCodexConfigTarget } from '../src/targets/codex-config.ts'
import { createOpenCodeConfigTarget } from '../src/targets/opencode-config.ts'
import { createProjectionTargetFromTraits } from '../src/formats.ts'
import type { ProjectionTargetTraits } from '../src/formats.ts'
import { runProjection } from '../src/engine.ts'
import { renderOwnedSubtree } from '../src/owned-subtree.ts'

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'panda-projection-formats-'))
  tempRoots.push(homeDir)
  return homeDir
}

function gold(name: string): Promise<string> {
  return readFile(new URL(`./goldens/${name}`, import.meta.url), 'utf8')
}

const ENTRIES: RegistryEntriesByKind = {
  tool: [
    { type: 'tool', id: 'ripgrep', command: 'rg' },
    { type: 'tool', id: 'fd-find', command: '~/bin/fd' },
  ],
  skill: [{ type: 'skill', id: 'commit-lint', entryPath: '~/.panda/skills/commit-lint.ts' }],
  'mcp-server': [
    { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  ],
  profile: [],
}

const OWNED_CONTENT = () => renderOwnedSubtree(ENTRIES)

describe('createCodexConfigTarget — delimited block at EOF', () => {
  it('projects a user config into exactly the committed golden output', async () => {
    const target = createCodexConfigTarget({ filePath: join(await makeHome(), '.codex', 'config.toml') })
    const outcome = await target.merge({
      entries: ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: await gold('codex-input.toml'),
    })
    expect(outcome.drift).toEqual([])
    expect(outcome.skippedEntryIds).toEqual([])
    expect(outcome.text).toBe(await gold('codex-projected-output.toml'))
  })

  it('appends the block at EOF keeping every prior foreign byte identical', async () => {
    const target = createCodexConfigTarget({ filePath: join(await makeHome(), '.codex', 'config.toml') })
    const input = await gold('codex-input.toml')
    const output = (await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: input })).text
    expect(output.startsWith(input)).toBe(true)
    expect(output.slice(input.length)).toContain(PANDA_MANAGED_BLOCK_BEGIN)
  })

  it('replaces an existing block wholesale, leaving foreign bytes untouched', async () => {
    const target = createCodexConfigTarget({ filePath: join(await makeHome(), '.codex', 'config.toml') })
    const projected = await gold('codex-projected-output.toml')
    // Projecting the projection again changes nothing (byte-idempotence).
    const second = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: projected })
    expect(second.text).toBe(projected)
  })

  it.each([
    [
      'older block version',
      `model = "x"\n# BEGIN panda-managed v0\nversion = 0\n# END panda-managed v0\n`,
      'legacy-marker',
      'declares grammar version 0',
    ],
    [
      'newer block version',
      `model = "x"\n# BEGIN panda-managed v2\nversion = 2\n# END panda-managed v2\n`,
      'legacy-marker',
      'declares grammar version 2',
    ],
    [
      'unpaired begin marker',
      `model = "x"\n${PANDA_MANAGED_BLOCK_BEGIN}\nversion = ${PROJECTION_GRAMMAR_VERSION}\n`,
      'unknown-shape',
      PANDA_MANAGED_BLOCK_END,
    ],
    [
      'mismatched marker versions',
      `# BEGIN panda-managed v1\nversion = 1\n# END panda-managed v2\n`,
      'unknown-shape',
      'mismatched versions',
    ],
    [
      'duplicated blocks',
      `${PANDA_MANAGED_BLOCK_BEGIN}\nversion = ${PROJECTION_GRAMMAR_VERSION}\n${PANDA_MANAGED_BLOCK_END}\n${PANDA_MANAGED_BLOCK_BEGIN}\nversion = ${PROJECTION_GRAMMAR_VERSION}\n${PANDA_MANAGED_BLOCK_END}\n`,
      'unknown-shape',
      'begin and 2 end markers',
    ],
    [
      'end marker before begin marker',
      `${PANDA_MANAGED_BLOCK_END}\n${PANDA_MANAGED_BLOCK_BEGIN}\n`,
      'unknown-shape',
      'before its begin marker',
    ],
    [
      'version-less marker pair',
      'model = "x"\n# BEGIN panda-managed\nversion = 0\n# END panda-managed\n',
      'legacy-marker',
      'do not declare a grammar version',
    ],
  ])('classifies %s as %s drift without rewriting it', async (_name, native, kind, detailFragment) => {
    const target = createCodexConfigTarget({ filePath: join(await makeHome(), '.codex', 'config.toml') })
    const outcome = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: native })
    expect(outcome.drift.length).toBeGreaterThan(0)
    for (const entry of outcome.drift) expect(entry.kind).toBe(kind)
    expect(outcome.drift[0]!.location).toBe('$.panda-managed-block')
    expect(outcome.drift[0]!.detail).toContain(detailFragment)
    expect(outcome.text).toBe(native)
  })

  it('writes an explicitly empty managed block for an empty registry', async () => {
    const target = createCodexConfigTarget({ filePath: join(await makeHome(), '.codex', 'config.toml') })
    const emptyEntries: RegistryEntriesByKind = { tool: [], skill: [], 'mcp-server': [], profile: [] }
    const outcome = await target.merge({
      entries: emptyEntries,
      ownedContent: renderOwnedSubtree(emptyEntries),
      nativeText: '',
    })
    expect(outcome.text).toBe(
      [`${PANDA_MANAGED_BLOCK_BEGIN}\nversion = ${PROJECTION_GRAMMAR_VERSION}\n${PANDA_MANAGED_BLOCK_END}\n`].join(''),
    )
  })

  it('appends after ensuring a trailing newline on a file that lacks one', async () => {
    const target = createCodexConfigTarget({ filePath: join(await makeHome(), '.codex', 'config.toml') })
    const outcome = await target.merge({
      entries: ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: 'model = "x"',
    })
    expect(outcome.text.startsWith('model = "x"\n')).toBe(true)
    const second = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: outcome.text })
    expect(second.text).toBe(outcome.text)
  })

  it('reports profile entries through skippedEntryIds instead of dropping them', async () => {
    const target = createCodexConfigTarget({ filePath: join(await makeHome(), '.codex', 'config.toml') })
    const withProfiles: RegistryEntriesByKind = {
      tool: [],
      skill: [],
      'mcp-server': [],
      profile: [{ type: 'profile', id: 'frontend' }],
    }
    const outcome = await target.merge({
      entries: withProfiles,
      ownedContent: OWNED_CONTENT(),
      nativeText: '',
    })
    expect(outcome.skippedEntryIds).toEqual(['frontend'])
  })
})

describe('createOpenCodeConfigTarget — JSONC root-key splice', () => {
  it('projects a JSONC file with comments and trailing commas into the committed golden', async () => {
    const target = createOpenCodeConfigTarget({ filePath: join(await makeHome(), '.config', 'opencode', 'opencode.json') })
    const outcome = await target.merge({
      entries: ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: await gold('opencode-input.json'),
    })
    expect(outcome.drift).toEqual([])
    expect(outcome.text).toBe(await gold('opencode-projected-output.json'))
  })

  it('preserves comments byte-for-byte across the splice and stays idempotent', async () => {
    const target = createOpenCodeConfigTarget({ filePath: join(await makeHome(), '.config', 'opencode', 'opencode.json') })
    const input = await gold('opencode-input.json')
    const first = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: input })
    for (const comment of ['// theme picked by the user', '// remote server']) {
      expect(first.text).toContain(comment)
    }
    const second = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: first.text })
    expect(second.text).toBe(first.text)
  })

  it('treats whitespace-only native text as an empty document owned wholesale', async () => {
    const target = createOpenCodeConfigTarget({ filePath: join(await makeHome(), '.config', 'opencode', 'opencode.json') })
    const outcome = await target.merge({
      entries: ENTRIES,
      ownedContent: OWNED_CONTENT(),
      nativeText: '   \n\t ',
    })
    const parsed = JSON.parse(outcome.text) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual([PROJECTION_RESERVED_ROOT_KEY])
    expect(parsed[PROJECTION_RESERVED_ROOT_KEY]).toMatchObject({ version: PROJECTION_GRAMMAR_VERSION })
  })

  it('keeps a leading BOM byte-intact across projections', async () => {
    const target = createOpenCodeConfigTarget({ filePath: join(await makeHome(), '.config', 'opencode', 'opencode.json') })
    const bommed = `\uFEFF${await gold('opencode-input.json')}`
    const first = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: bommed })
    expect(first.text.startsWith('\uFEFF')).toBe(true)
    const second = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: first.text })
    expect(second.text).toBe(first.text)
  })

  // Lenient JSONC strategy: comments, trailing commas, and even truncated
  // documents are salvaged by jsonc-parser and NOT malformed. What fails this
  // target is input with no object root to claim the reserved key in, or an
  // unclassifiable duplicate of it.
  it.each([
    ['number root', '42'],
    ['boolean root', 'true'],
    ['array root', '[]'],
    [
      'duplicate reserved keys',
      `{ "a": 1, "${PROJECTION_RESERVED_ROOT_KEY}": {}, "${PROJECTION_RESERVED_ROOT_KEY}": {} }`,
    ],
  ])('fails ONLY this target with PANDA_PROJECTION_NATIVE_MALFORMED (%s)', async (_name, native) => {
    const filePath = join(await makeHome(), '.config', 'opencode', 'opencode.json')
    const target = createOpenCodeConfigTarget({ filePath })
    try {
      await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: native })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.projectionNativeMalformed)
      expect((error as PandaError).message).toContain(filePath)
    }
  })
})

describe('malformed isolation across target kinds', () => {
  it('a corrupt OpenCode file fails only that target while Claude and Codex project', async () => {
    const homeDir = await makeHome()
    const badDir = join(homeDir, 'opencode')
    await mkdir(badDir)
    const badPath = join(badDir, 'opencode.json')
    await writeFile(badPath, '42', 'utf8')

    const run = await runProjection({
      entries: ENTRIES,
      targets: [
        createClaudeSettingsTarget({ filePath: join(homeDir, '.claude', 'settings.json') }),
        createCodexConfigTarget({ filePath: join(homeDir, '.codex', 'config.toml') }),
        createOpenCodeConfigTarget({ filePath: badPath }),
      ],
    })

    expect(run.failures).toHaveLength(1)
    expect(run.failures[0]!.targetId).toBe('opencode-config')
    expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.projectionNativeMalformed)
    expect(run.results.map((result) => result.targetId)).toEqual(['claude-settings', 'codex-config'])
    for (const result of run.results) expect(result.written).toBe(true)
    // The malformed file is untouched.
    expect(await readFile(badPath, 'utf8')).toBe('42')
  })
})

describe('createCodexConfigTarget — CRLF files', () => {
  const CRLF_SAMPLE = [
    '# codex config',
    'model = "gpt-5-codex"',
    '',
    '[mcp_servers.linear]',
    'url = "https://mcp.linear.app/sse"',
  ].join('\r\n')

  it('appends exactly ONE CRLF-rendered block and stays byte-idempotent', async () => {
    const target = createCodexConfigTarget({ filePath: join(await makeHome(), '.codex', 'config.toml') })
    const outcome = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: CRLF_SAMPLE })

    // Foreign CRLF bytes untouched, block rendered in the file's own EOL.
    expect(outcome.text.startsWith(CRLF_SAMPLE)).toBe(true)
    expect((outcome.text.match(/BEGIN panda-managed/g) ?? []).length).toBe(1)
    expect((outcome.text.match(/END panda-managed/g) ?? []).length).toBe(1)
    expect(outcome.ownedSpan).toBeDefined()
    const [start, end] = outcome.ownedSpan!
    const blockInterior = outcome.text.slice(start, end)
    expect(blockInterior).toContain('# BEGIN panda-managed v1\r\nversion = 1\r\n')
    expect(blockInterior.includes('\n')).toBe(true)
    expect(blockInterior.replaceAll('\r\n', '').includes('\n')).toBe(false)

    const second = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: outcome.text })
    expect(second.text).toBe(outcome.text)
    expect(second.text.startsWith(CRLF_SAMPLE)).toBe(true)
  })

  it('replaces an existing CRLF block wholesale keeping foreign bytes intact', async () => {
    const target = createCodexConfigTarget({ filePath: join(await makeHome(), '.codex', 'config.toml') })
    const projected = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: `${CRLF_SAMPLE}\r\n` })

    const second = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: projected.text })
    expect(second.text).toBe(projected.text)
    expect((second.text.match(/BEGIN panda-managed/g) ?? []).length).toBe(1)
    expect(second.ownedSpan).toBeDefined()
    const [start, end] = second.ownedSpan!
    expect(second.text.slice(0, start)).toBe(`${CRLF_SAMPLE}\r\n`)
    expect(second.text.slice(end)).toBe('\r\n')
  })
})

describe('createOpenCodeConfigTarget — trailing-comma byte preservation', () => {
  it('adds ONLY characters at one insertion point next to a trailing-comma last property', async () => {
    const target = createOpenCodeConfigTarget({ filePath: join(await makeHome(), '.config', 'opencode', 'opencode.json') })
    // The exact shape that broke under modify()+applyEdits: an inline object
    // as the LAST property, followed by a JSONC-legal trailing comma.
    const input = '{\n      "userKey": "user-value",\n  "nested": {"kept": true},\n}'
    const outcome = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: input })

    // Every foreign byte survives verbatim; the owned region is purely additive.
    const [start, end] = outcome.ownedSpan!
    expect(outcome.text.slice(0, start)).toBe('{\n      "userKey": "user-value",\n  "nested": {"kept": true},')
    expect(outcome.text.slice(end)).toBe('\n}')
    expect(outcome.text).toContain('"nested": {"kept": true},')

    const second = await target.merge({ entries: ENTRIES, ownedContent: OWNED_CONTENT(), nativeText: outcome.text })
    expect(second.text).toBe(outcome.text)
  })
})

describe('createProjectionTargetFromTraits — trait pair validation', () => {
  it.each([
    ['toml with root-key-splice', { fileFormat: 'toml', ownedRegionStrategy: 'root-key-splice' }],
    ['jsonc with delimited-block', { fileFormat: 'jsonc', ownedRegionStrategy: 'delimited-block' }],
  ])('rejects %s with PANDA_PROJECTION_TRAITS_INVALID', (_name, mismatch) => {
    try {
      createProjectionTargetFromTraits({
        targetId: 'mismatched',
        defaultPath: '/unused',
        ...mismatch,
      } as ProjectionTargetTraits)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      expect((error as PandaError).code).toBe('PANDA_PROJECTION_TRAITS_INVALID')
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.projectionTraitsInvalid)
      expect((error as PandaError).message).toContain("'mismatched'")
    }
  })

  it('accepts the permitted pairs', () => {
    for (const traits of [
      { targetId: 'ok-jsonc', fileFormat: 'jsonc', ownedRegionStrategy: 'root-key-splice', defaultPath: '/unused' },
      { targetId: 'ok-toml', fileFormat: 'toml', ownedRegionStrategy: 'delimited-block', defaultPath: '/unused' },
    ] satisfies ProjectionTargetTraits[]) {
      expect(() => createProjectionTargetFromTraits(traits)).not.toThrow()
    }
  })
})
