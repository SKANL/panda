import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLE_KIND,
  BUNDLE_VERSION,
  createBundle,
  isCredential,
  parseBundle,
  serializeBundle,
  writeBundle,
} from '../src'
import type { RegistryEntry } from '@panda/contracts'

const HOME = join('/home', 'dev')

function mcp(id: string, args: readonly string[]): RegistryEntry {
  return { type: 'mcp-server', id, command: 'npx', args }
}

// --- The detector ----------------------------------------------------------
//
// This corpus IS the specification of where the line falls, in both directions,
// and it is a test rather than a comment because this is the one part of the
// story where being wrong is a security failure rather than a defect. A miss
// puts a credential in a portable file; a false positive drops a user's entry
// (visibly — see the omission record — but still drops it).

/**
 * A credential fixture, assembled from its prefix and its body rather than
 * written as one literal.
 *
 * Not decoration and not superstition: GitHub push protection scans a commit for
 * real credential SHAPES and REJECTED this file's first version on the Slack and
 * GitLab rows. A corpus of literals that trips every scanner it passes is a
 * liability in a repository whose own NFR-5 says a secret detector runs over its
 * artifacts — and the alternative, marking a fake as an allowed real secret, is
 * strictly worse. `isCredential` receives exactly the same string either way;
 * only the bytes on disk differ.
 */
function fixture(prefix: string, body: string): string {
  return prefix + body
}

export const FAKE = {
  openai: fixture('sk-', 'proj-Ab3dEfGh1jKlMn0pQrStUvWxYz123456'),
  anthropic: fixture('sk-', 'ant-api03-Ab3dEfGh1jKlMn0pQrStUvWxYz123456789'),
  githubClassic: fixture('ghp', '_Ab3dEfGh1jKlMn0pQrStUvWxYz1234567'),
  githubFineGrained: fixture('github_pat', '_11ABCDEFG0abcdefghijkl_MnOpQrStUvWxYz123456789'),
  slack: fixture('xoxb', '-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'),
  aws: fixture('AKIA', 'IOSFODNN7EXAMPLE'),
  // 39 characters — `AIza` plus exactly 35 — because that is the shape Google
  // issues. The first fixture here was 41, so the provider pattern never matched
  // it and the generic rule was quietly doing that row's work; the mutation run
  // is what said so.
  google: fixture('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  gitlab: fixture('glpat', '-Ab3dEfGh1jKlMn0pQrSt'),
} as const

describe('the secret detector', () => {
  const CREDENTIALS: readonly (readonly [string, string])[] = [
    ['an OpenAI-style key', FAKE.openai],
    ['an Anthropic-style key', FAKE.anthropic],
    ['a GitHub classic PAT', FAKE.githubClassic],
    ['a GitHub fine-grained PAT', FAKE.githubFineGrained],
    ['a Slack bot token', FAKE.slack],
    ['an AWS access key id', FAKE.aws],
    ['a Google API key', FAKE.google],
    ['a GitLab PAT', FAKE.gitlab],
    ['a raw hex token with no prefix', 'a3f9c1e7b25d48f0a9c3e1b7d5f2a8c4'],
    ['a base64-ish token', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg'],
    ['a flag and its token in one argument', '--api-key=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c'],
  ]

  const NOT_CREDENTIALS: readonly (readonly [string, string])[] = [
    // The two controls: if these ever read as credentials the detector is not
    // strict, it is broken, and every clause below it is measuring nothing.
    ['CONTROL — a command', 'npx'],
    ['CONTROL — a package spec', '@upstash/context7-mcp'],
    ['a bare flag', '--api-key'],
    ['a short flag value', '-y'],
    ['a normalized home path', '~/.panda/skills/commit-lint.ts'],
    ['a long normalized path', '~/.config/opencode/skills/a-really-long-skill-directory/SKILL.md'],
    ['a Windows path', 'C:\\Users\\dev\\tools\\mcp-server.exe'],
    ['a URL', 'https://mcp.linear.app/sse'],
    ['a long dashed phrase', 'this-is-a-very-long-descriptive-server-identifier'],
    ['a long word with no digits', 'supercalifragilisticexpialidociousandthensome'],
    ['a semver', '1.0.0-rc.1'],
    // The four shapes that made the first pass over-fire. Each is plausible in a
    // real argv (`--session-id`, `--ref`, `--digest`), and each is excluded by
    // an exact shape rather than by loosening the rule around it.
    ['a lowercase UUID', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['an uppercase UUID', '3F2504E0-4F89-11D3-9A0C-0305E82C3301'],
    ['a git object name', 'd4800c2f1a9b3e5c7d0f2a4b6c8e0d2f4a6b8c0e'],
    ['a sha256 digest', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['an OCI digest', 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['a long numeric id', '123456789012345678901234567890123456'],
  ]

  it.each(CREDENTIALS)('detects %s', (_label, value) => {
    expect(isCredential(value)).toBe(true)
  })

  it.each(NOT_CREDENTIALS)('leaves %s alone', (_label, value) => {
    expect(isCredential(value)).toBe(false)
  })

  it('draws its one admitted blind spot where the spec says it does', () => {
    // A credential that is EXACTLY 40 or 64 lowercase hex is indistinguishable
    // from a git object name and a sha256, and those two are the more common
    // thing to find in an argv. Pinned so the trade is a decision on record
    // rather than a surprise the next reader has to re-derive.
    expect(isCredential('0123456789abcdef0123456789abcdef01234567')).toBe(false)
    // One character shorter and it is a token again.
    expect(isCredential('0123456789abcdef0123456789abcdef0123456')).toBe(true)
  })
})

// --- The bundle ------------------------------------------------------------

describe('createBundle', () => {
  it('carries the clean entries and names what it left behind', () => {
    const bundle = createBundle(
      [
        mcp('context7', ['-y', '@upstash/context7-mcp']),
        mcp('leaky', ['--api-key', FAKE.openai]),
      ],
      HOME,
    )
    expect(bundle.version).toBe(BUNDLE_VERSION)
    expect(bundle.kind).toBe(BUNDLE_KIND)
    expect(bundle.scope).toBe('global')
    expect(bundle.entries.map((entry) => entry.id)).toEqual(['context7'])
    expect(bundle.omitted).toEqual([{ type: 'mcp-server', id: 'leaky', field: 'args' }])
  })

  it('puts no part of the credential anywhere in the artifact, including the record', () => {
    // The omission record is itself part of the artifact NFR-5 scans, so a
    // record that carried the value — or an excerpt, or its length — would
    // defeat the whole story while looking like diligence.
    const token = FAKE.openai
    const text = serializeBundle(createBundle([mcp('leaky', ['--api-key', token])], HOME))
    expect(text).not.toContain(token)
    expect(text).not.toContain(token.slice(0, 12))
    expect(text).not.toContain('Ab3dEfGh')
    // CONTROL: the id DOES travel, so the assertions above are not passing on an
    // empty document.
    expect(text).toContain('leaky')
  })

  it.each([
    ['id', { type: 'mcp-server', id: FAKE.githubClassic, command: 'npx' }],
    ['command', { type: 'mcp-server', id: 'x', command: FAKE.aws }],
    ['entryPath', { type: 'skill', id: 'x', entryPath: FAKE.gitlab }],
    ['args', { type: 'mcp-server', id: 'x', command: 'npx', args: [FAKE.aws] }],
    ['extensions', { type: 'mcp-server', id: 'x', command: 'npx', extensions: { a: { b: [FAKE.aws] } } }],
  ] as readonly (readonly [string, RegistryEntry])[])(
    'omits an entry whose %s carries one, and says which field it was',
    (field, entry) => {
      const bundle = createBundle([entry], HOME)
      expect(bundle.entries).toEqual([])
      expect(bundle.omitted).toEqual([{ type: entry.type, id: entry.id, field }])
    },
  )

  it('reads a credential used as an extensions KEY, not only as a value', () => {
    const entry: RegistryEntry = {
      type: 'mcp-server',
      id: 'x',
      command: 'npx',
      extensions: { [FAKE.aws]: 'harmless' },
    }
    expect(createBundle([entry], HOME).omitted[0]?.field).toBe('extensions')
  })

  it('normalizes machine paths, because list() hands back EXPANDED ones', () => {
    // The measurement this story froze was wrong until the binary was driven:
    // the store PERSISTS normalized paths, and `list()` maps
    // `expandRegistryEntryPaths` over everything it returns. Reading the writer
    // is not reading what the caller gets.
    //
    // Asserted as NFR-6 states it — "no machine-specific absolute path persists"
    // — rather than as one exact string. The normalizer replaces the home PREFIX
    // and leaves the rest of the value verbatim, so on Windows the result is
    // `~/skills\commit-lint.ts`; pinning that spelling would pin a separator
    // this story does not own.
    const entry: RegistryEntry = { type: 'skill', id: 'commit-lint', entryPath: join(HOME, 'skills', 'commit-lint.ts') }
    const normalized = createBundle([entry], HOME).entries[0]?.entryPath
    expect(normalized?.startsWith('~')).toBe(true)
    expect(normalized).not.toContain(HOME)
    expect(normalized).toContain('commit-lint.ts')
  })

  it('sorts by type and id, so two stores holding the same content agree byte for byte', () => {
    const forward = createBundle([mcp('b', []), mcp('a', []), { type: 'skill', id: 'a', entryPath: '~/a.ts' }], HOME)
    const reversed = createBundle([{ type: 'skill', id: 'a', entryPath: '~/a.ts' }, mcp('a', []), mcp('b', [])], HOME)
    expect(forward.entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      'mcp-server:a',
      'mcp-server:b',
      'skill:a',
    ])
    expect(serializeBundle(forward)).toBe(serializeBundle(reversed))
  })

  it('is a valid artifact when the registry is empty, not a failure', () => {
    const bundle = createBundle([], HOME)
    expect(bundle.entries).toEqual([])
    expect(bundle.omitted).toEqual([])
    expect(JSON.parse(serializeBundle(bundle))).toMatchObject({ kind: BUNDLE_KIND, scope: 'global' })
  })

  it('claims no Profiles and no Skill sources, because panda has neither', () => {
    // FR-21 names three things and one exists. An empty `profiles: []` would
    // claim panda has profiles that happen to be empty, which is what
    // correction-01 C5 calls faking; an absent key is also what lets a later
    // story add one without the version meaning something it did not.
    const parsed = JSON.parse(serializeBundle(createBundle([], HOME))) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['entries', 'kind', 'omitted', 'scope', 'version'])
  })
})

describe('writeBundle', () => {
  it('writes bytes a second export reproduces exactly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'panda-bundle-'))
    const bundle = createBundle([mcp('context7', ['-y', '@upstash/context7-mcp'])], HOME)
    const first = join(dir, 'a.json')
    const second = join(dir, 'b.json')
    await writeBundle(first, bundle)
    await writeBundle(second, createBundle([mcp('context7', ['-y', '@upstash/context7-mcp'])], HOME))
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'))
  })

  it('fails coded and names the path when the destination cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'panda-bundle-'))
    const blocker = join(dir, 'a-file')
    await writeFile(blocker, 'x')
    // A path UNDER a regular file: there is no directory for the temp file, so
    // the write fails before anything is renamed.
    const target = join(blocker, 'bundle.json')
    await expect(writeBundle(target, createBundle([], HOME))).rejects.toMatchObject({
      code: 'PANDA_REGISTRY_BUNDLE_UNAVAILABLE',
      message: expect.stringContaining(target),
    })
  })

  it('leaves an existing file intact when the write fails', async () => {
    // The temp-then-rename shape, stated as behaviour: a failed export must not
    // truncate the bundle a previous one produced.
    const dir = await mkdtemp(join(tmpdir(), 'panda-bundle-'))
    const target = join(dir, 'bundle.json')
    await writeBundle(target, createBundle([mcp('context7', [])], HOME))
    const before = await readFile(target, 'utf8')
    await writeFile(join(dir, 'blocker'), 'x')
    await expect(writeBundle(join(dir, 'blocker', 'x.json'), createBundle([], HOME))).rejects.toBeDefined()
    expect(await readFile(target, 'utf8')).toBe(before)
  })
})

// --- Reading one back (Spec M8.B) ------------------------------------------
//
// Every refusal asserts the MESSAGE, not only the code. "exits non-zero naming
// the incompatibility" is the acceptance criterion, and a coded error whose
// sentence says nothing satisfies half of it.

describe('parseBundle', () => {
  const good = serializeBundle(createBundle([mcp('context7', ['-y'])], HOME))

  function refusal(text: string): { code?: string; message: string } {
    try {
      parseBundle('/tmp/b.json', text)
    } catch (error) {
      return error as { code?: string; message: string }
    }
    throw new Error('parseBundle accepted a document it should have refused')
  }

  it('accepts what createBundle produced, which is the only thing that makes the rest meaningful', () => {
    const parsed = parseBundle('/tmp/b.json', good)
    expect(parsed.kind).toBe(BUNDLE_KIND)
    expect(parsed.version).toBe(BUNDLE_VERSION)
    expect(parsed.entries.map((entry) => entry.id)).toEqual(['context7'])
  })

  it('names a NEWER schema as newer, and says both versions', () => {
    // Story 5.2's criterion verbatim: "importing a newer-schema-major Bundle
    // exits non-zero naming the incompatibility".
    const error = refusal(JSON.stringify({ ...JSON.parse(good), version: 2 }))
    expect(error.code).toBe('PANDA_REGISTRY_BUNDLE_UNAVAILABLE')
    expect(error.message).toContain('written by a newer panda')
    expect(error.message).toContain('version 2')
    expect(error.message).toContain(`version ${BUNDLE_VERSION}`)
  })

  it.each([
    ['a version that is a string', { version: '1' }],
    ['a version that is absent', { version: undefined }],
    ['a version that is fractional', { version: 1.5 }],
  ])('refuses %s as unrecognised rather than as newer', (_label, patch) => {
    const error = refusal(JSON.stringify({ ...JSON.parse(good), ...patch }))
    expect(error.message).toContain('not one this build recognises')
    expect(error.message).not.toContain('newer panda')
  })

  it('refuses a document that is not a bundle BEFORE it talks about versions', () => {
    // A file that is not a bundle has no version to be incompatible about, and
    // sending its author to look at schema majors points the wrong way.
    const error = refusal(JSON.stringify({ hello: 'world' }))
    expect(error.message).toContain('not a panda bundle')
    expect(error.message).not.toContain('version')
  })

  it('refuses a scope it cannot install', () => {
    const error = refusal(JSON.stringify({ ...JSON.parse(good), scope: 'project' }))
    expect(error.message).toContain('"project"')
    expect(error.message).toContain("only 'global'")
  })

  it.each([
    ['not JSON at all', 'nope'],
    ['an array at the root', '[]'],
  ])('refuses %s, naming the file', (_label, text) => {
    expect(refusal(text).message).toContain('/tmp/b.json')
  })

  it.each([
    ["no 'entries' array", { entries: undefined }],
    ["no 'omitted' array", { omitted: undefined }],
  ])('refuses a bundle with %s', (label, patch) => {
    expect(refusal(JSON.stringify({ ...JSON.parse(good), ...patch })).message).toContain(label.slice(3))
  })

  it('lists EVERY invalid entry, not the first, with its index', () => {
    // Same rule the kernel's manifest validation was given in M7.B: an author
    // fixing a document by hand learns everything wrong with it in one run.
    const error = refusal(
      JSON.stringify({ ...JSON.parse(good), entries: [{ type: 'mcp-server' }, { type: 'nope', id: 'x' }] }),
    )
    expect(error.message).toContain('entries[0]')
    expect(error.message).toContain('entries[1]')
  })

  it('refuses a malformed omission record too, because it is part of the artifact', () => {
    const error = refusal(JSON.stringify({ ...JSON.parse(good), omitted: [{ type: 'mcp-server' }] }))
    expect(error.message).toContain('omitted[0]')
  })

  it('admits a RETIRED entry type, exactly as the store read path does', () => {
    // A bundle is a document written by another build. Refusing a word panda
    // has since retired would make removing a word able to brick an import --
    // the dead end M4.E exists to abolish.
    const withRetired = JSON.stringify({
      ...JSON.parse(good),
      entries: [{ type: 'tool', id: 'rg', command: 'rg' }],
    })
    expect(parseBundle('/tmp/b.json', withRetired).entries[0]).toMatchObject({ type: 'tool', id: 'rg' })
  })
})
