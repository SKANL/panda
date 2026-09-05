import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RegistryEntry } from '@skanl/panda-contracts'
import { groupByKind, runProjection } from '../src/engine.ts'
import { ProjectionLedger } from '../src/ledger.ts'
import { snapshotRealSkillsRoots } from './real-skills-roots.ts'
import {
  CLAUDE_SKILLS_TRAITS,
  CODEX_SKILLS_TRAITS,
  OPENCODE_SKILLS_TRAITS,
  createSkillsTargetFromTraits,
} from '../src/targets/skills.ts'
import type { SkillsTargetTraits } from '../src/targets/skills.ts'

// Per-executor LIVE measurement of DISCOVERY (Story M4.B).
//
// correction-01 exists because a previous build wrote panda's vocabulary at
// locations no executor reads, and every acceptance criterion passed anyway. So
// the criterion here is not "the file is at the path panda claims". It is: put a
// skill there THROUGH PANDA, then ask the real binary what it found, and require
// the binary to name it. The executor is the witness; panda is not.
//
// HOW EACH ONE IS ASKED, and why the answer cannot be faked:
//
//   claude-code  has no offline listing, so the request it would send is
//                intercepted instead: `ANTHROPIC_BASE_URL` points at a local
//                stub that captures the body and answers with one canned
//                message. The body carries claude's own "available skills"
//                block, which is PARSED — asserting a bare token anywhere in a
//                200 KB body passed on a SKILL.md with no frontmatter at all,
//                because claude falls back to the directory name. Membership of
//                the parsed block, name AND description, is the real check.
//   codex        `codex debug prompt-input` renders the model-visible prompt as
//                JSON. It names each skill with a SHORT reference plus a table
//                of skill roots (`r0` = <dir>), NOT an absolute path — it used
//                to print the absolute path and the clause below matched it as
//                a substring, which went red for several sessions and was read
//                as an environmental "local-only Windows" failure. It was a
//                vendor format change, and discovery never broke.
//   opencode     `opencode debug skill` lists every skill with the exact
//                `location` it came from.
//
// Each case is DIFFERENTIAL: a control id that panda never materialised must be
// absent from the same answer.
//
// THE CWD IS DELIBERATELY NOT THE INJECTED HOME. All three executors also read
// PROJECT-scope skills relative to the working directory, so running them with
// `cwd === homeDir` makes home scope and project scope the same string and
// neither is measured. Every case below runs from a sibling directory that holds
// no configuration at all, so the only explanation for the planted skill turning
// up is the home-scope root panda wrote into. This story ships machine scope
// only, so that is the branch the proof has to cover.
//
// WHAT REDIRECTION ACTUALLY BUYS, measured rather than assumed:
//   - claude honours `HOME`/`USERPROFILE` for its skills root, and NOT for
//     everything: the captured prompt still carries the developer's real
//     `~/.claude/CLAUDE.md`. The skills half is what this file asserts on.
//   - codex resolves its home through the OS profile API on Windows, so
//     `HOME`/`USERPROFILE` do not move it. `CODEX_HOME` does, and is set here.
//     The residual assumption — that `CODEX_HOME` defaults to `~/.codex` — is
//     the same one Story 2.8's shipped `~/.codex/config.toml` already rests on.
//   - opencode honours the injected home for its own config root and IGNORES it
//     for the external scans of `~/.claude/skills` and `~/.agents/skills`; under
//     a fresh injected home it still listed 38 of the developer's own. Its own
//     documented switch turns those off.
// The three real skills roots are snapshotted before and after regardless.
//
// Why a case may skip, and why that is loud: `<binary> --version` through a
// shell keys on the EXIT STATUS, so a binary that is present and cannot answer
// skips rather than passing. On a machine with none of the three installed (CI)
// every case skips, and the last case writes to stdout DIRECTLY — vitest's
// default reporter swallows `console.log`, which is the reporter CI runs, so a
// run that measured nothing would otherwise be green and silent.
//
// PANDA_LIVE_SKILLS=0 forces a skip.

const PROBE_TIMEOUT_MS = 30_000
const RUN_TIMEOUT_MS = 180_000

/** The skill panda plants. */
const PLANTED = 'panda-live-planted-skill'
/** Never materialised anywhere. Its ABSENCE is what makes each answer differential. */
const CONTROL = 'panda-live-control-skill'
/**
 * Carried in the skill's DESCRIPTION. Nothing else on the machine contains it,
 * so an answer that echoes it read the file panda wrote rather than inferring a
 * name from a directory.
 */
const MARKER = 'planted-by-pandas-live-discovery-check'

const SKILL_BODY = `---\nname: ${PLANTED}\ndescription: ${MARKER}, and it does nothing.\n---\n\nDo nothing.\n`

let sandbox: string
let realRootsBefore: string
const measured: string[] = []
const notMeasured: string[] = []

beforeAll(async () => {
  realRootsBefore = await snapshotRealSkillsRoots()
  sandbox = await mkdtemp(join(tmpdir(), 'panda-skills-live-'))
})

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  expect(await snapshotRealSkillsRoots()).toBe(realRootsBefore)
})

interface Ran {
  readonly spawned: boolean
  readonly output: string
  readonly code: number | null
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<Ran> {
  return new Promise((settle) => {
    const line = [command, ...args].join(' ')
    const child = spawn(line, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    let output = ''
    const stop = (): void => {
      // `shell` means the direct child is the shell, so kill the whole tree.
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill()
      }
    }
    const timer = setTimeout(stop, timeoutMs)
    const collect = (chunk: Buffer): void => {
      output += chunk.toString()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => {
      clearTimeout(timer)
      settle({ spawned: false, output, code: null })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      settle({ spawned: true, output, code })
    })
  })
}

/**
 * The EXIT STATUS, never `spawned`. With `shell: true` the direct child is the
 * shell, which starts perfectly on a machine with no such binary, prints
 * `not found` and exits 127 — so `spawned` answers "did a shell start". A
 * present-but-broken binary also exits non-zero and skips, which is right: a
 * live check proves nothing against a binary that cannot answer.
 */
async function available(command: string): Promise<boolean> {
  if (process.env['PANDA_LIVE_SKILLS'] === '0') return false
  const probe = await run(command, ['--version'], process.env, tmpdir(), PROBE_TIMEOUT_MS)
  return probe.spawned && probe.code === 0
}

/** An injected home with nothing of the developer's own reachable from it. */
function envFor(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    // `HOME`/`USERPROFILE` do not move codex on Windows; this does, and it is
    // the knob the previous version of this file DELETED, which is how the codex
    // case came to measure its cwd instead of its home.
    CODEX_HOME: join(homeDir, '.codex'),
    // Measured: opencode honours the injected home for its own config root and
    // ignores it for the external scans of `~/.claude/skills` and
    // `~/.agents/skills` — under a fresh injected home it still listed 38 of the
    // developer's own skills. Reads are harmless (the root snapshot proves
    // nothing changed), but they would let an assertion pass on someone else's
    // file, so opencode's own documented switch leaves the injected root as the
    // only source.
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
  }
  // A developer's own override would send the executor back at their real
  // directories, which is exactly what this suite may not touch.
  delete env['CLAUDE_CONFIG_DIR']
  return env
}

interface Planted {
  readonly homeDir: string
  readonly root: string
  /** Deliberately NOT the home: see the header. Holds no configuration at all. */
  readonly cwd: string
}

/**
 * Materialises the planted skill THROUGH the projection engine, at the trait
 * record's own root under an injected home. Nothing here writes a SKILL.md by
 * hand: if panda's own materialisation is wrong, the executor never sees it.
 */
async function plant(traits: SkillsTargetTraits, label: string): Promise<Planted> {
  const homeDir = join(sandbox, label)
  const cwd = join(sandbox, `${label}-cwd`)
  const sources = join(homeDir, 'sources')
  await mkdir(sources, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const entryPath = join(sources, 'planted.md')
  await writeFile(entryPath, SKILL_BODY, 'utf8')
  // The trait record's OWN default root, rebased onto the injected home — so
  // what is measured is the location panda ships, not one the test chose.
  // `skills.test.ts` asserts that this is also the string production writes at.
  const root = rebaseHome(traits.defaultRoot, homeDir)
  const entry: RegistryEntry = { type: 'skill', id: PLANTED, entryPath }
  const outcome = await runProjection({
    entries: groupByKind([entry]),
    targets: [createSkillsTargetFromTraits(traits, { rootPath: root })],
    ledger: new ProjectionLedger({ homeDir }),
  })
  expect(outcome.failures, 'panda could not materialise the planted skill').toEqual([])
  expect(outcome.results[0]?.written).toBe(true)
  return { homeDir, root, cwd }
}

/** `<real home>/x/y` -> `<injected home>/x/y`, whatever the platform spells home as. */
function rebaseHome(path: string, homeDir: string): string {
  const real = homedir()
  if (real !== '' && path.toLowerCase().startsWith(real.toLowerCase())) {
    return join(homeDir, path.slice(real.length))
  }
  throw new Error(`cannot rebase '${path}' onto an injected home`)
}

// --- claude-code ------------------------------------------------------------

/** Every string anywhere in the request claude sent. */
function textsOf(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') found.push(node)
  else if (Array.isArray(node)) for (const item of node) textsOf(item, found)
  else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) textsOf(value, found)
  }
  return found
}

const SKILLS_HEADER = 'The following skills are available for use with the Skill tool:'

/**
 * The `- <name>: <description>` lines of claude's own skills block.
 *
 * Parsed rather than substring-matched, and this is not fussiness: an earlier
 * version asserted the planted id appeared ANYWHERE in the body, and that stayed
 * green against a SKILL.md with its frontmatter deleted, because claude falls
 * back to the directory name. Codex and opencode both went red on the same
 * corruption. Membership of this list, description included, is the equivalent.
 */
function claudeSkillLines(body: string): string[] {
  const block = textsOf(JSON.parse(body)).find((text) => text.includes(SKILLS_HEADER))
  if (block === undefined) return []
  const lines: string[] = []
  for (const line of block.slice(block.indexOf(SKILLS_HEADER) + SKILLS_HEADER.length).split('\n')) {
    if (line.startsWith('- ')) lines.push(line.slice(2))
    else if (line.trim() !== '' && lines.length > 0) break
  }
  return lines
}

const claudeAvailable = await available('claude')

describe.skipIf(!claudeAvailable)('claude-code discovers a skill panda materialised', () => {
  it(
    'lists it in its own skills block, description included, and lists no skill panda never wrote',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const { homeDir, root, cwd } = await plant(CLAUDE_SKILLS_TRAITS, 'claude')
      let captured = ''
      const server: Server = createServer((request, response) => {
        let body = ''
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        request.on('end', () => {
          if (request.url?.includes('/messages') === true) captured = body
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            request.url?.includes('/messages') === true
              ? JSON.stringify({
                  id: 'msg_live',
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-haiku-4-5',
                  content: [{ type: 'text', text: 'ok' }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 1, output_tokens: 1 },
                })
              : '{}',
          )
        })
      })
      await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
      const port = (server.address() as { port: number }).port
      try {
        const env = {
          ...envFor(homeDir),
          ANTHROPIC_API_KEY: 'panda-live-stub',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        }
        const answered = await run('claude', ['-p', '--model', 'haiku', '"hello"'], env, cwd, RUN_TIMEOUT_MS)
        expect(
          captured,
          `claude sent no request this check could read; it said: ${answered.output.slice(0, 400)}`,
        ).not.toBe('')
        const listed = claudeSkillLines(captured)
        expect(listed.length, 'claude sent no skills block at all').toBeGreaterThan(0)
        // Name AND description: the description exists only in the file panda
        // copied, so this cannot be satisfied by a directory name.
        expect(listed.some((line) => line.startsWith(`${PLANTED}:`) && line.includes(MARKER))).toBe(true)
        expect(listed.some((line) => line.startsWith(`${CONTROL}:`))).toBe(false)
        measured.push(`claude-code (${root})`)
      } finally {
        server.close()
      }
    },
  )
})

if (!claudeAvailable) notMeasured.push('claude-code (binary absent or could not answer --version)')

// --- codex ------------------------------------------------------------------

const codexAvailable = await available('codex')

describe.skipIf(!codexAvailable)('codex discovers a skill panda materialised', () => {
  it(
    'names its SKILL.md in the model-visible prompt, and not one panda never wrote',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const { homeDir, root, cwd } = await plant(CODEX_SKILLS_TRAITS, 'codex')
      const answered = await run('codex', ['debug', 'prompt-input'], envFor(homeDir), cwd, RUN_TIMEOUT_MS)
      expect(answered.code, `codex debug prompt-input failed: ${answered.output.slice(0, 400)}`).toBe(0)
      // THROUGH CODEX'S OWN ROOTS TABLE, and the rewrite is the finding.
      //
      // This clause used to match an absolute path as a substring. Codex now
      // prints a roots table plus short references instead:
      //
      //     ### Skill roots
      //     - `r0` = `C:/.../.codex/skills`
      //     - panda-live-planted-skill: ... (file: r0/panda-live-planted-skill/SKILL.md)
      //
      // so the substring stopped being present while DISCOVERY STILL WORKED --
      // measured by driving codex directly: exit 0, the planted skill listed
      // under its own root. A vendor changed its output format; panda's
      // materialisation did not break. The red was read as environmental for
      // several sessions ("local-only Windows"), and it is neither.
      //
      // Resolving the alias against panda's own root is STRICTLY stronger than
      // the substring it replaces: it proves codex resolved the reference to
      // the directory PANDA WROTE rather than to one of the other roots it also
      // scans, which is the property the old comment claimed and a substring
      // could not establish.
      const forward = (value: string) => value.replaceAll('\\', '/')
      const output = forward(answered.output)
      const alias = [...output.matchAll(/`(r\d+)` = `([^`]+)`/g)].find(
        (match) => forward(match[2] ?? '') === forward(root),
      )?.[1]
      expect(alias, `codex listed no skill root equal to ${forward(root)}`).toBeDefined()
      expect(output).toContain(`${alias}/${PLANTED}/SKILL.md`)
      // And the description, so a SKILL.md whose frontmatter is gone goes red.
      expect(answered.output).toContain(MARKER)
      expect(answered.output).not.toContain(CONTROL)
      measured.push(`codex (${root})`)
    },
  )
})

if (!codexAvailable) notMeasured.push('codex (binary absent or could not answer --version)')

// --- opencode ---------------------------------------------------------------

const opencodeAvailable = await available('opencode')

describe.skipIf(!opencodeAvailable)('opencode discovers a skill panda materialised', () => {
  it(
    'lists it with the exact location panda wrote, and lists no skill panda never wrote',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const { homeDir, root, cwd } = await plant(OPENCODE_SKILLS_TRAITS, 'opencode')
      const answered = await run('opencode', ['debug', 'skill'], envFor(homeDir), cwd, RUN_TIMEOUT_MS)
      const start = answered.output.indexOf('[')
      expect(
        start,
        `opencode debug skill printed no listing: ${answered.output.slice(0, 400)}`,
      ).toBeGreaterThanOrEqual(0)
      const listed = JSON.parse(answered.output.slice(start)) as {
        name: string
        description: string
        location: string
      }[]
      const found = listed.find((item) => item.name === PLANTED)
      expect(found, `opencode listed ${listed.length} skills and not the planted one`).toBeDefined()
      expect(found?.location).toBe(join(root, PLANTED, 'SKILL.md'))
      expect(found?.description).toContain(MARKER)
      expect(listed.some((item) => item.name === CONTROL)).toBe(false)
      measured.push(`opencode (${root})`)
    },
  )
})

if (!opencodeAvailable) notMeasured.push('opencode (binary absent or could not answer --version)')

describe('what this run actually measured', () => {
  it('says so, so a green suite that measured nothing cannot pass for a verified one', () => {
    // THREE states, not two, and AD-5 is the reason: unavailable is not failed.
    // A binary that was present and whose clause went RED used to land in
    // NEITHER bucket, so one real failure produced TWO red clauses and the
    // second one said "the remaining cases did not report a reason" -- which
    // reads as a hole in the accounting when the truth was "codex failed".
    // Derived rather than pushed, because a clause that throws never reaches a
    // line after the throw.
    const failed = (
      [
        ['claude-code', claudeAvailable],
        ['codex', codexAvailable],
        ['opencode', opencodeAvailable],
      ] as const
    )
      .filter(([name, available]) => available && !measured.some((entry) => entry.startsWith(name)))
      .map(([name]) => `${name} (present, but its clause failed -- read that failure, not this line)`)

    const line =
      measured.length === 3
        ? `[M4.B skills] measured all 3 executors: ${measured.join(', ')}`
        : `[M4.B skills] measured ${measured.length} of 3 executors -- ${[...notMeasured, ...failed].join('; ') || 'the remaining cases did not report a reason'}`
    // `process.stdout.write`, not `console.log`: vitest's DEFAULT reporter — the
    // one `pnpm test` and therefore CI runs — swallows console output from a
    // passing test, so the honest line was invisible exactly where it matters,
    // on a runner that has none of the three binaries.
    process.stdout.write(`${line}\n`)
    // TOTAL over the three, including the failed state. Without `failed` this
    // reddened alongside every real failure and hid its own meaning.
    expect(measured.length + notMeasured.length + failed.length).toBe(3)
  })
})
