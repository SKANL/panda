import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RunRequest, WorkspaceHandle } from '@panda/contracts'
import { createCliExecutorAdapter } from '../src/traits.ts'
import type { ExecutorTraits } from '../src/traits.ts'
import { createNodeChildSpawner } from '../src/node-child-spawner.ts'
import type { SpawnOutcome } from '../src/spawn-seam.ts'
import { EXECUTOR_CATALOGUE } from '../src/catalogue.ts'
import { CLAUDE_CODE_TRAITS } from '../src/executors/claude-code.ts'
import { CODEX_TRAITS } from '../src/executors/codex.ts'
import { OPENCODE_TRAITS } from '../src/executors/opencode.ts'
import { FakeSpawner } from './fake-spawner.ts'

// Per-vendor LIVE verification of the usage figure (Story M3.C).
//
// This is the criterion phrased in the external tool's terms that correction-01
// requires: not "panda produced a number" but "the number panda charges is the
// one THIS binary printed, in THIS field". Every other assertion about usage in
// this package reasons over a fixture panda wrote down.
//
// Shape of each check, and why it cannot pass vacuously:
//   1. `<binary> --version` through the real spawner. A missing binary reports
//      `spawnErrorMessage` and a broken one a non-zero exit, and either SKIPS with
//      that reason printed. It keys on the BINARY, never on "did a shell start" —
//      the mistake that ran CI red for seven commits in the codex strict-config
//      suite next door.
//   2. one real run, captured verbatim.
//   3. an INDEPENDENT oracle computes what the run should cost. The first version
//      of this file computed opencode's expectation with `finishes.at(-1)` — the
//      implementation's own rule — and could not see that the implementation was
//      billing one step of three. An oracle that shares the rule cannot detect the
//      defect it shares, and this repository has now shipped that pattern three
//      times. So each oracle reads a DIFFERENT part of the payload, or a different
//      spelling of it, than the trait record does.
//   4. a WRONG-RULE control: the plausible mistake for this vendor must produce a
//      different number from the one panda charged.
//   5. those exact captured bytes replayed through the adapter must equal (3).
//   6. a DIFFERENTIAL control: the same bytes with the usage records removed must
//      charge nothing.
//
// A vendor that ran and answered but printed no usage field is a HARD failure
// naming the field, not a skip. PANDA_LIVE_USAGE=0 forces a skip.

const PROBE_TIMEOUT_MS = 20_000
const RUN_TIMEOUT_MS = 300_000

/**
 * A task that really takes opencode several steps — one tool call, then an
 * answer — and writes NOTHING.
 *
 * Both halves are load-bearing. A one-word task emits a single `step_finish`,
 * where summing the steps and taking the last one agree, which is exactly why a
 * per-step billing defect shipped. And the first version of this asked opencode
 * to create two files: it did, in the REPOSITORY rather than in the temp
 * workspace it was spawned in, leaving `a.txt` and `b.txt` behind in
 * `packages/adapter-cli`. A live check that dirties the checkout it is verifying
 * is a defect of its own.
 */
const MULTI_STEP_PROMPT =
  'List the files in the current directory, then tell me how many there are. Do not create or modify any file.'

const workspaces: string[] = []
afterAll(async () => {
  await Promise.all(
    workspaces.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})),
  )
})

interface Availability {
  readonly available: boolean
  readonly reason: string
}

async function settleWithin(child: ReturnType<ReturnType<typeof createNodeChildSpawner>['spawn']>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    child.done,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
  if (outcome === undefined) child.killTree()
  return outcome
}

async function probe(command: string): Promise<Availability> {
  if (process.env['PANDA_LIVE_USAGE'] === '0') {
    return { available: false, reason: 'PANDA_LIVE_USAGE=0 explicitly disables the live usage verification' }
  }
  const child = createNodeChildSpawner().spawn(command, ['--version'], { cwd: tmpdir() })
  child.endStdin()
  const outcome = await settleWithin(child, PROBE_TIMEOUT_MS)
  if (outcome === undefined) return { available: false, reason: `${command} --version exceeded ${PROBE_TIMEOUT_MS}ms` }
  if (outcome.spawnErrorMessage !== undefined) {
    return { available: false, reason: `${command} not detected: ${outcome.spawnErrorMessage}` }
  }
  // The EXIT STATUS, because "a process started" is not "the tool works": a
  // present-but-broken binary answers non-zero and skips, which is right — a live
  // check proves nothing against a binary that cannot answer.
  if (outcome.exitCode !== 0) {
    return { available: false, reason: `${command} --version exited with code ${outcome.exitCode}` }
  }
  return { available: true, reason: outcome.stdout.trim() }
}

/** One real run of `traits` on `prompt`, in a throwaway workspace. */
async function runReal(traits: ExecutorTraits, prompt: string): Promise<SpawnOutcome | undefined> {
  const rootDir = await mkdtemp(join(tmpdir(), 'panda-usage-live-'))
  workspaces.push(rootDir)
  const argv =
    traits.promptDelivery === 'argument'
      ? [...traits.args, ...(traits.promptArgSeparator === undefined ? [] : [traits.promptArgSeparator]), prompt]
      : [...traits.args]
  const child = createNodeChildSpawner().spawn(traits.command, argv, { cwd: rootDir })
  if (traits.promptDelivery === 'stdin') child.writeStdin(prompt)
  child.endStdin()
  return await settleWithin(child, RUN_TIMEOUT_MS)
}

/** What the adapter charges for those exact bytes, on the production path. */
async function chargedFor(traits: ExecutorTraits, stdout: string, prompt: string): Promise<unknown> {
  const workspace: WorkspaceHandle = { id: 'panda-usage-live', rootPath: tmpdir(), capabilities: ['read', 'write'] }
  const request: RunRequest = { prompt, workspace }
  const spawner = new FakeSpawner({ exitCode: 0, stdout, stderr: '' })
  const envelope = await createCliExecutorAdapter(traits, { spawner }).run(request)
  const data = envelope.data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['usage'] : undefined
}

function jsonlRecords(stdout: string): Record<string, unknown>[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line)
        return typeof parsed === 'object' && parsed !== null ? [parsed as Record<string, unknown>] : []
      } catch {
        return []
      }
    })
}

function numbersOf(source: Record<string, unknown> | undefined, keys: readonly string[]): number[] | undefined {
  if (source === undefined) return undefined
  const values = keys.map((key) => source[key])
  return values.every((value) => typeof value === 'number') ? (values as number[]) : undefined
}

const sum = (parts: readonly number[]): number => parts.reduce((total, part) => total + part, 0)

interface VendorCheck {
  readonly label: string
  readonly traits: ExecutorTraits
  /** The vendor's own field, named for the failure message. */
  readonly field: string
  readonly prompt: string
  /** Independent oracle: what this run cost, computed WITHOUT the trait's rule. */
  readonly expected: (stdout: string) => number | undefined
  /**
   * Plausible mistakes for this vendor. Each carries the TERM whose size is the
   * whole difference between it and the right rule, because a control is only a
   * control while that term is non-zero — codex reports
   * `reasoning_output_tokens: 0` for a one-word task, and asserting inequality
   * there fails on a run where the two rules genuinely coincide.
   */
  readonly wrongRules: readonly WrongRule[]
  /** The same bytes with every usage record removed. */
  readonly withoutUsage: (stdout: string) => string
}

interface WrongRule {
  readonly label: string
  /** What this vendor would be charged under the mistake. */
  readonly compute: (stdout: string) => number | undefined
  /** The figure the mistake adds or drops; zero means the mistake is invisible here. */
  readonly term: (stdout: string) => number | undefined
}

const VERIFIED: string[] = []

function verifyVendor(check: VendorCheck): void {
  VERIFIED.push(check.traits.executorId)
  describe(`live ${check.label} usage`, () => {
    it(
      `charges the figure ${check.label} itself printed at ${check.field}`,
      async (ctx) => {
        const availability = await probe(check.traits.command)
        if (!availability.available) {
          ctx.skip(`live ${check.label} usage check skipped: ${availability.reason}`)
          return
        }

        const outcome = await runReal(check.traits, check.prompt)
        // `ctx.skip` throws, so each `return` below is unreachable at runtime and
        // present only so the narrowing is a type-checked fact rather than a
        // belief about vitest internals.
        if (outcome === undefined) {
          ctx.skip(`${check.label} did not finish within ${RUN_TIMEOUT_MS}ms`)
          return
        }
        if (outcome.spawnErrorMessage !== undefined) {
          ctx.skip(`${check.label} could not be spawned: ${outcome.spawnErrorMessage}`)
          return
        }
        // A non-zero exit here is almost always credentials, and failing CI on a
        // machine's login state helps nobody. The reason is printed, so a skip is
        // never silent.
        if (outcome.exitCode !== 0) {
          ctx.skip(
            `${check.label} exited ${outcome.exitCode} (usually unauthenticated): ${outcome.stderr.trim().slice(0, 300)}`,
          )
          return
        }

        const expected = check.expected(outcome.stdout)
        // HARD failure, not a skip: the binary ran and answered, so a missing
        // usage field means this vendor stopped reporting it — and a trait
        // pointing at a field nobody prints must never keep shipping.
        expect(
          expected,
          `${check.label} ran but printed no '${check.field}'; the shipped trait record points at a field this binary no longer reports`,
        ).toBeTypeOf('number')
        expect(expected as number).toBeGreaterThan(0)

        // The production path, over the bytes the binary really produced.
        const charged = await chargedFor(check.traits, outcome.stdout, check.prompt)
        expect(charged).toBe(expected)

        // Wrong-rule controls. The plausible mistake must produce a DIFFERENT
        // number — unless the term that separates the two rules is genuinely zero
        // on this run, in which case the assertion flips to the EXACT equality
        // that fact implies. Neither branch can pass vacuously: one proves the
        // rules diverge, the other proves the divergence is exactly the term.
        for (const rule of check.wrongRules) {
          const wrong = rule.compute(outcome.stdout)
          const term = rule.term(outcome.stdout)
          expect(wrong, `${check.label}: the '${rule.label}' control could not be computed`).toBeTypeOf('number')
          expect(term, `${check.label}: the '${rule.label}' term could not be computed`).toBeTypeOf('number')
          if ((term as number) > 0) {
            expect(charged, `${check.label}: charging by '${rule.label}' must be distinguishable`).not.toBe(wrong)
            expect(Math.abs((charged as number) - (wrong as number))).toBe(term)
          } else {
            expect(charged, `${check.label}: with a zero term the two rules must coincide exactly`).toBe(wrong)
          }
        }

        // Differential control: strip the vendor's usage records and the same code
        // must charge nothing.
        await expect(chargedFor(check.traits, check.withoutUsage(outcome.stdout), check.prompt)).resolves.toBeUndefined()
      },
      PROBE_TIMEOUT_MS + RUN_TIMEOUT_MS + 30_000,
    )
  })
}

/**
 * The TERMINAL record of claude's stream, selected the way its SIBLINGS below
 * already select theirs (`codexUsage` takes `turn.completed`).
 *
 * This file parsed whole stdout as ONE object until 2026-09-04, and it was
 * right when it was written: claude's `--output-format json` emits exactly one
 * object, and STILL DOES -- measured against `claude 2.1.261` on the day this
 * was fixed, one line, `usage` and `modelUsage` both present. THE VENDOR NEVER
 * DRIFTED. Panda changed the argv IT sends: `3209fc7` (M15.A) moved
 * `CLAUDE_CODE_TRAITS` to `--output-format stream-json --verbose`, which is
 * JSONL, and left this oracle parsing the old shape. Thirty-two commits shipped
 * with the gate red on a developer machine, and the red was attributed first to
 * Windows and then to the vendor. Both attributions were wrong.
 *
 * `'result'` is written here as a LITERAL and deliberately not imported from
 * `CLAUDE_CODE_TRAITS.usageWhen`: the whole point of this oracle is to be
 * independent of the trait, so that a trait that drifts disagrees with it
 * instead of dragging it along.
 */
function claudeResult(stdout: string): Record<string, unknown> | undefined {
  return jsonlRecords(stdout).find((record) => record['type'] === 'result')
}

function claudeUsage(stdout: string): Record<string, unknown> | undefined {
  return claudeResult(stdout)?.['usage'] as Record<string, unknown> | undefined
}

const CLAUDE_COMPONENTS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const

verifyVendor({
  label: 'claude-code',
  traits: CLAUDE_CODE_TRAITS,
  field: `usage.{${CLAUDE_COMPONENTS.join(',')}}`,
  prompt: 'Reply with exactly the word: ok. Do nothing else.',
  // INDEPENDENT: `modelUsage` is a different part of the payload restating the
  // same four figures under camelCase spellings the trait record never mentions.
  // If the trait drifts to a different field, or claude renames one, the two
  // halves stop agreeing.
  expected: (stdout) => {
    const parsed = claudeResult(stdout) as { modelUsage?: Record<string, Record<string, unknown>> } | undefined
    const models = Object.values(parsed?.modelUsage ?? {})
    if (models.length === 0) return undefined
    const perModel = models.map((model) =>
      numbersOf(model, ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens']),
    )
    return perModel.every((parts) => parts !== undefined) ? sum(perModel.map((parts) => sum(parts as number[]))) : undefined
  },
  wrongRules: [
    {
      label: 'uncached input alone',
      compute: (stdout) => claudeUsage(stdout)?.['input_tokens'] as number | undefined,
      term: (stdout) => {
        const parts = numbersOf(claudeUsage(stdout), [
          'output_tokens',
          'cache_creation_input_tokens',
          'cache_read_input_tokens',
        ])
        return parts === undefined ? undefined : sum(parts)
      },
    },
    {
      label: 'input plus output, ignoring cache',
      compute: (stdout) => {
        const parts = numbersOf(claudeUsage(stdout), ['input_tokens', 'output_tokens'])
        return parts === undefined ? undefined : sum(parts)
      },
      term: (stdout) => {
        const parts = numbersOf(claudeUsage(stdout), ['cache_creation_input_tokens', 'cache_read_input_tokens'])
        return parts === undefined ? undefined : sum(parts)
      },
    },
  ],
  // Strips `usage` from the TERMINAL record and re-emits the stream, because
  // the stream is what panda now receives. Stripping it from a whole-document
  // parse would have thrown here rather than producing a usage-free run, which
  // is a control that cannot fail for the reason it was written.
  withoutUsage: (stdout) =>
    jsonlRecords(stdout)
      .map((record) => {
        if (record['type'] !== 'result') return JSON.stringify(record)
        const rest = { ...record }
        delete rest['usage']
        return JSON.stringify(rest)
      })
      .join('\n'),
})

function codexUsage(stdout: string): Record<string, unknown> | undefined {
  return jsonlRecords(stdout).find((record) => record['type'] === 'turn.completed')?.['usage'] as
    | Record<string, unknown>
    | undefined
}

verifyVendor({
  label: 'codex',
  traits: CODEX_TRAITS,
  field: 'turn.completed.usage.{input_tokens,output_tokens}',
  prompt: 'Reply with exactly the word: ok. Do nothing else.',
  // The honest limit, stated rather than dressed up: codex prints its usage in
  // exactly one place, so this oracle reads the same two fields the trait does.
  // What carries the weight here is the WRONG-RULE controls below — the two
  // plausible mis-readings both produce different numbers, so a trait that
  // included either would fail.
  expected: (stdout) => {
    const usage = jsonlRecords(stdout)
      .filter((record) => record['type'] === 'turn.completed')
      .map((record) => record['usage'] as Record<string, unknown> | undefined)
    const perTurn = usage.map((one) => numbersOf(one, ['input_tokens', 'output_tokens']))
    if (perTurn.length === 0 || perTurn.some((parts) => parts === undefined)) return undefined
    return sum(perTurn.map((parts) => sum(parts as number[])))
  },
  wrongRules: [
    {
      label: 'adding cached_input_tokens, which is a breakdown of the input already counted',
      compute: (stdout) => {
        const parts = numbersOf(codexUsage(stdout), ['input_tokens', 'output_tokens', 'cached_input_tokens'])
        return parts === undefined ? undefined : sum(parts)
      },
      term: (stdout) => codexUsage(stdout)?.['cached_input_tokens'] as number | undefined,
    },
    {
      label: 'adding reasoning_output_tokens, which is a share of the output',
      compute: (stdout) => {
        const parts = numbersOf(codexUsage(stdout), ['input_tokens', 'output_tokens', 'reasoning_output_tokens'])
        return parts === undefined ? undefined : sum(parts)
      },
      // Zero for a one-word task, which is exactly why the term is declared: with
      // no reasoning tokens the two rules coincide by arithmetic, and asserting
      // inequality there would fail on a truthful run.
      term: (stdout) => codexUsage(stdout)?.['reasoning_output_tokens'] as number | undefined,
    },
  ],
  withoutUsage: (stdout) =>
    jsonlRecords(stdout)
      .filter((record) => record['type'] !== 'turn.completed')
      .map((record) => JSON.stringify(record))
      .join('\n'),
})

/** Every `step_finish` opencode emitted, in order. */
function opencodeSteps(stdout: string): (Record<string, unknown> | undefined)[] {
  return jsonlRecords(stdout)
    .filter((record) => record['type'] === 'step_finish')
    .map((record) => (record['part'] as Record<string, unknown> | undefined)?.['tokens'] as Record<string, unknown>)
}

/** Everything the other steps billed, which is what a one-step rule would drop. */
function opencodeStepTotalsExcept(stdout: string, keep: number): number | undefined {
  const steps = opencodeSteps(stdout)
  const kept = keep < 0 ? steps.length + keep : keep
  const totals = steps.map((tokens) => tokens?.['total'])
  if (!totals.every((total) => typeof total === 'number')) return undefined
  return sum((totals as number[]).filter((_total, index) => index !== kept))
}

verifyVendor({
  label: 'opencode',
  traits: OPENCODE_TRAITS,
  field: 'step_finish.part.tokens.total',
  // Deliberately multi-STEP, and deliberately read-only — see MULTI_STEP_PROMPT.
  prompt: MULTI_STEP_PROMPT,
  // INDEPENDENT: recomputed from the COMPONENTS (input, output, reasoning, cache
  // write and read) rather than from the `total` the trait reads, and summed over
  // every step rather than taking one.
  expected: (stdout) => {
    const steps = opencodeSteps(stdout)
    if (steps.length === 0) return undefined
    const perStep = steps.map((tokens) => {
      const flat = numbersOf(tokens, ['input', 'output', 'reasoning'])
      const cache = numbersOf(tokens?.['cache'] as Record<string, unknown> | undefined, ['write', 'read'])
      return flat === undefined || cache === undefined ? undefined : sum(flat) + sum(cache)
    })
    return perStep.every((step) => step !== undefined) ? sum(perStep as number[]) : undefined
  },
  wrongRules: [
    {
      // The rule that actually shipped, and the reason this file was rewritten.
      label: 'the last step only',
      compute: (stdout) => opencodeSteps(stdout).at(-1)?.['total'] as number | undefined,
      term: (stdout) => opencodeStepTotalsExcept(stdout, -1),
    },
    {
      label: 'the first step only',
      compute: (stdout) => opencodeSteps(stdout).at(0)?.['total'] as number | undefined,
      term: (stdout) => opencodeStepTotalsExcept(stdout, 0),
    },
  ],
  withoutUsage: (stdout) =>
    jsonlRecords(stdout)
      .filter((record) => record['type'] !== 'step_finish')
      .map((record) => JSON.stringify(record))
      .join('\n'),
})

describe('live opencode usage', () => {
  it(
    'runs a task that really takes several steps, or the summing rule is untested',
    async (ctx) => {
      // The wrong-rule controls above can only discriminate on a run with more
      // than one billed step, so the number of steps is itself an assertion.
      const availability = await probe(OPENCODE_TRAITS.command)
      if (!availability.available) {
        ctx.skip(`live opencode step check skipped: ${availability.reason}`)
        return
      }
      const outcome = await runReal(OPENCODE_TRAITS, MULTI_STEP_PROMPT)
      if (outcome === undefined || outcome.exitCode !== 0) {
        ctx.skip(`opencode did not complete the multi-step task: exit ${String(outcome?.exitCode)}`)
        return
      }
      expect(
        opencodeSteps(outcome.stdout).length,
        'opencode answered a tool-using task in one step, so a per-step billing defect would be invisible here',
      ).toBeGreaterThan(1)
    },
    PROBE_TIMEOUT_MS + RUN_TIMEOUT_MS + 30_000,
  )
})

describe('every shipped usage trait is verified against its own binary', () => {
  it('leaves no catalogue entry with a usagePaths trait and no live check', () => {
    // Three hand-written `verifyVendor(...)` calls are a list that drifts from the
    // thing it names — the Story 2.7a shape this whole story exists to avoid. A
    // fourth adapter shipping `usagePaths`, a usage-free clause-suite fixture and
    // no entry here would otherwise be completely untested.
    const declared = [...EXECUTOR_CATALOGUE.values()]
      .filter((executor) => executor.traits.output.usagePaths !== undefined)
      .map((executor) => executor.traits.executorId)
      .sort()
    expect(declared).toEqual([...VERIFIED].sort())
    expect(declared.length).toBeGreaterThan(0)
  })

  it('pairs every usagePaths with the discriminator that bounds its sum', () => {
    for (const executor of EXECUTOR_CATALOGUE.values()) {
      const output = executor.traits.output
      if (output.usagePaths === undefined) continue
      expect(output.usageWhen, `${executor.traits.executorId} sums usage over an unbounded set of records`).toBeDefined()
    }
  })
})
