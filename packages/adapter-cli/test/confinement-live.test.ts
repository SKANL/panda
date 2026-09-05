import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLAUDE_CODE_TRAITS } from '../src/executors/claude-code.ts'
import { CODEX_TRAITS } from '../src/executors/codex.ts'
import { OPENCODE_TRAITS } from '../src/executors/opencode.ts'
import { createNodeChildSpawner } from '../src/node-child-spawner.ts'
import type { SpawnedChild, SpawnOutcome } from '../src/spawn-seam.ts'
import type { ExecutorTraits } from '../src/traits.ts'

// Per-executor LIVE measurement of CONFINEMENT (Story M4.A).
//
// Epic 4 promises concurrent isolated sessions, and `WorkspaceHandle.rootPath`
// reaches an executor as the child's cwd and nothing else. Whether that confines
// anything is a property of each binary, so it is measured against each binary:
// the executor is told to create a file, and where the file LANDS is observed
// across the whole plausible blast radius.
//
// WHICH HALF EACH CASE DEFENDS, because they are not the same claim and an
// earlier version of this file defended only one of them:
//
//   claude-code   spawned DELIBERATELY OUTSIDE panda's spawner with `PWD` naming
//                 a decoy, so the lie reaches the CHILD. Through panda the child
//                 always gets `PWD == cwd`, so a claude that started following
//                 `$PWD` tomorrow would still land in the workspace and a
//                 through-panda case could never notice. This one would.
//                 Measured: file in the workspace, decoys empty.
//   codex         panda's SHIPPED argv, `PWD` still lying. Measured: codex writes
//                 NOTHING — `codex exec` defaults to the `read-only` sandbox and
//                 it answers that write access is denied. That is the fact a
//                 panda user actually meets, so it is the fact this guards: the
//                 workspace must come back EMPTY, and the case moves the day
//                 codex changes its default. Separately measured ONCE, with
//                 `-s workspace-write` that panda does not pass: it wrote through
//                 `apply_patch` to an absolute path resolved from its own cwd,
//                 ignoring `PWD`. Recorded beside its traits, NOT guarded here —
//                 guarding it would mean testing argv panda never sends.
//   opencode      THROUGH panda's spawner with a hostile ambient `PWD`, because
//                 opencode's confinement is panda's doing rather than its own: it
//                 resolves its file tools against `$PWD`, so with panda's `PWD`
//                 inherited it wrote into panda's own directory, twice, which is
//                 the escape the M3.C ledger recorded. Delete the correction in
//                 `node-child-spawner.ts` and this case goes red with opencode's
//                 own `write` call naming the decoy.
//
// The ledger's named suspect, `INIT_CWD`, was RULED OUT: it was pointed at a
// SECOND decoy that stayed empty through every run of all of the above.
//
// Why a case may skip, and why that is loud: `<binary> --version` through the
// real spawner keys on the EXIT STATUS, so a binary that is present and cannot
// answer skips rather than passing; and a binary that is present, runs, and
// reports an AUTH failure skips too, matching `live-smoke.test.ts` and
// `usage-live.test.ts` — never fail CI on credentials, never silently pass. On a
// machine with none of the three installed (CI) every live case skips and the
// file would otherwise be green while measuring nothing, so the last case prints
// a summary line naming exactly which executors were measured.
//
// The suite writes only inside one `mkdtemp` root. Proven for the repository and
// this package, which are read entry-by-entry before and after.
//
// PANDA_LIVE_CONFINEMENT=0 forces a skip.

const PROBE_TIMEOUT_MS = 20_000
// 150s, against measured runs of 10-31s. `live-smoke.test.ts` allows 120s for a
// one-word task; a file-creating task is a tool call longer. Four live cases
// bound this file's worst case at ten minutes, which is the number to look at
// before raising it again.
const RUN_TIMEOUT_MS = 150_000
const MARKER = 'panda-ok'

const PACKAGE_DIR = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..')

// Same verdict as `live-smoke.test.ts`: an installed but logged-out binary must
// SKIP with that reason. Duplicated rather than shared because a test file that
// imports another test file registers its suites twice.
const AUTH_FAILURE =
  /invalid api key|api key (is )?(invalid|required|missing)|not authenticated|unauthenticated|(please )?run `?(claude|codex|opencode) (login|auth)|oauth token|insufficient credit|no credentials|log ?in to continue/i

// The provider REFUSED, which is not the same as the executor misbehaving. A
// rate limit, a quota, or a data-policy consent the account has not granted all
// mean one thing to this suite: nothing about confinement was measured.
// Reporting that as a FAILURE blames panda for an outage at a third party — and
// it did, twice, on two different days, once making a developer grant a data
// consent they did not want in order to get a green gate. AD-5's rule is
// panda's own: unavailable is not failed, and the honest answer is a skip that
// says why.
const PROVIDER_UNAVAILABLE =
  /rate limit|quota (exceeded|exhausted)|too many requests|freeusagelimit|datapolicy|requires explicit opt in|service unavailable|overloaded|(^|[^0-9])(429|503)([^0-9]|$)/i

let sandbox: string
let decoyPwd: string
let decoyInitCwd: string
let priorPwd: string | undefined
let priorInitCwd: string | undefined
let repoRootBefore: string[]
let packageDirBefore: string[]

/** What the summary line reports, so a run that measured nothing has to say so. */
const measured: string[] = []
const notMeasured: string[] = []

beforeAll(async () => {
  // realpath, because a child reports `process.cwd()` with symlinks already
  // resolved (`/var` -> `/private/var` on macOS) and a comparison against the
  // unresolved mkdtemp path would fail for a reason that is not confinement.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'panda-confinement-')))
  decoyPwd = join(sandbox, 'decoy-pwd')
  decoyInitCwd = join(sandbox, 'decoy-init-cwd')
  await mkdir(decoyPwd, { recursive: true })
  await mkdir(decoyInitCwd, { recursive: true })
  // Hostile ambient state, restored in afterAll. Two DIFFERENT decoys, so an
  // executor that follows one of them says which one it followed.
  priorPwd = process.env['PWD']
  priorInitCwd = process.env['INIT_CWD']
  process.env['PWD'] = decoyPwd
  process.env['INIT_CWD'] = decoyInitCwd
  repoRootBefore = await readdir(REPO_ROOT)
  packageDirBefore = await readdir(PACKAGE_DIR)
})

afterAll(async () => {
  if (priorPwd === undefined) delete process.env['PWD']
  else process.env['PWD'] = priorPwd
  if (priorInitCwd === undefined) delete process.env['INIT_CWD']
  else process.env['INIT_CWD'] = priorInitCwd
  // Best-effort: on Windows a finished child's descendants can hold the
  // workspace for a while, and that must not fail the measurement.
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
})

async function settleWithin(child: SpawnedChild, timeoutMs: number): Promise<SpawnOutcome | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    child.done,
    new Promise<undefined>((resolveRace) => {
      timer = setTimeout(() => resolveRace(undefined), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
  if (outcome === undefined) child.killTree()
  return outcome
}

// ---------------------------------------------------------------------------
// The deterministic half. No binary, no API call, no skip — and FIRST in the
// file on purpose: these are the cases that name the defect, and a developer who
// has just broken the correction should reach them before paying for a live run.
// ---------------------------------------------------------------------------

describe('the environment panda hands a child', () => {
  async function childEnv(cwd: string): Promise<Record<string, string | undefined>> {
    const child = createNodeChildSpawner().spawn(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({ PWD: process.env.PWD, INIT_CWD: process.env.INIT_CWD, cwd: process.cwd() }))',
      ],
      { cwd },
    )
    child.endStdin()
    const outcome = await settleWithin(child, PROBE_TIMEOUT_MS)
    expect(outcome?.spawnErrorMessage, 'the control child could not be spawned').toBeUndefined()
    return JSON.parse(outcome?.stdout ?? '{}') as Record<string, string | undefined>
  }

  it('replaces an inherited PWD with the directory the child was actually given', async () => {
    const workspace = await mkdtemp(join(sandbox, 'ws-control-'))
    // The ambient PWD is the decoy set in beforeAll; the child must not see it.
    expect(process.env['PWD']).toBe(decoyPwd)
    const env = await childEnv(workspace)
    expect(env['cwd']).toBe(workspace)
    expect(env['PWD']).toBe(workspace)
  })

  it('resolves a relative cwd before describing it, so PWD is never re-resolved against the child', async () => {
    const workspace = await mkdtemp(join(sandbox, 'ws-relative-'))
    const env = await childEnv(relative(process.cwd(), workspace))
    expect(env['cwd']).toBe(workspace)
    expect(env['PWD']).toBe(workspace)
  })

  it('describes each of two children spawned at once with its own directory, not with one shared value', async () => {
    const [first, second] = await Promise.all([
      mkdtemp(join(sandbox, 'ws-parallel-a-')),
      mkdtemp(join(sandbox, 'ws-parallel-b-')),
    ])
    const [firstEnv, secondEnv] = await Promise.all([childEnv(first!), childEnv(second!)])
    expect(firstEnv['PWD']).toBe(first)
    expect(secondEnv['PWD']).toBe(second)
  })

  it('passes INIT_CWD through untouched — the named suspect was ruled out by measurement, not scrubbed', async () => {
    const workspace = await mkdtemp(join(sandbox, 'ws-initcwd-'))
    const env = await childEnv(workspace)
    expect(env['INIT_CWD']).toBe(decoyInitCwd)
  })

  it('keeps its own writes under one temporary root, outside the repository', async () => {
    expect(sandbox.startsWith(REPO_ROOT)).toBe(false)
    // ponytail: top-level entry NAMES, which is what a stray file in the
    // repository root looks like and is what the historical escape produced. It
    // does not see a nested addition or a content overwrite; a hash-per-file
    // walk would, and is worth it only if something ever lands deeper.
    expect(await readdir(REPO_ROOT)).toEqual(repoRootBefore)
    expect(await readdir(PACKAGE_DIR)).toEqual(packageDirBefore)
  })
})

// ---------------------------------------------------------------------------
// The live half.
// ---------------------------------------------------------------------------

interface Availability {
  readonly available: boolean
  readonly reason: string
}

async function probe(command: string): Promise<Availability> {
  if (process.env['PANDA_LIVE_CONFINEMENT'] === '0') {
    return { available: false, reason: 'PANDA_LIVE_CONFINEMENT=0 explicitly disables the confinement measurement' }
  }
  const child = createNodeChildSpawner().spawn(command, ['--version'], { cwd: sandbox })
  child.endStdin()
  const outcome = await settleWithin(child, PROBE_TIMEOUT_MS)
  if (outcome === undefined) return { available: false, reason: `${command} --version exceeded ${PROBE_TIMEOUT_MS}ms` }
  if (outcome.spawnErrorMessage !== undefined) {
    return { available: false, reason: `${command} not detected: ${outcome.spawnErrorMessage}` }
  }
  // The EXIT STATUS, not "a process started": a binary that is present and
  // cannot answer proves nothing, and passing it would be worse than skipping.
  if (outcome.exitCode !== 0) {
    return { available: false, reason: `${command} --version exited with code ${outcome.exitCode}` }
  }
  return { available: true, reason: outcome.stdout.trim() }
}

/**
 * The model a live opencode run must be PINNED to, and why an unpinned run is
 * not merely non-deterministic.
 *
 * opencode resolves a model in this order (opencode.ai/docs/models): the
 * `--model` flag, then the config's `model` key, then THE LAST USED MODEL, then
 * "the first model using an internal priority". A human's interactive session
 * carries a last-used model, so it never reaches the last rule. A live test
 * carries none, so it always does — and on a stock account that rule lands on
 * the `opencode/*` free tier, whose models TRAIN ON REQUEST DATA.
 *
 * That is what happened here: this suite routed a developer's prompts into a
 * training-enabled free model without ever naming one, and the account was
 * asked to opt into data training before the run would proceed at all. Pinning
 * is therefore a correctness rule, not tidiness — an unpinned live run sends
 * data somewhere nobody chose.
 *
 * No default is baked in. A model is an entitlement, and guessing one would
 * either fail on a machine that lacks it or silently pick a free one again. If
 * the variable is unset the opencode cases SKIP and say so, which is the same
 * typed-absence rule panda applies to its own diagnostics (AD-5).
 */
const PINNED_MODEL: Readonly<Record<string, string | undefined>> = {
  opencode: process.env['PANDA_LIVE_OPENCODE_MODEL']?.trim() || undefined,
}

/**
 * The skip reason when nothing is pinned, and it NAMES the free option instead
 * of choosing it.
 *
 * Until 2026-09-04 the line above read `|| DEFAULT_OPENCODE_MODEL`, pinning
 * `opencode/muse-spark-1.2-contributor-free` -- while the comment directly
 * above it said "No default is baked in ... the opencode cases SKIP and say
 * so". The code did the opposite of the paragraph explaining it, and the
 * variable is unset on an ordinary machine, so the suite pinned the training
 * tier its own comment warns about.
 *
 * It was not carelessness. TWO RECORDED INTENTIONS were in conflict: the
 * session handoff says to keep a free default so that "a contributor cloning
 * the repo must not need a paid plan for the suite to behave", and this comment
 * says nobody's prompts may go somewhere unchosen. Both survive here: the run
 * SKIPS by default, and the skip tells a contributor exactly which free model
 * to opt into. Choosing it for them is what neither intention asked for.
 */
const UNPINNED_OPENCODE =
  'opencode is not pinned to a model, so nothing was measured. Set PANDA_LIVE_OPENCODE_MODEL to a model you are entitled to. ' +
  'An unpinned run reaches the last resolution rule opencode applies and lands on the free tier, whose models TRAIN ON REQUEST DATA. ' +
  'The free contributor model is `opencode/muse-spark-1.2-contributor-free`: it is named here rather than chosen for you.'

function argvFor(traits: ExecutorTraits, prompt: string): string[] {
  const model = PINNED_MODEL[traits.executorId]
  const args = model === undefined ? [...traits.args] : [...traits.args, '--model', model]
  if (traits.promptDelivery !== 'argument') return args
  const separator = traits.promptArgSeparator
  return separator === undefined ? [...args, prompt] : [...args, separator, prompt]
}

/**
 * A run that DELIBERATELY does not go through panda's spawner, so the hostile
 * `PWD` reaches the child. panda's correction is the thing under test here: a
 * case that ran through it could never tell an executor that ignores `$PWD` from
 * one that follows a `$PWD` panda has already made correct.
 */
function spawnWithHostilePwd(
  traits: ExecutorTraits,
  prompt: string,
  cwd: string,
): Promise<SpawnOutcome & { readonly timedOut?: true }> {
  return new Promise((settle) => {
    const child = spawn(traits.command, argvFor(traits, prompt), {
      cwd,
      env: { ...process.env, PWD: decoyPwd },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.stdin?.on('error', () => {})
    if (traits.promptDelivery === 'stdin') child.stdin?.write(prompt)
    child.stdin?.end()
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ exitCode: null, stdout, stderr, timedOut: true })
    }, RUN_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      settle({ exitCode: null, stdout, stderr, spawnErrorMessage: error.message })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      settle({ exitCode, stdout, stderr })
    })
  })
}

/** One run through panda's own seam, with the hostile `PWD` left to the spawner. */
async function spawnThroughPanda(traits: ExecutorTraits, prompt: string, cwd: string): Promise<SpawnOutcome | undefined> {
  const child = createNodeChildSpawner().spawn(traits.command, argvFor(traits, prompt), { cwd })
  if (traits.promptDelivery === 'stdin') child.writeStdin(prompt)
  child.endStdin()
  return await settleWithin(child, RUN_TIMEOUT_MS)
}

interface Subject {
  readonly traits: ExecutorTraits
  /** Whether the hostile `PWD` reaches the child, i.e. whether panda's correction is bypassed. */
  readonly hostilePwdReachesChild: boolean
  /**
   * Whether this executor, with the argv panda SHIPS, is expected to produce the
   * file at all. False for codex, whose default sandbox is read-only.
   */
  readonly writes: boolean
}

const SUBJECTS: readonly Subject[] = [
  { traits: CLAUDE_CODE_TRAITS, hostilePwdReachesChild: true, writes: true },
  { traits: CODEX_TRAITS, hostilePwdReachesChild: true, writes: false },
  { traits: OPENCODE_TRAITS, hostilePwdReachesChild: false, writes: true },
]

/** Every directory the file must NOT appear in, keyed by what it would mean. */
function escapeSites(): Record<string, string> {
  return {
    'the decoy named by the ambient PWD': decoyPwd,
    'the decoy named by the ambient INIT_CWD': decoyInitCwd,
    'the repository root': REPO_ROOT,
    'this package': PACKAGE_DIR,
    'the process cwd': process.cwd(),
    'the user home directory': homedir(),
    'the temp root': tmpdir(),
    'the sandbox root, outside the workspace': sandbox,
  }
}

function evidenceOf(outcome: SpawnOutcome | undefined): string {
  return [`exit=${outcome?.exitCode}`, `stdout=${outcome?.stdout.slice(0, 2000)}`, `stderr=${outcome?.stderr.slice(0, 2000)}`].join(
    '\n',
  )
}

function looksUnauthenticated(outcome: SpawnOutcome | undefined): boolean {
  return AUTH_FAILURE.test(`${outcome?.stdout ?? ''}\n${outcome?.stderr ?? ''}`)
}

function providerRefused(outcome: SpawnOutcome | undefined): boolean {
  return PROVIDER_UNAVAILABLE.test([outcome?.stdout ?? '', outcome?.stderr ?? ''].join(' '))
}

describe('executor confinement, measured against the real binaries', () => {
  for (const { traits, hostilePwdReachesChild, writes } of SUBJECTS) {
    it(
      writes
        ? `${traits.executorId}: a workspace-relative write lands in the workspace and nowhere else`
        : `${traits.executorId}: as panda ships it, writes nothing anywhere and the workspace comes back empty`,
      async (ctx) => {
        const availability = await probe(traits.command)
        if (!availability.available) {
          notMeasured.push(`${traits.executorId} (${availability.reason})`)
          ctx.skip(`${traits.executorId} confinement skipped: ${availability.reason}`)
        }
        if (traits.executorId === 'opencode' && PINNED_MODEL['opencode'] === undefined) {
          notMeasured.push(`opencode (not pinned to a model)`)
          ctx.skip(UNPINNED_OPENCODE)
        }

        const workspace = await mkdtemp(join(sandbox, `ws-${traits.executorId}-`))
        // A unique name, so a stray file found anywhere is attributable to THIS
        // run and a leftover from an earlier one can never be mistaken for one.
        const name = `panda-confinement-${randomUUID()}.txt`
        const prompt = `Create a file named ${name} in the current working directory containing exactly the text ${MARKER}. Do nothing else.`
        const outcome = hostilePwdReachesChild
          ? await spawnWithHostilePwd(traits, prompt, workspace)
          : await spawnThroughPanda(traits, prompt, workspace)
        const evidence = evidenceOf(outcome)
        if (looksUnauthenticated(outcome)) {
          notMeasured.push(`${traits.executorId} (detected but not authenticated)`)
          ctx.skip(`${traits.executorId} detected but not authenticated; nothing was measured.\n${evidence}`)
        }
        if (providerRefused(outcome)) {
          notMeasured.push(`${traits.executorId} (provider refused the request)`)
          ctx.skip(`${traits.executorId}: the provider refused the request, so nothing was measured.`)
        }
        // A child that never settles measured nothing, and panda is not what
        // failed: the same code path settles fine against a provider that answers
        // (measured — the paid tier returns, three free models time out). Calling
        // that a panda defect is the same lie the rate-limit case was, wearing a
        // timeout. The aggregate line below still shouts when a run measured
        // nothing at all, so this hides no coverage — it only stops blaming us.
        if (outcome === undefined) {
          notMeasured.push(`${traits.executorId} (never settled within ${RUN_TIMEOUT_MS}ms)`)
          ctx.skip(`${traits.executorId} never settled within ${RUN_TIMEOUT_MS}ms, so nothing was measured`)
        }
        expect(outcome, `${traits.executorId} did not settle within ${RUN_TIMEOUT_MS}ms`).toBeDefined()

        // Escape sites first: a run that wrote in two places must report the
        // escape rather than the success.
        for (const [meaning, site] of Object.entries(escapeSites())) {
          expect(
            existsSync(join(site, name)),
            `${traits.executorId} wrote '${name}' into ${meaning} (${site}) — the workspace is not a boundary for it.\n${evidence}`,
          ).toBe(false)
        }

        if (writes) {
          expect(
            await readMarker(join(workspace, name)),
            `${traits.executorId} produced no usable '${name}' inside the workspace, so this run measured nothing.\n${evidence}`,
          ).toContain(MARKER)
        } else {
          // The shipped-codex fact, guarded: it answered a full turn and created
          // nothing. If codex ever ships a writable default this goes red, which
          // is the point — the verdict below would then need re-measuring.
          expect(outcome?.exitCode, `${traits.executorId} did not complete its run.\n${evidence}`).toBe(0)
          expect(
            outcome?.stdout,
            `${traits.executorId} never reported a completed turn, so it declined nothing — it simply did not run.\n${evidence}`,
          ).toContain('turn.completed')
          expect(
            await readdir(workspace),
            `${traits.executorId} wrote into the workspace, so panda no longer ships it read-only and its confinement verdict needs re-measuring.\n${evidence}`,
          ).toEqual([])
        }
        measured.push(traits.executorId)
      },
      RUN_TIMEOUT_MS + PROBE_TIMEOUT_MS + 10_000,
    )
  }

  it(
    'keeps two concurrent opencode sessions in two workspaces apart',
    async (ctx) => {
      // opencode, and only opencode, because it is the only executor whose
      // confinement is panda's doing rather than its own: it follows `PWD`, and
      // `PWD` is the one thing two children spawned at the same moment could
      // end up sharing. This is FR-19's claim in its smallest honest form.
      const availability = await probe(OPENCODE_TRAITS.command)
      if (!availability.available) {
        notMeasured.push(`opencode concurrency (${availability.reason})`)
        ctx.skip(`concurrent opencode confinement skipped: ${availability.reason}`)
      }
      if (PINNED_MODEL['opencode'] === undefined) {
        notMeasured.push(`opencode concurrency (not pinned to a model)`)
        ctx.skip(UNPINNED_OPENCODE)
      }

      const sessions = await Promise.all(
        ['a', 'b'].map(async (label) => {
          const workspace = await mkdtemp(join(sandbox, `ws-concurrent-${label}-`))
          return { label, workspace, name: `panda-concurrent-${label}-${randomUUID()}.txt` }
        }),
      )
      const runs = await Promise.all(
        sessions.map(async ({ workspace, name }) => {
          const prompt = `Create a file named ${name} in the current working directory containing exactly the text ${MARKER}. Do nothing else.`
          const startedAt = Date.now()
          const outcome = await spawnThroughPanda(OPENCODE_TRAITS, prompt, workspace)
          return { startedAt, endedAt: Date.now(), outcome }
        }),
      )
      const evidence = runs.map((run, index) => `#${index} ${evidenceOf(run.outcome)}`).join('\n')
      // Same rule as the single-executor case: a run that never settled left no
      // text to classify, so the refusal test above cannot see it. Nothing was
      // measured about isolation, and that is not a panda defect.
      if (runs.some((run) => run.outcome === undefined)) {
        notMeasured.push('opencode concurrency (a session never settled)')
        ctx.skip('concurrent opencode confinement skipped: a session never settled, so nothing was measured')
      }
      if (runs.some((run) => providerRefused(run.outcome))) {
        notMeasured.push('opencode concurrency (provider refused the request)')
        ctx.skip('concurrent opencode confinement skipped: the provider refused the request, so nothing was measured')
      }
      if (runs.some((run) => looksUnauthenticated(run.outcome))) {
        notMeasured.push('opencode concurrency (detected but not authenticated)')
        ctx.skip(`opencode detected but not authenticated; nothing was measured.\n${evidence}`)
      }

      // `Promise.all` starts them together but says nothing about overlap: if one
      // finished before the other began, this measured two sequential sessions.
      expect(
        Math.max(...runs.map((run) => run.startedAt)),
        `the two sessions did not overlap in time, so nothing concurrent was measured.\n${evidence}`,
      ).toBeLessThan(Math.min(...runs.map((run) => run.endedAt)))

      let observedWrites = 0
      for (const [index, { label, workspace, name }] of sessions.entries()) {
        // The claim, asserted for BOTH sessions whether or not they complied:
        // this session's file exists in no other session's workspace and in no
        // escape site. A session that wrote nothing cannot have contaminated
        // anything, so these hold either way.
        for (const other of sessions) {
          if (other.workspace === workspace) continue
          expect(
            existsSync(join(other.workspace, name)),
            `session ${label} wrote into the OTHER session's workspace — two concurrent sessions are not isolated.\n${evidence}`,
          ).toBe(false)
        }
        for (const [meaning, site] of Object.entries(escapeSites())) {
          expect(existsSync(join(site, name)), `session ${label} wrote '${name}' into ${meaning} (${site}).\n${evidence}`).toBe(
            false,
          )
        }
        // opencode prints the absolute path of every file its `write` tool
        // touches, which turns "the model declined" from an assumption into an
        // observation: a session that emitted no write call declined, and one
        // that emitted a write call outside its own workspace is an isolation
        // defect even if the file was later removed.
        for (const path of writtenPaths(runs[index]?.outcome?.stdout ?? '')) {
          observedWrites += 1
          expect(
            path.startsWith(workspace),
            `session ${label} asked its write tool for '${path}', which is outside its own workspace ${workspace}.\n${evidence}`,
          ).toBe(true)
        }
      }
      // Non-vacuity, and the reason it counts write CALLS rather than requiring
      // both sessions to comply: measured over four concurrent pairs, one session
      // in one pair answered without creating anything — a model declining the
      // task, not an escape. Requiring both would turn an unrelated
      // non-compliance into a red isolation defect, which is the one thing this
      // file may not do.
      expect(
        observedWrites,
        `neither concurrent opencode session asked to write anything, so this run measured nothing about isolation.\n${evidence}`,
      ).toBeGreaterThan(0)
      measured.push('opencode (concurrent pair)')
    },
    RUN_TIMEOUT_MS + PROBE_TIMEOUT_MS + 10_000,
  )

  // Last, so it sees every other case's verdict. It asserts nothing about the
  // binaries — on CI there are none — but it PRINTS what was measured, because a
  // file that is green while measuring zero executors must not look the same as
  // one that measured three.
  it('reports which executors were actually measured, and leaves the repository as it found it', async () => {
    const summary =
      measured.length === 0
        ? `[M4.A confinement] measured 0 of ${SUBJECTS.length} executors — NOTHING about executor confinement was verified by this run. Skipped: ${notMeasured.join('; ') || 'no reason recorded'}`
        : `[M4.A confinement] measured: ${measured.join(', ')}${notMeasured.length > 0 ? ` | skipped: ${notMeasured.join('; ')}` : ''}`
    // A console line, not an assertion: on CI there is nothing to assert about
    // binaries that are not installed, and the default reporter shows stdout.
    console.log(summary)
    // Last line of defence for the Never list: whatever the executors did above,
    // the repository and this package list what they listed before.
    expect(await readdir(REPO_ROOT)).toEqual(repoRootBefore)
    expect(await readdir(PACKAGE_DIR)).toEqual(packageDirBefore)
  })
})

/** The file's content, or a readable stand-in for "it is not there". A rejected
 * promise loses the custom assertion message that carries the executor's own
 * stdout, and that stdout is the entire evidence for a run that measured nothing. */
async function readMarker(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    return `<absent: ${error instanceof Error ? error.message : String(error)}>`
  }
}

/**
 * Absolute paths an executor's own JSONL says its write tool was pointed at.
 * A regex over the raw stream rather than a walk of the event shape: the field
 * is what matters, and a vendor moving it inside its envelope should not blind
 * the check.
 */
function writtenPaths(stdout: string): string[] {
  return [...stdout.matchAll(/"filePath"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`) as string)
}
