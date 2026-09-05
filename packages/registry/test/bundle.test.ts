import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  BUNDLE_KIND,
  BUNDLE_VERSION,
  OMITTED_FIELDS,
  createBundle,
  isCredential,
  parseBundle,
  serializeBundle,
  writeBundle,
} from '../src'
import type { OmittedEntry, OmittedField } from '../src'
import type { RegistryEntry } from '@skanl/panda-contracts'

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
  /**
   * A 32-char opaque token: the shape the generic rule catches, with no provider
   * prefix. Assembled from parts like the `FAKE` fixtures above, so no scannable
   * literal exists on disk -- GitHub push protection rejected this repo's first
   * M8.A push over exactly that (a real credential SHAPE is the point of a
   * corpus, and the unblock URL marks a fake as an allowed real secret, which is
   * the wrong answer).
   */
  const OPAQUE_32 = `a9F3kQ2mZ7pX${'1vN8sT4wR6yB'}0cD5eG3h`

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

  /**
   * THE FLAG NAMES THE VALUE, and the same value spelled two ways used to get
   * opposite verdicts.
   *
   * `NOT_A_CREDENTIAL` excludes an exactly-40 or exactly-64 lowercase hex run
   * because a git object name and a sha256 are both plausible in a real argv --
   * the trade `deferred-work.md` recorded, measured against a corpus, because a
   * false positive DROPS a user's entry. What it could not see is which value it
   * was looking at, and its upgrade path said so: "none that is an improvement
   * without a SECOND SIGNAL".
   *
   * The second signal was already in hand and unread. `args` is an ORDERED array
   * and a flag can be inline, so `--ref` and `--token` are distinguishable for
   * free. Driven through the real `createBundle` before this clause existed:
   *
   *   --ref  <sha>   travels    correct
   *   --ref=<sha>    OMITTED    WRONG -- a legitimate entry dropped
   *   --token <hex>  travels    WRONG -- a secret escapes
   *   --token=<hex>  OMITTED    correct
   *
   * The separator decided, not the meaning. Both rows are fixed by one rule.
   */
  const GIT_SHA = '0123456789abcdef0123456789abcdef01234567'
  const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

  it.each([
    ['a ref names a git object', ['--ref', GIT_SHA], false],
    ['a ref names it inline too', [`--ref=${GIT_SHA}`], false],
    ['a digest names a sha256', ['--digest', SHA256], false],
    ['a session id names an opaque id', ['--session-id', GIT_SHA], false],
    ['a token flag names a secret', ['--token', GIT_SHA], true],
    ['a token flag names it inline too', [`--token=${GIT_SHA}`], true],
    ['an api-key flag names a secret', ['--api-key', SHA256], true],
    ['a vendor-prefixed key flag counts', ['--openai-api-key', GIT_SHA], true],
  ] as readonly (readonly [string, string[], boolean])[])(
    'omits an entry only when %s',
    (_label, args, omitted) => {
      const bundle = createBundle([{ type: 'mcp-server', id: 'srv', command: 'npx', args }], HOME)
      expect(bundle.omitted.length === 1).toBe(omitted)
      // CONTROL, per row: the opposite side must be non-empty, so a run where
      // createBundle returned nothing at all cannot satisfy either expectation.
      expect(bundle.entries.length === 1).toBe(!omitted)
    },
  )

  it.each(NOT_CREDENTIALS)('leaves %s alone', (_label, value) => {
    expect(isCredential(value)).toBe(false)
  })

  /**
   * A credential inside a URL (M34.A). Measured at 547c6f4 through the real
   * `createBundle`: all three of these TRAVELLED in `entries[]` with `omitted`
   * EMPTY, so `panda export` reported that nothing was left out while the token
   * left the machine. `looksLikePath` is true for anything containing `/`, so
   * every URL short-circuited to "not a credential" before the opaque-token
   * rule ran -- and it returned a flat `false` where the exclusion one line
   * above already deferred to the flag.
   *
   * Two rules close it and they are not interchangeable. The flag fallback
   * catches a path-shaped value under a flag that NAMES a secret; the URL rule
   * catches a URL-borne secret whatever the flag is called, which is the case
   * that matters because `--url` must never join `SECRET_FLAG` -- that would
   * make every remote server's URL a credential and DROP the user's entry.
   */
  const URL_BORNE: readonly (readonly [string, string])[] = [
    ['a token in userinfo', `https://user:${OPAQUE_32}@mcp.example.com/sse`],
    ['a token in a query value', `https://mcp.example.com/sse?token=${OPAQUE_32}`],
    ['a token as the last path segment', `https://mcp.example.com/mcp/${OPAQUE_32}`],
  ]

  const URL_CLEAN: readonly (readonly [string, string])[] = [
    ['a plain remote server url', 'https://mcp.sentry.dev/mcp'],
    ['a url with short query values', 'https://mcp.example.com/sse?v=2&mode=fast'],
    ['a url with a deep but plain path', 'https://api.example.com/v1/servers/weather/sse'],
    ['an npm package spec, which is not a url at all', '@modelcontextprotocol/server-filesystem'],
  ]

  it.each(URL_BORNE)('reads %s as a credential', (_label, value) => {
    expect(isCredential(value)).toBe(true)
  })

  it.each(URL_CLEAN)('leaves %s alone, because a false positive DROPS the entry', (_label, value) => {
    expect(isCredential(value)).toBe(false)
  })

  it('leaves the path exclusion UNCONDITIONAL, because deferring to the flag drops entries', () => {
    // Measured, and it is why this rule is the URL parser and not a second flag
    // heuristic. Making `looksLikePath` defer to the flag the way its sibling
    // exclusion does looks like derivation and is not: there the value already
    // matched a credential SHAPE and the flag only breaks a tie.
    const under = (flag: string, value: string) =>
      createBundle([{ type: 'mcp-server', id: 'srv', command: 'npx', args: [flag, value] }], HOME).omitted.length === 1
    // A path to a FILE holding a token is an ordinary spelling; dropping it
    // costs the user their entry, which is the direction the exclusion exists
    // to prevent.
    expect(under('--token', '/var/run/secrets/mcp-token')).toBe(false)
    expect(under('--root', '/home/me/projects/some-server/bin')).toBe(false)
    // CONTROL: the detector is still strict where it can be precise.
    expect(under('--url', `https://h/x/${OPAQUE_32}`)).toBe(true)
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

  // The omission record is itself part of the artifact NFR-5 scans, so a record
  // that carried the value — or an excerpt, or its length — would defeat the
  // whole story while looking like diligence.
  //
  // Driven over EVERY arm, and that is the whole lesson of this row. The first
  // version of this clause planted its token in `args` only, with `id: 'leaky'`,
  // so the one arm that could fail it — the arm where the credential IS the id —
  // was never exercised. That is `document-quoting.test.ts:36-39`'s falsification
  // lesson committed inside the test written to prevent it.
  //
  // Three needles per arm, as M17.A established: the whole token, its first eight
  // characters, its last eight. The CONTROL is per-arm and must be satisfiable
  // only by the code under test — for the four value arms the id still travels,
  // and for the `id` arm the record's FIELD NAME travels while no part of the
  // token does.
  const NOTHING_ANYWHERE: readonly (readonly [OmittedField, RegistryEntry, string])[] = [
    ['id', { type: 'mcp-server', id: FAKE.githubClassic, command: 'npx' }, FAKE.githubClassic],
    ['command', { type: 'mcp-server', id: 'leaky', command: FAKE.aws }, FAKE.aws],
    ['entryPath', { type: 'skill', id: 'leaky', entryPath: FAKE.gitlab }, FAKE.gitlab],
    ['args', mcp('leaky', ['--api-key', FAKE.openai]), FAKE.openai],
    [
      'extensions',
      { type: 'mcp-server', id: 'leaky', command: 'npx', extensions: { a: { b: [FAKE.anthropic] } } },
      FAKE.anthropic,
    ],
  ]

  it.each(NOTHING_ANYWHERE)(
    'puts no part of the credential anywhere in the artifact when the %s arm carries it, including the record',
    (field, entry, token) => {
      const text = serializeBundle(createBundle([entry], HOME))
      expect(text).not.toContain(token)
      expect(text).not.toContain(token.slice(0, 8))
      expect(text).not.toContain(token.slice(-8))
      if (field === 'id') {
        // CONTROL for the arm with nothing else to name, and satisfiable ONLY by
        // the code under test. `toContain('"field"')` was not: every omission
        // record on every arm contains that key, so a build that recorded the
        // wrong arm — or recorded this entry as an `args` omission — satisfied it.
        // The record is read back instead, so it has to name THIS arm.
        expect(JSON.parse(text).omitted).toEqual([{ type: entry.type, field: 'id' }])
      } else {
        // CONTROL: the id DOES travel, so the assertions above are not passing
        // on an empty document.
        expect(text).toContain('leaky')
      }
    },
  )

  const OMITS_AND_NAMES: readonly (readonly [OmittedField, RegistryEntry])[] = [
    ['id', { type: 'mcp-server', id: FAKE.githubClassic, command: 'npx' }],
    ['command', { type: 'mcp-server', id: 'x', command: FAKE.aws }],
    ['entryPath', { type: 'skill', id: 'x', entryPath: FAKE.gitlab }],
    ['args', { type: 'mcp-server', id: 'x', command: 'npx', args: [FAKE.aws] }],
    ['extensions', { type: 'mcp-server', id: 'x', command: 'npx', extensions: { a: { b: [FAKE.aws] } } }],
  ]

  it('drives both corpora over EVERY field the bundle can omit, and over nothing else', () => {
    // D4 says "the corpus is all FIVE arms" and, until this row, nothing
    // executable said five: both lists were hand-written and a sixth field could
    // be added to `OMITTED_FIELDS` while both corpora stayed silently at five.
    // Derived from the shipped list rather than counted.
    expect(NOTHING_ANYWHERE.map(([field]) => field)).toEqual([...OMITTED_FIELDS])
    expect(OMITS_AND_NAMES.map(([field]) => field)).toEqual([...OMITTED_FIELDS])
  })

  it.each(OMITS_AND_NAMES)(
    'omits an entry whose %s carries one, and says which field it was',
    (field, entry) => {
      const bundle = createBundle([entry], HOME)
      expect(bundle.entries).toEqual([])
      // INVERTED, not deleted. This row used to assert `{type, id, field}` on
      // every arm — so the suite REQUIRED the credential to sit in the record on
      // the one arm where the id IS the credential. A red pin is a question, and
      // this one was answered by M8.A's own frozen clause: "an entry whose `id`
      // matches is omitted with `field: 'id'` and nothing else about it is
      // written."
      expect(bundle.omitted).toEqual([
        field === 'id' ? { type: entry.type, field } : { type: entry.type, id: entry.id, field },
      ])
    },
  )

  it('records two id-arm entries of one type, and still exports one store byte for byte twice', () => {
    // E3. The two records are indistinguishable — that is the cost D3 wrote down
    // — and byte-identity survives it because `Array.prototype.sort` is stable
    // and one store read twice yields one input order.
    const entries: readonly RegistryEntry[] = [
      { type: 'mcp-server', id: FAKE.githubClassic, command: 'npx' },
      { type: 'mcp-server', id: FAKE.aws, command: 'npx' },
    ]
    expect(createBundle(entries, HOME).omitted).toEqual([
      { type: 'mcp-server', field: 'id' },
      { type: 'mcp-server', field: 'id' },
    ])
    expect(serializeBundle(createBundle(entries, HOME))).toBe(serializeBundle(createBundle(entries, HOME)))
  })

  it('orders an id-arm record against a value-arm record of the same type deterministically', () => {
    // E4. The id arm sorts under its type alone, so it precedes every value-arm
    // record of that type; both input orders produce the same bytes.
    const idArm: RegistryEntry = { type: 'mcp-server', id: FAKE.githubClassic, command: 'npx' }
    const valueArm: RegistryEntry = { type: 'mcp-server', id: 'leaky', command: FAKE.aws }
    const forward = createBundle([idArm, valueArm], HOME)
    expect(forward.omitted).toEqual([
      { type: 'mcp-server', field: 'id' },
      { type: 'mcp-server', id: 'leaky', field: 'command' },
    ])
    expect(serializeBundle(forward)).toBe(serializeBundle(createBundle([valueArm, idArm], HOME)))
  })

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

// The `id` arm's absent slot is a COMPILE-TIME guarantee, so a runtime clause
// cannot pin it — and nothing did: deleting `readonly id?: never` from
// `bundle.ts` left all 170 rows green. `expectTypeOf` is the idiom this repo
// already argues for over `@ts-expect-error` (`kernel/test/log.test.ts:151-160`):
// it cannot be satisfied by an unrelated error landing on the same line, and it
// fails whether the slot is deleted, widened to `string`, or made optional.
// `packages/registry/tsconfig.json` includes `test` and this package's
// `typecheck` script is `tsc --noEmit` inside `pnpm check`, so the gate is where
// it goes red.
//
// Measured on this build's tsc (`.scratch/never-probe.mjs`), which is also why
// the type's own comment now says less than it used to. WITHOUT the slot:
//   - a fresh literal whose `field` is an un-narrowed `OmittedField` compiles
//     clean — this is the exact line the story removed from `createBundle`;
//   - a pre-built, non-fresh `{type, id, field:'id' as const}` compiles clean;
//   - a fresh literal whose `field` is the LITERAL `'id'` is REJECTED (TS2353),
//     because TypeScript discriminates first and then applies excess-property
//     checking per arm.
// WITH the slot all three are rejected. So the slot is load-bearing on two
// routes, not on every route, and the comment must not claim more.
describe('OmittedEntry', () => {
  it('has no slot for an id on the arm where the id IS the credential', () => {
    expectTypeOf<{ type: 'mcp-server'; id: string; field: 'id' }>().not.toExtend<OmittedEntry>()
  })

  it('still carries the id on every other arm, so the pin above is not vacuous', () => {
    expectTypeOf<{ type: 'mcp-server'; id: string; field: 'args' }>().toExtend<OmittedEntry>()
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

  it('round-trips BOTH arms of the omission record', () => {
    // E5. `parseBundle` has to accept what this build writes, on both arms, or
    // the artifact is unreadable by the build that produced it.
    const text = serializeBundle(
      createBundle(
        [{ type: 'mcp-server', id: FAKE.githubClassic, command: 'npx' }, mcp('leaky', ['--api-key', FAKE.openai])],
        HOME,
      ),
    )
    expect(parseBundle('/tmp/b.json', text).omitted).toEqual([
      { type: 'mcp-server', field: 'id' },
      { type: 'mcp-server', id: 'leaky', field: 'args' },
    ])
  })

  it('REFUSES a pre-M18.A record that carried the credential as its id', () => {
    // E6. Not a BUNDLE_VERSION bump: that moves when an older reader could
    // MISREAD a document, and a refusal is not a misread. Refused rather than
    // accepted-and-stripped, because stripping would mean reading it first.
    const error = refusal(JSON.stringify({ ...JSON.parse(good), omitted: [{ type: 'mcp-server', id: 'x', field: 'id' }] }))
    expect(error.message).toContain('it holds invalid entries')
    expect(error.message).toContain('omitted[0]')
    // And it says what the reader can DO. A refusal that only describes the
    // shape it wanted hands the problem back, which is the thing panda is not
    // allowed to do: the bundle is stale, and re-exporting on the source machine
    // is the whole remedy.
    expect(error.message).toContain('export it again from the source machine')
  })

  // The four rows below are one root: `parseBundle` CAST the omitted array where
  // its sibling `entries[]` constructs one out of validated fields. A predicate
  // over unvalidated JSON leaves the document's own object in the process, and
  // `runImportCommand` copies that object onto `panda import`'s stdout — a fourth
  // exit site nothing in D5 enumerates. `omitted[]` is given the SAME policy the
  // sibling has had since M4.C rather than a second one: the type vocabulary is
  // checked, unknown root keys are refused, and the record panda keeps is built.
  const R1_TOKEN = 'ghp' + '_Zz9YxWv8UtSr7QpOn6MlKj5Ih4Gf3Ed2Cb1A'

  it('refuses an omission record carrying a key its envelope does not have', () => {
    // `{type, field:'id', note:<token>}` passed the old predicate whole. So did
    // `__proto__`, because JSON.parse makes it an OWN data property and the old
    // check was `'id' in record`.
    const error = refusal(
      JSON.stringify({ ...JSON.parse(good), omitted: [{ type: 'mcp-server', field: 'id', note: R1_TOKEN }] }),
    )
    expect(error.message).toContain('omitted[0]')
    expect(error.message).not.toContain(R1_TOKEN)
    // `__proto__` in particular: `JSON.parse` makes it an OWN data property, so
    // the old `'id' in record` check read `false` for it and the record passed.
    // Written as JSON text rather than an object literal, because `__proto__:`
    // in source sets the prototype instead of a key.
    const document = JSON.parse(good) as Record<string, unknown>
    document['omitted'] = JSON.parse(`[{"type":"mcp-server","field":"id","__proto__":{"id":"${R1_TOKEN}"}}]`)
    expect(refusal(JSON.stringify(document)).message).toContain("'__proto__' is not allowed")
  })

  it('refuses an omission record whose type is not a word panda stores', () => {
    // `type` was DECLARED `StoredEntryType` and validated as a bare string, which
    // left it the only free-text slot on the arm that must carry none — and
    // `panda import` interpolates it into the pending sentence, so a credential
    // there reached stderr too.
    const error = refusal(JSON.stringify({ ...JSON.parse(good), omitted: [{ type: R1_TOKEN, field: 'id' }] }))
    expect(error.message).toContain('omitted[0]')
    expect(error.message).not.toContain(R1_TOKEN)
  })

  it('still admits an omission record naming a RETIRED type, as the sibling entries array does', () => {
    // Same vocabulary as `registryEntryIssues(candidate, true)` one loop above,
    // not a stricter second one: a bundle is a document another build wrote, and
    // retiring a word must not brick an import (M4.E).
    const text = JSON.stringify({ ...JSON.parse(good), omitted: [{ type: 'tool', id: 'rg', field: 'command' }] })
    expect(parseBundle('/tmp/b.json', text).omitted).toEqual([{ type: 'tool', id: 'rg', field: 'command' }])
  })

  it('BUILDS the record it keeps instead of handing back the parsed document object', () => {
    // What pins the constructor once unknown keys are refused: the record panda
    // holds is assembled from the fields it validated, in its own order, so the
    // document's key order cannot reach the process. Restore the `as readonly
    // OmittedEntry[]` cast and this reddens.
    const text = JSON.stringify({ ...JSON.parse(good), omitted: [{ field: 'id', type: 'mcp-server' }] })
    expect(Object.keys(parseBundle('/tmp/b.json', text).omitted[0]!)).toEqual(['type', 'field'])
  })

  it('refuses an omission record naming a field that is not one of the five', () => {
    const error = refusal(JSON.stringify({ ...JSON.parse(good), omitted: [{ type: 'mcp-server', id: 'x', field: 'env' }] }))
    expect(error.message).toContain('omitted[0]')
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
