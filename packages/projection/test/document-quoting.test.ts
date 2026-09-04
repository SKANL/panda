import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { RegistryStore, parseBundle } from '@panda/registry'
import { setConfigValue } from '../src/config-write.ts'
import { readNativeMcpEntries } from '../src/formats.ts'
import type { ProjectionTargetTraits } from '../src/formats.ts'
import { ProjectionLedger } from '../src/ledger.ts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { CODEX_CONFIG_TRAITS } from '../src/targets/codex-config.ts'
import { OPENCODE_CONFIG_TRAITS, createOpenCodeConfigTarget } from '../src/targets/opencode-config.ts'
import type { RegistryEntriesByKind } from '@panda/contracts'

// ONE GATE over EVERY document panda parses (Spec M17.A, Change Log 1).
//
// THE RULE: no error panda raises about a document quotes that document's
// content. Not four patches with four tests — the rule was found four times
// because it was written nowhere, and a per-site test would have been four
// separate promises to keep in step.
//
// WHY IT IS THIS BROAD. The story began at `~/.claude.json`, where V8's
// `JSON.parse` message quoted a planted credential through `doctor`, `init` and
// `ingest`. The spec then recorded panda's OWN documents as clean — measured
// with the credential far from the fault, outside V8's fixed snippet window,
// which measures the window and not the code. Re-measured with it ADJACENT,
// `.panda/registry.json` leaked through `panda list` — the very verb the first
// measurement had named as its clean control — and a bundle leaked through
// `panda import`.
//
// TWO MECHANISMS, and the second is why a rule about parser messages would not
// have been enough: `TOML_STRATEGY.listEntries` never touches a parser message
// and leaked anyway, through panda's OWN prose interpolating a raw source line.
//
// CORPUS DISCIPLINE (D4), per document: a shape MEASURED to make V8 quote the
// document, and a shape that reports a clean position. A corpus drawn from one
// class proves only that class — the falsification lesson this repository has
// paid for three times now.

// Assembled from a prefix and a body, the way `bundle.ts`'s own corpus is:
// a real-looking credential as one literal trips GitHub push protection.
const TOKEN = 'sk-' + 'live-Ab3dEfGh1jKlMn0pQrStUvWxYz123456'

/**
 * THREE needles, not one. V8's snippet is a fixed window AROUND the fault, so
 * where the credential sits decides which end of it escapes: the stray-comma
 * shape leaked the token's HEAD (`…"args":[,"sk-live-"…`) and the `NaN` shape
 * leaked its TAIL (`…"Yz123456",NaN]…`). Asserting only the whole token would
 * pass both leaks, which is exactly the error that put M5 in the spec.
 */
const NEEDLES = [TOKEN, TOKEN.slice(0, 8), TOKEN.slice(-8)] as const

/**
 * D3, and the STACK half is the one that closes the `cause` path: a cause is
 * reachable from anything that prints the error, so a redaction that only
 * cleans the message moves the leak instead of closing it.
 *
 * `inspect(…, { depth: null })` is the third assertion because it is what
 * RENDERS an attached cause — `error.stack` alone does not, so a `cause`
 * restored by a later edit would slip past a message-and-stack check.
 */
function assertNoDocumentText(reported: string, error?: unknown): void {
  for (const needle of NEEDLES) {
    expect(reported).not.toContain(needle)
    if (error === undefined) continue
    expect((error as Error).message).not.toContain(needle)
    expect((error as Error).stack ?? '').not.toContain(needle)
    expect(inspect(error, { depth: null })).not.toContain(needle)
  }
}

const ENTRIES: RegistryEntriesByKind = {
  skill: [],
  'mcp-server': [{ type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }],
}

const scratch: string[] = []

async function scratchDir(): Promise<string> {
  // Under the OS temp directory, never the package: test residue has been
  // committed here twice.
  const dir = await mkdtemp(join(tmpdir(), 'panda-doc-quoting-'))
  scratch.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * What a document's reader did, flattened to the two things the rule cares
 * about: the text that reaches the user, and the error object behind it (when
 * there is one — the ledger REPORTS rather than throws).
 */
interface Reported {
  readonly text: string
  readonly error?: unknown
}

/** Fails loudly on the one outcome that would make every assertion vacuous. */
async function mustRefuse(run: () => unknown | Promise<unknown>, what: string): Promise<Reported> {
  try {
    await run()
  } catch (error) {
    return { text: (error as Error).message, error }
  }
  throw new Error(`${what} accepted a malformed document instead of refusing it`)
}

// --- the two fault shapes, one per class, spelled per document format --------

/** V8 QUOTES the document for this one: a stray comma before an array element. */
function strayComma(container: string, id: string): string {
  return `{"${container}":{"${id}":{"command":"npx","args":[,"${TOKEN}"]}}}`
}

/** V8 reports a clean POSITION for this one: a doubled comma. */
function doubledComma(container: string, id: string): string {
  return `{"${container}":{"${id}":{"command":"npx","args":["${TOKEN}"]}},,}`
}

describe('THE RULE: no error panda raises about a document quotes that document', () => {
  describe('the vendor config panda parses STRICTLY (~/.claude.json)', () => {
    const target = createClaudeMcpTarget({ filePath: '/home/u/.claude.json' })
    const refuse = (nativeText: string): Promise<Reported> =>
      // `merge` is declared async and refuses SYNCHRONOUSLY — `validate()` runs
      // before the first await — so `.rejects` never receives a promise.
      mustRefuse(() => target.merge({ entries: ENTRIES, records: [], nativeText }), 'claude merge')

    const CORPUS = [
      ['V8 QUOTES it: a stray comma before an array element', strayComma('mcpServers', 'ctx'), 'ValueExpected at line 1, column 47'],
      ['V8 QUOTES it: a NaN literal after the credential', `{"mcpServers":{"ctx":{"args":["${TOKEN}",NaN]}}}`, 'InvalidSymbol at line 1, column 74'],
      ['V8 reports a position: a doubled comma', doubledComma('mcpServers', 'ctx'), 'PropertyNameExpected at line 1, column 93'],
      ['V8 reports a position: an unquoted key', `{mcpServers:{"ctx":{"args":["${TOKEN}"]}}}`, 'InvalidSymbol at line 1, column 2'],
      ['V8 reports a position: an unterminated string', `{"mcpServers":{"ctx":{"args":["${TOKEN}]}}}`, 'UnexpectedEndOfString at line 1, column 31'],
    ] as const

    it.each(CORPUS)('%s', async (_label, nativeText, location) => {
      const reported = await refuse(nativeText)
      // The CONTROL, in the same run: panda still refuses, still codes it, still
      // names the file. "Clean" must not be reachable by panda not looking.
      expect((reported.error as { code?: string }).code).toBe('PANDA_PROJECTION_NATIVE_MALFORMED')
      expect(reported.text).toContain("'/home/u/.claude.json' is malformed")
      // E3 — the location survives, including for the two V8 gave none for.
      expect(reported.text).toContain(location)
      assertNoDocumentText(reported.text, reported.error)
    })

    it('attaches no cause at any depth (E8)', async () => {
      const reported = await refuse(strayComma('mcpServers', 'ctx'))
      expect((reported.error as Error).cause).toBeUndefined()
    })

    it('refuses a fault it cannot locate, WITHOUT falling back to the parser (E4)', async () => {
      // Reachable, not defensive: `parseTree` recurses and throws `RangeError`
      // past ~5000 levels on a document V8 also rejects. Unguarded, the
      // location-deriving call would swap a coded PandaError for a bare
      // RangeError — a regression the fix itself would have introduced.
      const deep = `${'['.repeat(20000)},"${TOKEN}"${']'.repeat(20000)}`
      const reported = await refuse(deep)
      expect((reported.error as { code?: string }).code).toBe('PANDA_PROJECTION_NATIVE_MALFORMED')
      expect(reported.text).toContain('the fault could not be located')
      assertNoDocumentText(reported.text, reported.error)
    })

    it('reads a well-formed config holding a token and prints none of it (D6/E7)', async () => {
      // The control for every row above, and the boundary this story does not
      // cross: a VALID document's token still travels, untouched.
      const outcome = await target.merge({
        entries: ENTRIES,
        records: [],
        nativeText: `{\n  "mcpServers": {\n    "keep": { "command": "npx", "args": ["${TOKEN}"] }\n  }\n}\n`,
      })
      expect(outcome.text).toContain('context7')
      expect(outcome.text).toContain(TOKEN)
    })
  })

  describe('the vendor config panda parses LENIENTLY (opencode.json)', () => {
    const target = createOpenCodeConfigTarget({ filePath: '/home/u/.config/opencode/opencode.json' })
    const refuse = (nativeText: string): Promise<Reported> =>
      mustRefuse(() => target.merge({ entries: ENTRIES, records: [], nativeText }), 'opencode merge')

    const CORPUS = [
      ['a stray comma before an array element', strayComma('mcp', 'ctx'), 'ValueExpected at line 1, column 40'],
      ['a doubled comma', doubledComma('mcp', 'ctx'), 'PropertyNameExpected at line 1, column 86'],
      ['an unquoted key', `{mcp:{"ctx":{"args":["${TOKEN}"]}}}`, 'InvalidSymbol at line 1, column 2'],
    ] as const

    it.each(CORPUS)('%s', async (_label, nativeText, location) => {
      const reported = await refuse(nativeText)
      expect((reported.error as { code?: string }).code).toBe('PANDA_PROJECTION_NATIVE_MALFORMED')
      expect(reported.text).toContain(location)
      assertNoDocumentText(reported.text, reported.error)
    })

    it('still accepts the legitimate JSONC spellings it always did', async () => {
      // The control for the rows above: refusing on ANY parse error would reject
      // working files, which is what `allowTrailingComma` exists to avoid.
      const nativeText = `{\n  // mine\n  "mcp": {\n    "keep": { "command": ["x"] },\n  },\n}\n`
      const outcome = await target.merge({ entries: ENTRIES, records: [], nativeText })
      expect(outcome.text).toContain('context7')
    })

    it('refuses a fault it cannot locate rather than throwing uncoded (Change Log 2)', async () => {
      // The lenient branch's OWN unguarded `parseTree`, the sibling of the
      // strict one. Before the guard this threw a bare RangeError.
      const deep = `${'['.repeat(20000)},"${TOKEN}"${']'.repeat(20000)}`
      const reported = await refuse(deep)
      expect((reported.error as { code?: string }).code).toBe('PANDA_PROJECTION_NATIVE_MALFORMED')
      expect(reported.text).toContain('the fault could not be located')
      assertNoDocumentText(reported.text, reported.error)
    })
  })

  describe("the vendor config panda reads by LINE, echoing its own prose (config.toml)", () => {
    // The second mechanism, and the reason the rule is not about parser messages:
    // no parser is involved. `listEntries` interpolated the raw source line, and
    // `panda ingest --dry-run` printed a planted credential verbatim out of it.
    //
    // The CONTROL is the JSONC reporter for the same input, asserted below: it
    // has always named the key and the type without the value, which is why it
    // never leaked and why it is the shape this one was corrected to.
    // Driven through `readNativeMcpEntries`, the reader `panda ingest` uses —
    // NOT through `target.claim()`, which answers from the id it was handed and
    // would have reported "ctx" for a document it never opened. The first draft
    // of this clause did exactly that and passed without touching the reporter.
    async function unreadableDetails(name: string, body: string, traits: ProjectionTargetTraits): Promise<string> {
      const root = await scratchDir()
      const filePath = join(root, name)
      await writeFile(filePath, body, 'utf8')
      const read = await readNativeMcpEntries(traits, { filePath })
      expect(read, 'the fixture exists, so the reader must not report absence').toBeDefined()
      // The CONTROL: the entry was READ and REPORTED as unreadable. A clean
      // assertion over an empty list would prove only that nothing happened.
      expect(read!.unreadable.map((entry) => entry.id)).toEqual(['ctx'])
      return read!.unreadable.map((entry) => entry.detail).join('\n')
    }

    const CORPUS = [
      ['a value not spelled the way panda renders one', `[mcp_servers.ctx]\ncommand = "npx"\nargs = [, "${TOKEN}"]\n`, 'line 3, column 7'],
      ['a line that is not one key = value assignment', `[mcp_servers.ctx]\ncommand = "npx"\n  "${TOKEN}"\n`, 'line 3, column 1'],
      ['a TOML literal string, the legitimate spelling panda declines', `[mcp_servers.ctx]\ncommand = 'npx'\n`, 'line 2, column 10'],
    ] as const

    it.each(CORPUS)('names the key and WHERE, never the value: %s', async (_label, body, location) => {
      const reported = await unreadableDetails('config.toml', body, CODEX_CONFIG_TRAITS)
      expect(reported).toContain('mcp_servers.ctx')
      expect(reported).toContain(location)
      assertNoDocumentText(reported)
    })

    it('CONTROL: the JSONC reporter on the same fault class names the key, not the value', async () => {
      // The shape the TOML reporter was corrected to, and the reason it never
      // leaked while its sibling did: it says WHICH key it could not read and
      // what it could not read it AS, and reproduces nothing.
      const reported = await unreadableDetails(
        'opencode.json',
        `{"mcp":{"ctx":{"command":["npx","${TOKEN}",7]}}}`,
        OPENCODE_CONFIG_TRAITS,
      )
      expect(reported).toContain("'command' holds a value panda cannot read")
      assertNoDocumentText(reported)
    })
  })

  describe("panda's OWN registry, where mcp-server args actually live (.panda/registry.json)", () => {
    // THE SHARPEST OF THE FOUR. This is the document that holds `mcp-server`
    // args, and `panda list` — the verb the first measurement named as its clean
    // control — printed the credential out of it.
    async function refuse(document: string): Promise<Reported> {
      const homeDir = await scratchDir()
      await mkdir(join(homeDir, '.panda'), { recursive: true })
      await writeFile(join(homeDir, '.panda', 'registry.json'), document, 'utf8')
      const store = new RegistryStore({ homeDir })
      try {
        return await mustRefuse(() => store.list('global'), 'registry store read')
      } finally {
        await store.dispose()
      }
    }

    const CORPUS = [
      ['V8 QUOTES it: a stray comma before an array element', `{"version":1,"entries":[{"type":"mcp-server","id":"ctx","command":"npx","args":[,"${TOKEN}"]}]}`, 'ValueExpected at line 1, column 81'],
      ['V8 QUOTES it: a NaN literal after the credential', `{"version":1,"entries":[{"id":"ctx","args":["${TOKEN}",NaN]}]}`, 'InvalidSymbol at line 1, column 88'],
      ['V8 reports a position: a doubled comma', `{"version":1,"entries":[{"id":"ctx","args":["${TOKEN}"]}],,}`, 'PropertyNameExpected at line 1, column 91'],
      ['V8 reports a position: an unquoted key', `{version:1,"entries":[{"id":"ctx","args":["${TOKEN}"]}]}`, 'InvalidSymbol at line 1, column 2'],
    ] as const

    it.each(CORPUS)('%s', async (_label, document, location) => {
      const reported = await refuse(document)
      // The CONTROL: panda still refuses, still codes it, still names the file.
      expect((reported.error as { code?: string }).code).toBe('PANDA_REGISTRY_STORE_UNAVAILABLE')
      expect(reported.text).toContain('registry.json')
      expect(reported.text).toContain(location)
      assertNoDocumentText(reported.text, reported.error)
    })

    it('reads a well-formed registry holding a token and prints none of it', async () => {
      // The control for the rows above, and D6's boundary: a VALID document is
      // read, and its token is returned to the caller as it always was.
      const homeDir = await scratchDir()
      const store = new RegistryStore({ homeDir })
      try {
        await store.register({ type: 'mcp-server', id: 'ctx', command: 'npx', args: [TOKEN] }, 'global')
        const entries = await store.list('global')
        expect(JSON.stringify(entries)).toContain(TOKEN)
      } finally {
        await store.dispose()
      }
    })
  })

  describe('a bundle arriving from another machine (panda import)', () => {
    const refuse = (document: string): Promise<Reported> =>
      mustRefuse(() => parseBundle('/tmp/team.bundle.json', document), 'parseBundle')

    const CORPUS = [
      ['V8 QUOTES it: a stray comma before an array element', `{"kind":"panda-bundle","entries":[{"id":"ctx","args":[,"${TOKEN}"]}]}`, 'ValueExpected at line 1, column 55'],
      ['V8 reports a position: a doubled comma', `{"kind":"panda-bundle","entries":[{"id":"ctx","args":["${TOKEN}"]}],,}`, 'PropertyNameExpected at line 1, column 101'],
    ] as const

    it.each(CORPUS)('%s', async (_label, document, location) => {
      const reported = await refuse(document)
      expect((reported.error as { code?: string }).code).toBe('PANDA_REGISTRY_BUNDLE_UNAVAILABLE')
      expect(reported.text).toContain('team.bundle.json')
      expect(reported.text).toContain(location)
      assertNoDocumentText(reported.text, reported.error)
    })
  })

  describe("panda's ownership ledger, brought under the rule (.panda/ledger.json)", () => {
    // No leak was MEASURED out of this one: it holds paths and hashes rather
    // than server arguments. It is here anyway, because "no credential happens
    // to sit inside V8's snippet window today" is a property of the fixture, not
    // of the code — which is the exact reasoning error that produced M5.
    async function report(document: string): Promise<string> {
      const dir = await scratchDir()
      const filePath = join(dir, 'ledger.json')
      await writeFile(filePath, document, 'utf8')
      const read = await new ProjectionLedger({ filePath }).read()
      // The CONTROL: it REPORTS rather than throws, and this asserts it noticed.
      expect(read.state).toBe('unreadable')
      return read.warnings.map((warning) => warning.detail).join('\n')
    }

    it.each([
      ['V8 QUOTES it: a stray comma', `{"version":1,"records":[{"ownedPaths":[,"${TOKEN}"]}]}`, 'ValueExpected at line 1, column 40'],
      ['V8 reports a position: a doubled comma', `{"version":1,"records":[{"p":"${TOKEN}"}],,}`, 'PropertyNameExpected at line 1, column 75'],
    ] as const)('%s', async (_label, document, location) => {
      const reported = await report(document)
      expect(reported).toContain('is not valid JSON')
      expect(reported).toContain(location)
      assertNoDocumentText(reported)
    })
  })

  describe("panda's own configuration, brought under the rule (.panda/config.json)", () => {
    async function refuse(document: string): Promise<Reported> {
      const homeDir = await scratchDir()
      await mkdir(join(homeDir, '.panda'), { recursive: true })
      await writeFile(join(homeDir, '.panda', 'config.json'), document, 'utf8')
      return mustRefuse(
        () => setConfigValue({ scope: 'machine', homeDir, key: 'executor', value: 'codex' }),
        'setConfigValue',
      )
    }

    it.each([
      ['V8 QUOTES it: a stray comma', `{"executor":"codex","x":[,"${TOKEN}"]}`, 'ValueExpected at line 1, column 26'],
      ['V8 reports a position: a doubled comma', `{"executor":"codex","x":"${TOKEN}",,}`, 'PropertyNameExpected at line 1, column 68'],
    ] as const)('%s', async (_label, document, location) => {
      const reported = await refuse(document)
      // The CONTROL: panda refuses to overwrite a document it cannot read, which
      // is the behaviour this clause must not have changed.
      expect((reported.error as { code?: string }).code).toBe('PANDA_CONFIGURATION_UNUSABLE')
      expect(reported.text).toContain('does not overwrite a document it cannot read')
      expect(reported.text).toContain(location)
      assertNoDocumentText(reported.text, reported.error)
    })
  })
})
