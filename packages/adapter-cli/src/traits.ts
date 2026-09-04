import { PandaError, PANDA_ERROR_CODES, USAGE_ABSENCE_REASONS } from '@panda/contracts'
import { isRecord, usageAbsence, usageObservation, validateRunRequest } from '@panda/contracts'
import type { ExecutorAdapter, ResultEnvelope, RunRequest, UsageReport, UsageWindow } from '@panda/contracts'
import { createNodeChildSpawner, routesThroughCmdShim } from './node-child-spawner.ts'
import type { ChildProcessSpawner, SpawnedChild, SpawnOutcome } from './spawn-seam.ts'

// One generic CLI-executor engine driven by trait DATA (FR-7/8/9/10). Every
// shipped executor is a record over this engine; adding a fourth must never
// require an edit here — the trait-only stub test is what proves that claim.

/**
 * How the prompt reaches the executor.
 * - `stdin`: written to the child's stdin, which is then closed. Long prompts
 *   can never hit a command-line length limit this way.
 * - `argument`: appended as the FINAL argv entry; stdin is closed immediately
 *   so an executor that also reads stdin never blocks waiting for input.
 */
export type PromptDelivery = 'stdin' | 'argument'

/**
 * Shape of what the executor prints on stdout.
 * - `single-object`: the whole stream is one JSON object.
 * - `jsonl`: newline-delimited event objects; the result is somewhere inside.
 */
export type PayloadShape = 'single-object' | 'jsonl'

/** Equality test over a property path, used to discriminate payload records. */
export interface PathMatch {
  readonly path: readonly string[]
  readonly equals: string
}

/**
 * Where a vendor publishes its OWN per-window quota utilisation, and under which
 * spellings (Story M15.A).
 *
 * Trait DATA rather than field names in the engine, for the reason the whole
 * file exists: a fourth executor with a usage surface of its own must arrive as
 * a record, never as an edit here. `path` resolves to the vendor's MAP of named
 * windows — the keys of that map are the window names panda reports, so the
 * vocabulary is the vendor's and panda names nothing.
 */
export interface UsageWindowTraits {
  /** Which record carries the surface, e.g. `type == "rate_limit_event"`. */
  readonly when: PathMatch
  /** Path to the map of NAMED windows inside that record. */
  readonly path: readonly string[]
  /** The vendor's key for the utilisation figure inside one window. */
  readonly utilizationKey: string
  /** The vendor's key for the reset instant inside one window. */
  readonly resetsAtKey: string
}

export interface ExecutorOutputTraits {
  readonly payload: PayloadShape
  /** Property path to the result text inside a payload record. */
  readonly resultPath: readonly string[]
  /**
   * Extra condition a record must satisfy to count as THE result. Without it
   * any record carrying `resultPath` qualifies — which for Codex would accept
   * a reasoning item and answer with chain-of-thought.
   */
  readonly resultWhen?: PathMatch
  /**
   * Extra condition a record must satisfy before `errorFlagPath` and
   * `errorStatusPrefix` are read off it. Without it EVERY record in a stream is
   * examined, which is the widening a single-object payload never had.
   *
   * Claude's `--output-format json` printed exactly one object, so "the record
   * that could report failure" and "the result" were the same record by
   * construction. Its stream prints `system`, `assistant` and `hook_*` events
   * beside the result, all of them carrying a `subtype` of their own — so
   * without this the `error` prefix would be tested against a vocabulary that is
   * not the result's, and the envelope would no longer be the one the old mode
   * produced. That equivalence is the story's own acceptance criterion.
   */
  readonly failureWhen?: PathMatch
  /** Path to a boolean flag that marks an executor-reported failure. */
  readonly errorFlagPath?: readonly string[]
  /** Path to a status string reported in failure messages. */
  readonly statusPath?: readonly string[]
  /** A status starting with this prefix is a failure even on exit code 0. */
  readonly errorStatusPrefix?: string
  /** Path to the failure detail. Defaults to `resultPath`. */
  readonly errorMessagePath?: readonly string[]
  /** Extra payload paths copied into `envelope.data` under the given keys. */
  readonly metadata?: Readonly<Record<string, readonly string[]>>
  /**
   * Which records report usage. Required whenever `usagePaths` is declared.
   *
   * `usagePaths` is summed across EVERY matching record (see below), so the
   * discriminator is what bounds the sum: without it, any record whose shape
   * happens to carry the same paths joins the bill and the run is double-charged.
   * It is `resultWhen` for the accounting half, and it exists for the same reason.
   */
  readonly usageWhen?: PathMatch
  /**
   * Paths to the vendor's OWN numeric usage fields, summed into `data.usage`.
   *
   * A separate channel from `metadata` rather than a loosening of it: `metadata`
   * keeps strings, several suites assert exactly that, and a usage figure is a
   * NUMBER an accounting seam adds up. Widening the shared channel to carry both
   * would have made every existing metadata key silently numeric-capable too.
   *
   * A list, because no vendor reports one total for a run: claude-code reports
   * disjoint components (uncached input, cache creation, cache read, output) that
   * only mean something added together. Summing figures a vendor printed is not
   * panda counting tokens — nothing here estimates, tokenizes or infers; every
   * term is a number the tool itself emitted.
   *
   * Summed ACROSS records as well as within one, because a vendor that works in
   * steps bills every step. Measured on opencode 1.18.23 with a three-step task:
   * `step_finish` carried 42770, 42875 and 43025, each equal to its OWN
   * components rather than to a running total. Taking the last one billed 43025
   * of 128670 — and a task whose last step is trivial bills almost nothing.
   *
   * The record carrying usage is usually NOT the record carrying the result —
   * codex reports it on `turn.completed` and opencode on `step_finish` — so it is
   * resolved by its own scan, keyed on `usageWhen`.
   *
   * Fails CLOSED as a whole: if any matching record fails to resolve every path
   * to a finite non-negative number, the run reports NO figure at all rather than
   * a sum missing a term. A partial bill is a wrong bill; an absent one is a case
   * the pipeline already handles by keeping the estimate.
   */
  readonly usagePaths?: readonly (readonly string[])[]
  /**
   * The vendor's own QUOTA surface, if it publishes one. Absent means it does
   * not, and absence is reported as absence with that reason — never as a zero.
   *
   * Read from the LAST matching record and reported through
   * `CliExecutorAdapterOptions.onUsageObservation`, never through the envelope:
   * the envelope this story switched Claude's stream mode under has to stay
   * byte-for-byte the one the single-object mode produced.
   */
  readonly usageWindows?: UsageWindowTraits
}

export interface ExecutorTraits {
  /** Stable identity of the executor, independent of which binary path runs it. */
  readonly executorId: string
  /** Default binary; `CliExecutorAdapterOptions.command` overrides it. */
  readonly command: string
  /** Fixed argv, placed before the prompt when `promptDelivery` is `argument`. */
  readonly args: readonly string[]
  readonly promptDelivery: PromptDelivery
  /**
   * Emitted between `args` and the prompt so a prompt starting with `-` is not
   * parsed as a flag. Omit only for a CLI that has no such separator.
   */
  readonly promptArgSeparator?: string
  readonly output: ExecutorOutputTraits
}

export interface CliExecutorAdapterOptions {
  /**
   * Child-process seam. Defaults to the real Node spawner; tests inject fakes
   * here so suites never touch the actual binary.
   */
  readonly spawner?: ChildProcessSpawner
  /** Overrides the trait's command, e.g. an absolute path to the binary. */
  readonly command?: string
  /** Receives per-run timing, including NFR-9 spawn-overhead instrumentation. */
  readonly onTiming?: (timing: AdapterTiming) => void
  /**
   * Receives the vendor's own quota reading for THIS run, when the trait record
   * declares a surface to read it from (Story M15.A).
   *
   * A callback and not an envelope field, because the envelope had to stay
   * identical across the mode switch that made the reading possible. Called at
   * most once per run, and only on a run whose child actually printed something
   * — a spawn that never happened has nothing to observe, which is different
   * from an executor that ran and said nothing.
   */
  readonly onUsageObservation?: (report: UsageReport) => void
}

export interface AdapterTiming {
  /** Milliseconds spent inside run() before the child was handed to the OS. */
  readonly spawnSetupMs: number
  /** Total wall time of the run() call. */
  readonly runMs: number
}

/**
 * An adapter that also answers WHICH executor it drives. `command` can be
 * overridden per instance (an absolute path, a shim), so it is not an identity;
 * `executorId` is.
 */
export interface CliExecutorAdapter extends ExecutorAdapter {
  readonly executorId: string
}

const SUMMARY_MAX_LENGTH = 200

const BYTE_ORDER_MARK = '\uFEFF'

// Conservative argv bounds: win32 caps a whole command line at 32767 chars,
// Linux caps a SINGLE argument at 128 KiB. Refusing just under the smaller of
// the two turns an unattributable OS spawn error into a coded envelope that
// names the limit.
const ARGUMENT_PROMPT_MAX_LENGTH = process.platform === 'win32' ? 30_000 : 100_000

// Keys the engine itself writes into `envelope.data`; a metadata key colliding
// with one of them would silently overwrite the real result, hide truncation, or
// — since M3.C — forge the figure a cost cap is enforced on.
const RESERVED_DATA_KEYS = ['result', 'stdoutTruncated', 'stderrTruncated', 'usage', 'malformedStreamLines']

/** The engine-owned `data` key a settled cost is read back from. */
export const USAGE_DATA_KEY = 'usage'

/**
 * The engine-owned `data` key counting stream lines that were not JSON (E6).
 *
 * Written ONLY when the count is non-zero, exactly like `stdoutTruncated`. A bad
 * line must never discard a run that completed — but a run whose stream panda
 * could only partly read is not the same run as one it read whole, and silence
 * there is the difference nobody can see afterwards.
 */
// Not exported, unlike `USAGE_DATA_KEY` beside it: that one has a real consumer
// in `plugin.ts`, and this one has none. A constant on the package surface that
// nothing outside reads is surface nobody asked for.
const MALFORMED_LINES_DATA_KEY = 'malformedStreamLines'

export function createCliExecutorAdapter(
  traits: ExecutorTraits,
  options: CliExecutorAdapterOptions = {},
): CliExecutorAdapter {
  validateExecutorTraits(traits)
  return new TraitDrivenAdapter(traits, options)
}

// "Adding an executor is adding a record" makes the record the API surface, so
// it gets the same factory-time validation Story 2.3 gives projection traits.
// Each rejected shape below is one that fails SILENTLY at runtime rather than
// loudly: an empty resultPath resolves to the record itself, and an empty
// errorStatusPrefix marks every single run failed.
function validateExecutorTraits(traits: ExecutorTraits): void {
  const reject = (detail: string): never => {
    throw new PandaError(
      PANDA_ERROR_CODES.contractEnvelopeInvalid,
      `executor traits for '${traits.executorId}' are invalid: ${detail}`,
    )
  }
  if (traits.executorId.trim().length === 0) reject("'executorId' must be a non-empty string")
  if (traits.command.trim().length === 0) reject("'command' must be a non-empty string")
  const output = traits.output
  if (output.resultPath.length === 0) reject("'output.resultPath' must name at least one property")
  if (output.errorStatusPrefix !== undefined && output.errorStatusPrefix.length === 0) {
    reject("'output.errorStatusPrefix' must be non-empty — an empty prefix marks every run failed")
  }
  if (output.errorFlagPath !== undefined && output.errorFlagPath.length === 0) {
    reject("'output.errorFlagPath' must name at least one property")
  }
  for (const key of Object.keys(output.metadata ?? {})) {
    if (RESERVED_DATA_KEYS.includes(key)) reject(`'output.metadata' key '${key}' collides with an engine-owned data key`)
  }
  if (output.usagePaths !== undefined) {
    // An empty list declares "this vendor reports usage" and then never produces
    // a figure — the inert shape this story exists to refuse. An empty PATH
    // resolves to the record itself, which is never a number, so it would make
    // every run silently unsettleable.
    if (output.usagePaths.length === 0) reject("'output.usagePaths' must name at least one path, or be omitted")
    for (const path of output.usagePaths) {
      if (path.length === 0) reject("'output.usagePaths' entries must each name at least one property")
    }
    // Required, because the figure is SUMMED across matching records: an
    // undiscriminated sum bills every record that happens to fit the shape.
    if (output.usageWhen === undefined) {
      reject("'output.usageWhen' is required beside 'output.usagePaths' — a summed figure needs a bounded set of records")
    }
  }
  if (output.usageWhen !== undefined && output.usageWhen.path.length === 0) {
    reject("'output.usageWhen.path' must name at least one property")
  }
  if (output.failureWhen !== undefined && output.failureWhen.path.length === 0) {
    reject("'output.failureWhen.path' must name at least one property")
  }
  const windows = output.usageWindows
  if (windows !== undefined) {
    // Each rejected shape is one that would fail SILENTLY: an empty `when.path`
    // resolves to the record itself and matches nothing, an empty `path`
    // resolves to the whole event, and an empty key never names a field. All
    // three produce "this executor reported no quota" forever, which is exactly
    // the inert surface AD-5 forbids dressing up as an absence.
    if (windows.when.path.length === 0) reject("'output.usageWindows.when.path' must name at least one property")
    if (windows.path.length === 0) reject("'output.usageWindows.path' must name at least one property")
    if (windows.utilizationKey.length === 0) reject("'output.usageWindows.utilizationKey' must be a non-empty string")
    if (windows.resetsAtKey.length === 0) reject("'output.usageWindows.resetsAtKey' must be a non-empty string")
  }
}

class TraitDrivenAdapter implements CliExecutorAdapter {
  readonly #traits: ExecutorTraits
  readonly #spawner: ChildProcessSpawner
  readonly #command: string
  readonly #onTiming: ((timing: AdapterTiming) => void) | undefined
  readonly #onUsageObservation: ((report: UsageReport) => void) | undefined

  constructor(traits: ExecutorTraits, options: CliExecutorAdapterOptions) {
    this.#traits = traits
    this.#spawner = options.spawner ?? createNodeChildSpawner()
    this.#command = options.command ?? traits.command
    this.#onTiming = options.onTiming
    this.#onUsageObservation = options.onUsageObservation
  }

  get executorId(): string {
    return this.#traits.executorId
  }

  async run(request: RunRequest): Promise<ResultEnvelope> {
    validateRunRequest(request)
    const startedAt = performance.now()
    // Measured before any child exists; overwritten after spawn on the real path.
    let spawnSetupMs = performance.now() - startedAt

    if (request.signal?.aborted) return this.#cancelled(startedAt, spawnSetupMs)

    const refusal = this.#refuseArgumentPrompt(request.prompt)
    if (refusal !== undefined) return this.#finish(startedAt, spawnSetupMs, refusal)

    // Everything between startedAt and here is adapter-added overhead (NFR-9);
    // the OS-level process start itself is shared with a raw CLI invocation.
    let child: SpawnedChild
    try {
      child = this.#spawner.spawn(this.#command, this.#argv(request.prompt), { cwd: request.workspace.rootPath })
      spawnSetupMs = performance.now() - startedAt
    } catch (error) {
      return this.#finish(
        startedAt,
        spawnSetupMs,
        this.#failed(
          `executor '${this.#command}' could not be spawned: ${describe(error)}`,
          PANDA_ERROR_CODES.executorUnavailable,
        ),
      )
    }

    // Completion must be observed before an abort can claim cancellation: an
    // abort landing AFTER the child already exited successfully yields the real
    // ok/failed result, not a cancelled envelope. `child.settled` closes the
    // window between `done` resolving and the `.then` microtask below running.
    let completionSettled = false
    const completion = child.done.then((outcome) => {
      completionSettled = true
      return outcome
    })
    let cancelledInFlight = false
    const abort = () => {
      if (completionSettled || child.settled) return
      cancelledInFlight = true
      child.killTree()
    }
    request.signal?.addEventListener('abort', abort, { once: true })
    try {
      try {
        if (this.#traits.promptDelivery === 'stdin') child.writeStdin(request.prompt)
        child.endStdin()
      } catch (error) {
        // The child is alive and unreachable: without this it keeps running
        // against the workspace after the envelope is returned.
        child.killTree()
        return this.#finish(
          startedAt,
          spawnSetupMs,
          this.#failed(
            `pipe to executor '${this.#command}' failed: ${describe(error)}`,
            PANDA_ERROR_CODES.executorRunFailed,
          ),
        )
      }
      const outcome = await completion
      if (cancelledInFlight) {
        // A killed child settles through `close` carrying everything it printed,
        // so the tokens it already spent are right here. Charging a cancelled run
        // its estimate while its own stdout says otherwise is a hole a caller can
        // drive through by aborting late.
        return this.#cancelled(startedAt, spawnSetupMs, this.#unstructuredData(outcome, this.#scan(outcome.stdout)))
      }
      return this.#fromOutcome(outcome, startedAt, spawnSetupMs)
    } finally {
      request.signal?.removeEventListener('abort', abort)
    }
  }

  #argv(prompt: string): readonly string[] {
    if (this.#traits.promptDelivery !== 'argument') return this.#traits.args
    const separator = this.#traits.promptArgSeparator
    return separator === undefined ? [...this.#traits.args, prompt] : [...this.#traits.args, separator, prompt]
  }

  /**
   * Guards the argument-delivery path, which puts caller-supplied text in argv.
   *
   * The cmd.exe refusal is the important one: on win32 a `.cmd`/`.bat` command
   * can only start by rerouting through a SHELL, and no amount of quoting stops
   * cmd.exe from interpreting `&`, `|`, `>`, `^` or `%VAR%` in the prompt.
   * Escaping for cmd.exe is not winnable, so the run fails closed instead.
   */
  #refuseArgumentPrompt(prompt: string): ResultEnvelope | undefined {
    if (this.#traits.promptDelivery !== 'argument') return undefined
    if (routesThroughCmdShim(this.#command)) {
      return this.#failed(
        `executor '${this.#command}' can only start through cmd.exe, which would interpret shell metacharacters in the prompt argument; point 'command' at the real executable instead of the .cmd shim`,
        PANDA_ERROR_CODES.executorUnavailable,
      )
    }
    if (prompt.length > ARGUMENT_PROMPT_MAX_LENGTH) {
      return this.#failed(
        `prompt of ${prompt.length} characters exceeds the ${ARGUMENT_PROMPT_MAX_LENGTH}-character argument limit of executor '${this.#command}'`,
        PANDA_ERROR_CODES.executorRunFailed,
      )
    }
    return undefined
  }

  #fromOutcome(outcome: SpawnOutcome, startedAt: number, spawnSetupMs: number): ResultEnvelope {
    const finish = (envelope: ResultEnvelope) => this.#finish(startedAt, spawnSetupMs, envelope)
    // Scanned FIRST, and on every path below. A child that failed, was killed or
    // was cut off still printed whatever it had already spent, and those bytes are
    // in hand here — discarding them made failing and cancelling free, which is
    // exactly the evasion a budget must not have. Measured before this moved: a
    // cancelled run carrying 500,000 reported tokens in captured stdout was
    // charged its estimate of 1.
    const scan = this.#scan(outcome.stdout)
    const truncation = this.#unstructuredData(outcome, scan)

    if (outcome.spawnErrorMessage !== undefined) {
      // The one path with genuinely nothing to read: no child ever started.
      return finish(
        this.#failed(
          `executor '${this.#command}' is not available: ${outcome.spawnErrorMessage}`,
          PANDA_ERROR_CODES.executorUnavailable,
        ),
      )
    }
    if (outcome.streamErrorMessage !== undefined) {
      return finish(
        this.#failed(
          `pipe to or from executor '${this.#command}' failed: ${outcome.streamErrorMessage}`,
          PANDA_ERROR_CODES.executorRunFailed,
          truncation,
        ),
      )
    }
    if (outcome.exitCode === null) {
      return finish(
        this.#failed(
          `executor '${this.#command}' was terminated by an external signal before completing`,
          PANDA_ERROR_CODES.executorRunFailed,
          truncation,
        ),
      )
    }

    // An executor that reports its own failure is believed regardless of exit
    // code and regardless of WHERE in the stream it said so: OpenCode emits
    // recoverable error events and keeps going, so a positional rule would drop
    // the reason whenever any output followed it.
    if (scan.failure !== undefined) return finish(this.#failedFromRecord(scan.failure, outcome, scan))

    if (outcome.exitCode !== 0) {
      // codex and opencode exit non-zero exactly when they have printed their
      // structured error, so the payload — not stderr noise — is the reason.
      if (scan.result !== undefined) return finish(this.#failedFromRecord(scan.result, outcome, scan))
      const detail =
        outcome.stderr.trim().length > 0
          ? outcome.stderr.trim()
          : `executor '${this.#command}' exited with code ${outcome.exitCode}`
      return finish(this.#failed(detail, PANDA_ERROR_CODES.executorRunFailed, truncation))
    }

    // A cut stream can leave an earlier event as the last PARSEABLE one, so a
    // truncated capture must never be reported as a complete answer.
    if (outcome.stdoutTruncated === true) {
      return finish(
        this.#failed(
          `executor '${this.#command}' produced more output than could be captured, so its result is incomplete`,
          PANDA_ERROR_CODES.executorRunFailed,
          truncation,
        ),
      )
    }
    if (scan.result !== undefined) return finish(this.#okFromRecord(scan.result, outcome, scan))
    return finish(this.#failed(this.#noResultDetail(scan), PANDA_ERROR_CODES.executorRunFailed, truncation))
  }

  #noResultDetail(scan: PayloadScan): string {
    if (!scan.sawRecord) {
      return this.#traits.output.payload === 'single-object'
        ? `executor '${this.#command}' printed unparseable output instead of JSON`
        : `executor '${this.#command}' printed no JSON event carrying a '${this.#traits.output.resultPath.join('.')}' result`
    }
    return `executor '${this.#command}' returned JSON without a usable '${this.#traits.output.resultPath.join('.')}' result`
  }

  /**
   * Reads stdout once and reports the two records that matter: the FIRST record
   * reporting a failure, and the LAST record carrying a usable result.
   *
   * Event-type names (`item.completed`, `text`, …) are the executors' own
   * evolving vocabularies; the engine never matches on them. It matches on the
   * paths the trait record names, which is why trailing noise (blank lines,
   * non-object lines, bookkeeping events) costs nothing.
   */
  #scan(stdout: string): PayloadScan {
    const scan: MutablePayloadScan = {
      failure: undefined,
      result: undefined,
      usage: undefined,
      windows: undefined,
      malformedLines: 0,
      sawRecord: false,
    }
    const text = stdout.startsWith(BYTE_ORDER_MARK) ? stdout.slice(BYTE_ORDER_MARK.length) : stdout
    // Accumulated across every record `usageWhen` selects, and voided outright by
    // any one of them that cannot be read — see `usagePaths`.
    let usageTotal: number | undefined
    let usageVoid = false
    const consider = (record: Record<string, unknown>) => {
      scan.sawRecord = true
      if (scan.failure === undefined && this.#reportsFailure(record)) scan.failure = record
      if (this.#resultText(record) !== undefined) scan.result = record
      // LAST wins, like the result: a vendor that re-reports its quota mid-run
      // has said something newer, and the newest reading is the true one.
      const windows = this.#usageWindowsOf(record)
      if (windows !== undefined) scan.windows = windows
      if (usageVoid || !this.#reportsUsage(record)) return
      const usage = this.#usageOf(record)
      if (usage === undefined) {
        usageVoid = true
        return
      }
      usageTotal = (usageTotal ?? 0) + usage
    }

    if (this.#traits.output.payload === 'single-object') {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        this.#reportUsage(scan)
        return scan
      }
      if (isRecord(parsed)) consider(parsed)
      scan.usage = usageVoid ? undefined : usageTotal
      this.#reportUsage(scan)
      return scan
    }

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // Skipped, and COUNTED (E6). One bad line in the middle of a stream must
        // not throw away a run that reached its result — and it must not vanish
        // either, or a partly-readable stream is indistinguishable from a whole one.
        scan.malformedLines += 1
        continue
      }
      if (isRecord(parsed)) consider(parsed)
    }
    scan.usage = usageVoid ? undefined : usageTotal
    this.#reportUsage(scan)
    return scan
  }

  /**
   * Hands the caller what the vendor said about its own quota, once per run.
   *
   * Called from `#scan`, which is the one function every settled path goes
   * through exactly once — reporting from the callers instead would be two
   * places to forget it in.
   *
   * An executor whose traits declare no surface reports NOTHING here rather than
   * a `noUsageSurface` absence: that answer is a property of the executor, not
   * of any run, and `panda status` states it from the catalogue without needing
   * a run to have happened at all.
   */
  #reportUsage(scan: PayloadScan): void {
    const report = this.#onUsageObservation
    const traits = this.#traits.output.usageWindows
    if (report === undefined || traits === undefined) return
    if (scan.windows === undefined || scan.windows.length === 0) {
      report(
        usageAbsence(
          this.#traits.executorId,
          USAGE_ABSENCE_REASONS.notReported,
          `executor '${this.#traits.executorId}' produced no readable '${traits.path.join('.')}' in this run`,
        ),
      )
      return
    }
    report(usageObservation(this.#traits.executorId, scan.windows, new Date().toISOString()))
  }

  /**
   * The vendor's named windows carried by one record, or undefined when it
   * carries none.
   *
   * Per WINDOW rather than fail-closed as a whole, and that asymmetry with
   * `#usageOf` is deliberate: a usage figure is a BILL, where a missing term
   * silently under-charges, so a term it cannot read voids the sum. These are a
   * REPORT of what the vendor said, where each window stands on its own — a
   * vendor that adds a third window in a shape panda does not know must not
   * erase the two it does.
   */
  #usageWindowsOf(record: Record<string, unknown>): readonly UsageWindow[] | undefined {
    const traits = this.#traits.output.usageWindows
    if (traits === undefined || resolvePath(record, traits.when.path) !== traits.when.equals) return undefined
    const map = resolvePath(record, traits.path)
    if (!isRecord(map)) return undefined
    const windows: UsageWindow[] = []
    for (const [name, value] of Object.entries(map)) {
      if (!isRecord(value)) continue
      const utilization = value[traits.utilizationKey]
      const resetsAt = value[traits.resetsAtKey]
      // Copied across unchanged (D5): the vendor's own name, the vendor's own
      // number, the vendor's own instant. Nothing here scales, averages, picks
      // one window over another, or turns a reset into a countdown.
      if (typeof utilization !== 'number' || !Number.isFinite(utilization)) continue
      if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) continue
      windows.push({ name, utilization, resetsAt })
    }
    return windows.length > 0 ? windows : undefined
  }

  /** Whether this record is one of the ones this vendor reports usage on. */
  #reportsUsage(record: Record<string, unknown>): boolean {
    const when = this.#traits.output.usageWhen
    return (
      this.#traits.output.usagePaths !== undefined &&
      when !== undefined &&
      resolvePath(record, when.path) === when.equals
    )
  }

  /**
   * What one usage record reports, summed over its declared components, or
   * undefined when it cannot be read.
   *
   * Undefined here VOIDS the whole run's figure rather than skipping the record
   * (see `#scan`): a term the engine could not read is spend it cannot account
   * for, and dropping it silently under-bills.
   */
  #usageOf(record: Record<string, unknown>): number | undefined {
    let total = 0
    for (const path of this.#traits.output.usagePaths ?? []) {
      const value = resolvePath(record, path)
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
      total += value
    }
    return total
  }

  /** The result text a record carries, or undefined when it carries none. */
  #resultText(record: Record<string, unknown>): string | undefined {
    const match = this.#traits.output.resultWhen
    if (match !== undefined && resolvePath(record, match.path) !== match.equals) return undefined
    const value = resolvePath(record, this.#traits.output.resultPath)
    // A blank result must not shadow the real answer: a trailing empty-string
    // event would otherwise win the scan and produce an empty summary.
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined
  }

  // An executor can report failure while exiting 0 (Claude's `is_error` and
  // `error_*` subtypes, Codex's and OpenCode's `error` events), so the payload —
  // not the exit code alone — decides the envelope status.
  #reportsFailure(record: Record<string, unknown>): boolean {
    const output = this.#traits.output
    const when = output.failureWhen
    if (when !== undefined && resolvePath(record, when.path) !== when.equals) return false
    if (output.errorFlagPath !== undefined && resolvePath(record, output.errorFlagPath) === true) return true
    const status = this.#status(record)
    return output.errorStatusPrefix !== undefined && status !== undefined && status.startsWith(output.errorStatusPrefix)
  }

  #status(record: Record<string, unknown>): string | undefined {
    if (this.#traits.output.statusPath === undefined) return undefined
    const status = resolvePath(record, this.#traits.output.statusPath)
    return typeof status === 'string' ? status : undefined
  }

  /**
   * `envelope.data` for one payload record.
   *
   * `usage` arrives as a separate argument rather than being read off `record`
   * because the vendor rarely reports it there: codex prints it on
   * `turn.completed` and opencode on `step_finish`, both AFTER the record that
   * carried the answer. It is written as a NUMBER — the one non-string value in
   * this object, and the only one an accounting seam can add up.
   */
  /**
   * `envelope.data` for a failure that has no payload record to report from —
   * truncation flags and whatever usage the child printed before it died.
   * `null` when there is nothing at all, which is what those paths used to return
   * unconditionally.
   */
  #unstructuredData(outcome: SpawnOutcome, scan: PayloadScan): Record<string, unknown> | null {
    const truncation = truncationData(outcome)
    const skipped = malformedData(scan)
    if (truncation === null && skipped === null && scan.usage === undefined) return null
    return {
      ...(truncation ?? {}),
      ...(skipped ?? {}),
      ...(scan.usage === undefined ? {} : { [USAGE_DATA_KEY]: scan.usage }),
    }
  }

  #data(record: Record<string, unknown>, outcome: SpawnOutcome, scan: PayloadScan): Record<string, unknown> {
    const result = resolvePath(record, this.#traits.output.resultPath)
    const data: Record<string, unknown> = typeof result === 'string' ? { result } : {}
    for (const [key, path] of Object.entries(this.#traits.output.metadata ?? {})) {
      const value = resolvePath(record, path)
      if (typeof value === 'string') data[key] = value
    }
    if (scan.usage !== undefined) data[USAGE_DATA_KEY] = scan.usage
    return { ...data, ...(truncationData(outcome) ?? {}), ...(malformedData(scan) ?? {}) }
  }

  #failedFromRecord(record: Record<string, unknown>, outcome: SpawnOutcome, scan: PayloadScan): ResultEnvelope {
    const output = this.#traits.output
    const status = this.#status(record)
    const reported = stringifyDetail(resolvePath(record, output.errorMessagePath ?? output.resultPath))
    const detail = [reported.trim(), outcome.stderr.trim()].find((part) => part.length > 0) ?? ''
    const reason = `executor '${this.#command}' reported failure${status !== undefined ? ` (${status})` : ''}`
    return this.#failed(
      detail.length > 0 ? `${reason}: ${detail}` : reason,
      PANDA_ERROR_CODES.executorRunFailed,
      this.#data(record, outcome, scan),
    )
  }

  #okFromRecord(record: Record<string, unknown>, outcome: SpawnOutcome, scan: PayloadScan): ResultEnvelope {
    return {
      status: 'ok',
      data: this.#data(record, outcome, scan),
      summary: this.#summarize(this.#resultText(record) ?? ''),
      errors: [],
    }
  }

  #summarize(result: string): string {
    const firstLine = result
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    // executorId, not command: an overridden command is an absolute filesystem
    // path, which has no business leaking into a user-facing summary.
    return truncate(firstLine ?? `${this.#traits.executorId} completed the task`)
  }

  #cancelled(startedAt: number, spawnSetupMs: number, data: Record<string, unknown> | null = null): ResultEnvelope {
    return this.#finish(startedAt, spawnSetupMs, {
      status: 'cancelled',
      data,
      summary: 'execution cancelled before completion',
      errors: [
        {
          message: 'the run was cancelled and its process tree terminated',
          code: PANDA_ERROR_CODES.executorCancelled,
        },
      ],
    })
  }

  #failed(message: string, code: string, data: unknown = null): ResultEnvelope {
    return {
      status: 'failed',
      data,
      summary: truncate(message),
      errors: [{ message, code }],
    }
  }

  #finish(startedAt: number, spawnSetupMs: number, envelope: ResultEnvelope): ResultEnvelope {
    this.#onTiming?.({ spawnSetupMs, runMs: performance.now() - startedAt })
    return envelope
  }
}

interface PayloadScan {
  readonly failure: Record<string, unknown> | undefined
  readonly result: Record<string, unknown> | undefined
  /** The vendor's summed usage figure, from whichever record reported it. */
  readonly usage: number | undefined
  /** The vendor's own quota windows, from the LAST record that carried them. */
  readonly windows: readonly UsageWindow[] | undefined
  /** Non-empty stream lines that were not JSON, skipped rather than fatal (E6). */
  readonly malformedLines: number
  /** At least one line parsed as an object, i.e. the output was not garbage. */
  readonly sawRecord: boolean
}

type MutablePayloadScan = { -readonly [K in keyof PayloadScan]: PayloadScan[K] }

function resolvePath(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record
  for (const segment of path) {
    // Own properties only, so a segment named like an Object.prototype member
    // ('constructor', 'toString', …) can never resolve an inherited value and
    // make EVERY record qualify. Today `isRecord` already stops each of those
    // one hop earlier — every Object.prototype member is a function — so this
    // is the second lock rather than the first, and it is the one that keeps
    // holding if the record shape or `isRecord` ever loosens.
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/**
 * The skipped-line count, or null when nothing was skipped.
 *
 * Absent on a clean stream ON PURPOSE: the envelope this story's acceptance
 * compares against the old single-object mode must be key-for-key the same one,
 * and a counter that is structurally zero is a counter nobody can read anyway.
 */
function malformedData(scan: PayloadScan): Record<string, number> | null {
  return scan.malformedLines > 0 ? { [MALFORMED_LINES_DATA_KEY]: scan.malformedLines } : null
}

function truncationData(outcome: SpawnOutcome): Record<string, boolean> | null {
  return outcome.stdoutTruncated === true || outcome.stderrTruncated === true
    ? { stdoutTruncated: outcome.stdoutTruncated === true, stderrTruncated: outcome.stderrTruncated === true }
    : null
}

// Failure details are not always strings: OpenCode reports `error` as an object.
// Stringifying keeps the reason inside the envelope instead of dropping it.
function stringifyDetail(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

// Cuts on code points, not UTF-16 units: slicing mid-surrogate would persist a
// lone surrogate into the envelope summary.
function truncate(text: string): string {
  const points = Array.from(text)
  return points.length > SUMMARY_MAX_LENGTH ? `${points.slice(0, SUMMARY_MAX_LENGTH).join('')}…` : text
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
