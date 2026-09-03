import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIAGNOSIS_FINDING_KINDS, FINDING_EXITS } from '@panda/environment'
import { runPanda } from '../src'
import type { ExecutorAdapter } from '@panda/contracts'

// THE INVARIANT: nothing panda prints is a command panda does not have.
//
// Every backtick-quoted `panda …` string in the SHIPPED source of every package
// — `src/` AND `bin/`, because the binary's own file prints too — is treated as
// a COMMAND and is dispatched, unless it is listed below as prose. There is no
// third outcome. The previous shape had one, and it was the whole defect: a
// token the classifier did not recognise made it `continue` past the entire
// string, VERB INCLUDED, so strings were dropped in silence while a `> 20` count
// went on passing. Three bypasses were built against it and all three stayed
// green:
//
//   (a) `panda purge 'demo'` — a single-quoted argument, this repo's dominant
//       style, hid a fabricated verb inside `panda add`'s own success output.
//   (b) `panda remove --all` — the probe dispatched argv[0] alone, so a flag the
//       binary rejects passed.
//   (c) `packages/cli/bin/panda.ts` ships, prints, and was never scanned.
//
// So the rule is inverted: unrecognised is LOUD. A string that is not a command
// has to say so below, by hand, and a listed string that stops appearing fails
// too — a list that may rot is a list that will.

const packagesDir = join(import.meta.dirname, '..', '..')

/**
 * Strings that begin with the word `panda` inside backticks and are NOT a
 * command the binary can be asked to run. Every one is listed deliberately.
 */
const NOT_A_COMMAND = new Map<string, string>([
  ['panda has no adapter named \'<value>\'; available executors: <value>', 'the catalogue\'s error for an unknown executor id'],
  ['panda <verb>', 'the GRAMMAR, written with a placeholder where a verb goes'],
  ["panda will not write '<value>' because <value>", 'the config writer refusing to overwrite a document it cannot read'],
  ["panda does not persist a '<value>' setting; it writes <value>", 'the config writer refusing a key outside its allowlist'],
  ["panda could not load the method '<value>': <value>", 'the method resolver refusing a module specifier it could not import or validate'],
  ['panda project <verb> [directory]', 'the project GRAMMAR, same placeholder'],
  ['panda <value> needs an entry type: <value>', 'a usage error whose verb came from argv the dispatcher had already accepted'],
  ['panda <value> needs the id of the <value> entry', 'the same usage error, for a missing id'],
  ['panda run ... | head', 'a SHELL PIPELINE in a comment about EPIPE, not an argv'],
  ['panda has no registry document at \'<value>\'', 'doctor\'s not-initialised detail'],
  ['panda would rewrite \'<value>\' and the location is not writable', 'doctor\'s not-writable detail'],
  ['panda reported no <value> finding in this run, so there is nothing for \'<value>\' to resolve; panda never remediates a state it did not just report', 'a remediation refusal'],
  ['panda knows no location where a previous build could have written into \'<value>\'', 'a discard refusal'],
  ['panda could not tie <value> back to one projection target and one registry entry, so it will not act on it', 'a remediation refusal'],
  ['panda wrote \'<value>\' to \'<value>\' and it is gone; panda will not re-add it', 'the config target\'s removed-by-user detail'],
  ['panda could not determine whether it is free (<value>)', 'the occupancy check\'s unclassifiable answer'],
  ['panda could not determine whether these exist, so this is not evidence that nothing is installed: <value>', 'the undetermined-evidence sentence doctor prints; it WRAPPED across two source lines and was therefore invisible here until the unclosed-line guard forced it onto one'],
  ['panda would not materialise \'<value>\' under \'<value>\' and holds no record of ever having done so, so there is nothing there for panda to claim', 'an adopt refusal on a skills root'],
  ['panda wrote \'<value>\' under \'<value>\' and it is gone; panda will not re-add it', 'the skills target\'s removed-by-user detail'],
  ['panda gains authority to overwrite AND to REMOVE exactly these path(s) on a later run: <value>', 'what adopt says before it claims'],
  ['panda takes ownership of the <value> byte(s) now at \'<value>\' in \'<value>\'', 'what adopt describes'],
  ['panda re-takes ownership of \'<value>\' in \'<value>\' at its CURRENT <value> byte(s), replacing the hash it held', 'what adopt describes on a re-claim'],
  ['panda holds no claim for \'<value>\' at \'<value>\', so there is nothing to release', 'a release refusal'],
  ['panda stops claiming \'<value>\' in \'<value>\'; whatever is there stays exactly as it is, and panda will treat it as foreign until it is adopted again. Nothing on disk is removed by this or by any later run while the claim is gone', 'what release describes'],
  ['panda cannot read any of \'<value>\' and will REPLACE it with an empty ledger: panda then claims nothing at all, every entry it has written anywhere reports as a foreign collision, and each one has to be adopted back deliberately', 'what repair describes on a wholly unreadable ledger'],
  ['panda rewrites \'<value>\' holding exactly the <value> record(s) it can read; the records it cannot read are dropped and the entries behind them report as foreign collisions until they are adopted', 'what repair describes'],
  ['panda removes <value> from \'<value>\'; every other byte of the file is left exactly as it is', 'what discard describes'],
  ['panda could not resolve an \'<value>\' selection through its configuration layers', 'the session\'s selection failure'],
  ['panda has no workspace provider named \'<value>\'; available providers: <value>', 'the workspace catalogue\'s error for an unknown provider id -- the twin of the executor entry at the top of this list'],
])

/**
 * Commands panda prints as COUNTER-EXAMPLES — spellings the binary refuses on
 * purpose. Their verb must still dispatch, and the refusal is asserted rather
 * than assumed, so an entry that quietly became valid fails here.
 */
const REFUSED_ON_PURPOSE = new Map<string, string>([
  ['panda project init -f', 'the COUNTER-EXAMPLE in run.ts: a single dash used to fall through as a positional and create a directory named -f'],
  ['panda remove mcp-server --fs', 'the COUNTER-EXAMPLE in registry-commands.ts: the spelling that cannot name a dash-id, which is why -- exists'],
])

function shippedFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '__scratch' || entry.name === 'node_modules' || entry.name === 'dist') return []
      const path = join(dir, entry.name)
      return entry.isDirectory() ? shippedFiles(path) : entry.name.endsWith('.ts') ? [path] : []
    })
  } catch {
    return []
  }
}

/** Every package's shipped `src/` and `bin/`. Output text is not one package's. */
function everyShippedFile(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      ...shippedFiles(join(packagesDir, entry.name, 'src')),
      ...shippedFiles(join(packagesDir, entry.name, 'bin')),
    ])
}

const TICK = String.fromCharCode(96)
const BACKSLASH = String.fromCharCode(92)
// `panda` followed by a space or the closing tick, so `panda-missing-x` is not
// one; and never across a newline, because a command lives on one line.
const PRINTED = new RegExp(TICK + 'panda(?=' + TICK + '| )[^' + TICK + BACKSLASH + 'n]*' + TICK, 'g')
// The same opening, with NO closing tick before end of line. A legal multi-line
// template literal is invisible to `PRINTED` (which cannot cross a newline), so
// it slipped past the whole suite. Unrecognised is LOUD: this makes the wrap
// itself the failure rather than the string it hides.
const UNCLOSED = new RegExp(TICK + 'panda(?=' + TICK + '| )[^' + TICK + ']*$')
const INTERPOLATION = new RegExp(BACKSLASH + '$' + BACKSLASH + '{[^}]*}', 'g')
const TRAILING_ESCAPE = new RegExp(BACKSLASH + BACKSLASH + '$')

/** The command as argv: every interpolation becomes one placeholder token. */
function printedTokens(raw: string): string[] {
  return raw.replace(INTERPOLATION, '<value>').replace(TRAILING_ESCAPE, '').trim().split(/ +/)
}

interface Printed {
  readonly text: string
  readonly file: string
  readonly tokens: readonly string[]
}

function printedIn(file: string): Printed[] {
  const source = readFileSync(file, 'utf8')
  const found: Printed[] = []
  for (const match of source.matchAll(PRINTED)) {
    const tokens = printedTokens(match[0].slice(1, -1))
    found.push({ text: tokens.join(' '), file, tokens })
  }
  return found
}

const printed = everyShippedFile().flatMap(printedIn)

/** Every printed string that is a command: not listed as prose, one per text. */
function commands(): Map<string, Printed> {
  const byText = new Map<string, Printed>()
  for (const command of printed) {
    if (NOT_A_COMMAND.has(command.text)) continue
    if (!byText.has(command.text)) byText.set(command.text, command)
  }
  return byText
}

/** `['init']`, `['project','init']`, `['--help']` — what dispatch reads. */
function verbPathOf(tokens: readonly string[]): string[] {
  const rest = tokens.slice(1)
  return rest[0] === 'project' ? rest.slice(0, 2) : rest.slice(0, 1)
}

const probeDir = mkdtempSync(join(tmpdir(), 'panda-printed-'))

/** Never spawns anything: `panda run` is answered by this, not by an executor. */
const inertAdapter: ExecutorAdapter = {
  async run() {
    return { status: 'ok', data: null, summary: 'inert', errors: [] }
  },
}

async function dispatch(tokens: readonly string[]): Promise<{ code: number; err: string }> {
  const err: string[] = []
  const code = await runPanda(tokens, {
    stdout: () => {},
    stderr: (line) => err.push(line),
    homeDir: probeDir,
    cwd: probeDir,
    createAdapter: () => inertAdapter,
  })
  return { code, err: err.join(String.fromCharCode(10)) }
}

/** Every shipped line that opens a printed command and does not close it. */
function unclosedIn(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split(String.fromCharCode(10))
    .flatMap((line, index) => (UNCLOSED.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []))
}

describe('nothing panda prints is a command panda does not have', () => {
  it('scans every package, `bin/` included, and finds the commands to check', () => {
    const files = everyShippedFile()
    expect(files.some((file) => file.includes(join('cli', 'bin')))).toBe(true)
    const texts = new Set(printed.map((command) => command.text))
    expect(texts.size).toBeGreaterThan(50)
    expect(texts).toContain('panda init')
    expect(texts).toContain('panda remove <type> <id>')
    // From `bin/panda.ts`, which the previous shape never opened.
    expect(texts).toContain('panda run ... | head')
  })

  it('refuses a printed command wrapped across two source lines, which the scanner cannot see', () => {
    const wrapped = everyShippedFile().flatMap(unclosedIn)
    expect(
      wrapped,
      'a printed `panda ...` command must live on ONE line or the invariant never sees it',
    ).toEqual([])
  })

  // THE SECOND SLOT, and it was blind. `FINDING_EXITS[kind].command` is what
  // `panda doctor` prints as "To leave this state: ...", and it is an ordinary
  // single-quoted string -- so the backtick scanner above never saw it. A
  // planted `command: 'panda evict-retired --all'` left this file 8/8 green
  // while doctor told users to run a verb the binary does not have. Derived from
  // the record rather than scanned, so quoting cannot hide one again.
  it('dispatches every command `panda doctor` names as an exit, whatever its quoting', async () => {
    let checked = 0
    for (const kind of DIAGNOSIS_FINDING_KINDS) {
      const exit = FINDING_EXITS[kind]
      if (exit.by !== 'command') continue
      checked += 1
      const tokens = printedTokens(exit.command)
      expect(tokens[0], kind).toBe('panda')
      const path = verbPathOf(tokens)
      expect((await dispatch([...path, '--help'])).code, `${kind} names 'panda ${path.join(' ')}'`).toBe(0)
      expect((await dispatch(tokens.slice(1))).err, kind).not.toContain('unrecognized option')
    }
    expect(checked, 'no `by: command` exit was checked, so this proves nothing').toBeGreaterThan(0)
  })

  it('leaves no listed string that no longer appears, because a list that may rot will', () => {
    const seen = new Set(printed.map((command) => command.text))
    for (const text of [...NOT_A_COMMAND.keys(), ...REFUSED_ON_PURPOSE.keys()]) {
      expect(seen.has(text), `'${text}' is listed and is no longer printed; delete the entry`).toBe(true)
    }
  })

  it('dispatches the VERB of every command it prints', async () => {
    const failures: string[] = []
    for (const [text, command] of commands()) {
      const path = verbPathOf(command.tokens)
      const { code } = await dispatch([...path, '--help'])
      if (code !== 0) failures.push(`'${text}' in ${command.file} names 'panda ${path.join(' ')}'`)
    }
    expect(failures, 'these name a command the binary does not dispatch').toEqual([])
  })

  it('accepts every FLAG in every command it prints', async () => {
    const failures: string[] = []
    for (const [text, command] of commands()) {
      if (REFUSED_ON_PURPOSE.has(text)) continue
      const { err } = await dispatch(command.tokens.slice(1))
      if (err.includes('unrecognized option')) {
        failures.push(`'${text}' in ${command.file}: ${err.split(String.fromCharCode(10))[0]}`)
      }
    }
    expect(failures, 'these print a flag the binary rejects').toEqual([])
  })

  it('still refuses every spelling it prints as a counter-example', async () => {
    for (const [text, reason] of REFUSED_ON_PURPOSE) {
      const { err } = await dispatch(printedTokens(text).slice(1))
      expect(err, `'${text}' is listed as refused (${reason}) and is now accepted`).toContain(
        'unrecognized option',
      )
    }
  })

  // --- the falsifications, kept in the suite -------------------------------
  //
  // Each one is a bypass that WAS built against the previous shape and left the
  // whole suite green. Asserted here rather than only recorded, so the mechanism
  // cannot quietly lose any of the three again.

  it('(a) catches a fabricated verb hidden behind a quoted argument', async () => {
    const tokens = printedTokens("panda purge 'demo'")
    expect(tokens).toEqual(['panda', 'purge', "'demo'"])
    // Not listed as prose, so it is a command — and its verb does not dispatch.
    expect(NOT_A_COMMAND.has(tokens.join(' '))).toBe(false)
    expect((await dispatch([...verbPathOf(tokens), '--help'])).code).not.toBe(0)
  })

  it('(b) catches a flag the binary rejects, which argv[0] alone never sees', async () => {
    // The verb IS dispatched — which is exactly why probing argv[0] passed it.
    expect((await dispatch(['remove', '--help'])).code).toBe(0)
    expect((await dispatch(['remove', '--all'])).err).toContain('unrecognized option')
  })

  it('(c) scans bin/, whose file ships and prints', () => {
    const binFiles = everyShippedFile().filter((file) => file.includes(join('cli', 'bin')))
    expect(binFiles.length).toBeGreaterThan(0)
    expect(printed.some((command) => binFiles.includes(command.file))).toBe(true)
  })
})
