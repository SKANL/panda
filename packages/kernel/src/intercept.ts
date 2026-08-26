import {
  ActionDeniedError,
  ActionInvalidError,
  BudgetExceededError,
  KERNEL_ERROR_CODES,
  PandaKernelError,
  StageFailedError,
} from './errors.ts'
import { isRecordIdentifier, recordCodeOf, recordSafely, type LogEvent, type LogSink } from './log.ts'

/**
 * The waterfall, as data. The pipeline cannot iterate this list — each stage has
 * a different signature — so it is not the enforcement; the enforcement is the
 * order `invoke` runs them in, and `intercept.test.ts` derives its expected trail
 * FROM this constant, so reordering, deleting or inventing a stage fails there.
 * What the constant also buys is a CLOSED vocabulary for `StageFailedError.stage`.
 */
export const ACTION_STAGES = ['pre', 'guard', 'around', 'post'] as const

export type ActionStage = (typeof ACTION_STAGES)[number]

/**
 * What the kernel knows about an action: an identifier and a NUMBER.
 *
 * AD-1 forbids the kernel from importing the contracts package, so it cannot type
 * an `ExecutorAdapter` and deliberately does not try. `cost` is uninterpreted — a
 * token estimate, a dollar figure, a weight — and who counts it is the caller's
 * business. That is what lets one budget cover anything an agent does rather than
 * only executor spawns.
 *
 * `cost` is the price the action was ADMITTED at, and every stage sees that
 * number. A settlement changes what the PIPELINE charges, never this descriptor:
 * a frozen record of the agreed price is what a settled total can be checked
 * against.
 */
export interface ActionDescriptor {
  readonly id: string
  readonly cost: number
}

/** Live totals the caps are checked against. Snapshot, never the live counters. */
export interface BudgetUsage {
  /** Admitted invocations. A refused one never counted. */
  readonly invocations: number
  /**
   * Summed cost of admitted invocations: each one's declared estimate, replaced
   * by its settled figure once its operation resolved and something observed
   * what it actually cost.
   */
  readonly totalCost: number
  /** Admitted invocations whose OPERATION has not settled yet. */
  readonly concurrent: number
}

/** What every stage sees. Frozen: a stage observes, it does not steer the others. */
export interface StageContext {
  readonly action: ActionDescriptor
  readonly usage: BudgetUsage
}

/**
 * A guard's verdict. One shape with a mandatory reason on denial, not
 * `boolean | string`: the reason ends up in the coded error a caller has to act
 * on, and an optional one is a reason nobody writes.
 */
export type GuardDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string }

/**
 * What `post` is told. Closed, exactly like a log record: `post` runs after the
 * outcome is already decided, and a slot it could write into would be a way to
 * mutate another stage's decision after the fact — which the spec forbids.
 *
 * `refused` and `stage-failed` are separate because they mean opposite things to
 * a `post` that releases or refunds: a refusal spent NOTHING, while a stage
 * failure can land after the budget was charged and the operation already ran.
 */
export type ActionOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'refused'; readonly error: PandaKernelError }
  | { readonly status: 'stage-failed'; readonly error: StageFailedError }

export interface ActionDefinition<T = unknown> {
  /** Recorded verbatim as the log subject, so it obeys the same identifier rules. */
  readonly id: string
  /**
   * What admission is priced at. An ESTIMATE when `settle` is declared, and the
   * final word when it is not.
   */
  readonly cost: number
  /** The operation. Read ONCE at registration and held in a local — see `register`. */
  readonly run: () => T | Promise<T>
  /**
   * Reconciles the estimate against what the operation turned out to cost, from
   * the value it resolved to. Returns the SETTLED cost, or `undefined` when
   * nothing observed a figure — in which case the estimate stands and the stream
   * says so, because a run nobody measured is not a free one.
   *
   * WHO MAY SETTLE, which is a security question and not plumbing: this belongs
   * to the DECLARER of the action, exactly like `cost` and `run`, and it is read
   * once at `register` and closed over. There is deliberately no settlement
   * parameter on `invoke()`, so a holder of an `ActionHandle` — the caller whose
   * spend is being capped — cannot price its own run at zero. The declarer could
   * always have declared `cost: 0`, so settling adds it no power it did not have;
   * the caller gains none.
   *
   * The honest ceiling: a settled figure is only as truthful as whatever the
   * declarer read it from. The kernel checks that a number is a usable number,
   * never that a vendor told the truth about its own usage.
   *
   * Read only for its return value. A throw is contained and recorded — the
   * operation already ran, and an observer must not be able to fail it.
   */
  readonly settle?: (value: T) => number | undefined
  readonly pre?: (context: StageContext) => void
  readonly guard?: (context: StageContext) => GuardDecision
  /** Wraps the operation. Calling `proceed` is optional; calling it twice is refused. */
  readonly around?: (context: StageContext, proceed: () => Promise<T>) => T | Promise<T>
  readonly post?: (context: StageContext, outcome: ActionOutcome) => void
}

export interface ActionHandle<T = unknown> {
  readonly id: string
  /**
   * The only way to execute this action. `register` read the definition ONCE and
   * closed over the resulting locals, so neither this handle nor the definition
   * object the caller still holds can change what the pipeline will run.
   *
   * The honest limit (spec Design Notes): a CALLER still holds the closure it
   * passed to `register` and can obviously call that. What this guarantees is
   * that the kernel exports no path around the seam, which is the half a kernel
   * can enforce; stopping other packages from constructing adapters directly is
   * composition work, done by `@panda/session` in Story 2.0.
   */
  invoke(): Promise<T>
}

/**
 * Caps as DATA, never callbacks. A callback can read anything, including a
 * prompt, which is the exact failure AD-10 names; caps expressed as numbers can
 * be dumped, diffed and reasoned about without executing them.
 *
 * Every cap is optional and every omitted cap is unlimited. All three are copied
 * out of this object at construction, so mutating it afterwards changes nothing.
 * The shape is pinned STRUCTURALLY by a test rather than by name: a field added
 * here — an `unsafeBypass` debug flag being the obvious one — is a bypass
 * parameter, which the spec's Never list forbids outright.
 */
export interface ActionPolicy {
  /** Loop cap: the most admitted invocations, across all actions of this pipeline. */
  readonly maxInvocations?: number
  /**
   * Budget: the most summed cost admitted, across all actions of this pipeline,
   * measured on the SETTLED total — so a run that overspent its estimate is what
   * the next run is refused against.
   */
  readonly maxTotalCost?: number
  /** Fan-out cap: the most OPERATIONS in flight at once. */
  readonly maxConcurrent?: number
}

export interface ActionPipeline {
  /** Declares an action and returns its handle; the operation is never returned. */
  register<T>(definition: ActionDefinition<T>): ActionHandle<T>
  readonly usage: BudgetUsage
}

function positiveCap(field: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  // NaN is the dangerous one: every `>` comparison against it is false, so a NaN
  // cap would fail OPEN and silently disable the budget it was meant to impose.
  // Infinity is rejected with it — "unlimited" is spelled by omitting the cap.
  if (!Number.isFinite(value) || value < 0) {
    throw new ActionInvalidError(field, 'must be a finite number of at least 0 (omit the cap for unlimited)')
  }
  return value
}

/**
 * The interception waterfall: `pre -> guard -> around -> post` over an action,
 * with declarative caps on counts, summed cost and concurrency (AD-10).
 *
 * `log` is a required parameter for the same reason it is one on the load path
 * (AD-4/Story 1.6): "every invocation and every violation is recorded" is a type
 * error to violate, not a convention someone remembers. Every record goes through
 * `recordSafely`, so a hostile sink degrades the audit trail without taking down
 * the seam that is enforcing the budget — and `lostRecordCount(log)` is how a
 * caller tells containment apart from success.
 *
 * Cost is ADMITTED on a declared estimate and SETTLED when the operation resolves
 * (Story M3.C). The up-front refusal is what makes a cap a cap, and no honest
 * figure for a run exists before it has run — so the pipeline admits on the
 * estimate, reconciles the total afterwards, and enforces every later cap on the
 * settled total. A cap a settlement pushed past is not retroactively un-run: it
 * refuses the NEXT admission, which is the only refusal a budget can honestly
 * make about work that already happened.
 *
 * ponytail: no retries, no backoff, no scheduling, no priority, no cross-process
 * counters — all Ask-First or explicitly out of scope. The seam refuses or allows
 * and records what it did. Settlement is one adjustment per invocation, with no
 * re-settlement and no separate refund path. Caps are pipeline-wide, a wedged `around` holds its
 * slot with no timeout, and any holder of this factory can build a second,
 * uncapped pipeline: all three ceilings and their upgrade paths are named in
 * `_bmad-output/implementation-artifacts/deferred-work.md`.
 */
export function createActionPipeline(log: LogSink, policy: ActionPolicy = {}): ActionPipeline {
  // Copied, not read through: `policy` belongs to the caller, and a budget a
  // caller can raise after construction by mutating the object it handed in is
  // not a budget. Every caller-supplied object below gets the same treatment —
  // read once, validate what was read, then operate only on the copy.
  const maxInvocations = positiveCap('maxInvocations', policy.maxInvocations)
  const maxTotalCost = positiveCap('maxTotalCost', policy.maxTotalCost)
  const maxConcurrent = positiveCap('maxConcurrent', policy.maxConcurrent)

  /**
   * Whether this pipeline is actually enforcing anything.
   *
   * It gates the SETTLEMENT records, and only them. The frozen promise is that a
   * run with no policy set behaves exactly as it did before this story, and the
   * accounting records are the one thing that would otherwise change: three
   * pre-existing clauses pin the exact action-event sequence of an executor run
   * and every one of them runs uncapped. With a budget configured there IS a
   * reader who needs the arithmetic, and the stream carries all of it — an
   * `action.estimated` for every admitted settleable invocation and an
   * `action.settled` for every one that reconciled — which is what makes the
   * total reconstructable from the stream EXACTLY rather than approximately.
   */
  const policyConfigured = maxInvocations !== undefined || maxTotalCost !== undefined || maxConcurrent !== undefined

  let invocations = 0
  let totalCost = 0
  let concurrent = 0
  // Depth of settlements currently executing DECLARER code. Non-zero means a
  // figure is known-but-unapplied and the running total is stale.
  let settling = 0
  const registeredIds = new Set<string>()

  function usageNow(): BudgetUsage {
    return Object.freeze({ invocations, totalCost, concurrent })
  }

  function register<T>(definition: ActionDefinition<T>): ActionHandle<T> {
    // ONE read of every field, up front, and only OWN fields. Reading a
    // caller-controlled property a second time is a TOCTOU hole at a budget seam:
    // an accessor that returns a valid cost to the validator and a negative one
    // to the accountant refunds every cap already consumed, and one that swaps
    // `run` after registration gets an arbitrary operation executed at the
    // declared price.
    //
    // `Object.hasOwn`, not destructuring, because every optional field here would
    // otherwise resolve up the PROTOTYPE CHAIN. Measured: with
    // `Object.prototype.settle` set to a function returning 0, five 50-cost
    // actions were admitted under a cap of 100 and `totalCost` read 0 — every
    // un-settled action in the process became free and the cost cap silently
    // unlimited. `cost` is the same hole one step earlier (a definition that omits
    // it would inherit a price), and unlimited spend is the one direction a budget
    // seam must never fail. A polluted prototype can still make a REGISTRATION
    // throw, which is a denial of service rather than a spend hole, and is the
    // honest limit of a per-field guard.
    const own = <K extends keyof ActionDefinition<T>>(field: K): ActionDefinition<T>[K] | undefined =>
      Object.hasOwn(definition, field) ? definition[field] : undefined
    const id = own('id') as string
    const cost = own('cost') as number
    const run = own('run') as ActionDefinition<T>['run']
    const settle = own('settle')
    const pre = own('pre')
    const guard = own('guard')
    const around = own('around')
    const post = own('post')

    if (typeof id !== 'string' || id !== id.trim() || !isRecordIdentifier(id)) {
      // Rejected rather than trimmed FOR the caller: `handle.id` and the audit
      // subject must be the same string as the declared one, or two distinct
      // registrations collapse into one indistinguishable subject in the stream.
      throw new ActionInvalidError('id', 'must be an already-trimmed identifier a log record accepts')
    }
    if (registeredIds.has(id)) {
      throw new ActionInvalidError('id', `is already registered on this pipeline ('${id}')`)
    }
    if (!Number.isFinite(cost) || cost < 0) {
      // A negative cost would REFUND the budget it is supposed to spend, so an
      // action declaring -1000 would buy back every cap it had already consumed.
      throw new ActionInvalidError('cost', 'must be a finite number of at least 0')
    }
    if (typeof run !== 'function') {
      throw new ActionInvalidError('run', 'must be a function')
    }
    if (settle !== undefined && typeof settle !== 'function') {
      // Rejected at registration, not skipped at settlement: a non-function here
      // is a declarer that believes its runs are being reconciled while every one
      // of them silently stands at its estimate.
      throw new ActionInvalidError('settle', 'must be a function when present')
    }
    registeredIds.add(id)
    const descriptor: ActionDescriptor = Object.freeze({ id, cost })

    function contextNow(): StageContext {
      return Object.freeze({ action: descriptor, usage: usageNow() })
    }

    async function invoke(): Promise<T> {
      // Set at every site where the PIPELINE refuses, so `post` can be told
      // "refused" apart from "the operation itself threw" without inspecting types.
      let refusal: PandaKernelError | undefined
      // The promise `proceed()` created, if it did. The concurrency slot belongs
      // to THIS, not to whatever `around` happened to return.
      let operationRun: Promise<T> | undefined
      let operationFailure: { readonly error: unknown } | undefined
      // What the operation RESOLVED to, boxed so `undefined` as a legitimate
      // result is not mistaken for "the operation never produced one".
      let operationValue: { readonly value: T } | undefined
      // What THIS invocation currently stands charged. Per-invocation, which is
      // what makes two in-flight actions settling in either order correct: each
      // applies its own delta to the shared total, and a sum does not care in
      // which order its terms arrive.
      let charged = 0
      let settlementDone = false

      function fail(event: Extract<LogEvent, `action.${string}`>, error: PandaKernelError): never {
        refusal = error
        recordSafely(log, { event, subject: id, code: recordCodeOf(error) })
        throw error
      }

      function runGuard(): GuardDecision {
        if (guard === undefined) return { allow: true }
        let decision: GuardDecision
        try {
          decision = guard(contextNow())
        } catch (cause) {
          return fail('action.stage-failed', new StageFailedError(id, 'guard', cause))
        }
        // Each field read ONCE into a local, and a NORMALISED copy returned: an
        // accessor answering `false, false, true` would otherwise be validated as
        // a well-formed denial and then admitted as a permission. The casts are
        // because the signature promises a decision while this checks what a JS
        // caller actually returned. Fail CLOSED — "broken" must never read as
        // "allowed" at a budget seam.
        const decided = decision as GuardDecision | null | undefined
        const allow: unknown = decided?.allow
        if (allow === true) return { allow: true }
        const reason: unknown = (decided as { reason?: unknown } | null | undefined)?.reason
        if (allow === false && typeof reason === 'string') return { allow: false, reason }
        return fail(
          'action.stage-failed',
          new StageFailedError(id, 'guard', new TypeError('guard returned a value that is not a GuardDecision')),
        )
      }

      function admit(): void {
        if (settling > 0) {
          // A `settle` that re-enters the pipeline reads a total whose latest
          // figure is being computed and not yet applied, so it would be admitted
          // against a stale number by construction. Refused rather than served:
          // fail-closed at a budget seam means refusing an admission nobody can
          // price. Narrower than the in-flight overshoot the ledger records —
          // there the figure genuinely does not exist yet.
          fail(
            'action.refused',
            new PandaKernelError(
              KERNEL_ERROR_CODES.settlementInProgress,
              `action '${id}' refused: a settlement is in progress on this pipeline, so the running total is not final`,
            ),
          )
        }
        if (maxInvocations !== undefined && invocations + 1 > maxInvocations) {
          fail('action.refused', new BudgetExceededError('invocations', id, maxInvocations, invocations, invocations + 1))
        }
        if (maxTotalCost !== undefined && totalCost + cost > maxTotalCost) {
          fail('action.refused', new BudgetExceededError('cost', id, maxTotalCost, totalCost, totalCost + cost))
        }
        if (maxConcurrent !== undefined && concurrent + 1 > maxConcurrent) {
          fail('action.refused', new BudgetExceededError('concurrency', id, maxConcurrent, concurrent, concurrent + 1))
        }
        // Checking and counting are ONE step, with nothing awaited or recorded
        // between them: a sink that re-enters invoke() on this stack, or an
        // increment deferred to a microtask, would otherwise let two invocations
        // both pass a cap of one.
        invocations += 1
        totalCost += cost
        charged = cost
        concurrent += 1
      }

      /**
       * Replaces this invocation's estimate with what the operation actually
       * cost, once. Runs after the operation has resolved and before the slot is
       * released, so the next `admit()` — which may already be queued behind this
       * microtask — checks its caps against the settled total.
       *
       * Every exit leaves the ESTIMATE standing. That is the fail-closed
       * direction: a run whose figure was missing, broken or hostile stays
       * charged what it was admitted at, so failing, throwing or lying is never
       * cheaper than reporting honestly.
       */
      function settleCost(): void {
        if (settle === undefined || settlementDone) return
        settlementDone = true
        // The operation never resolved a value: it threw, it was cancelled
        // mid-flight, or `around` substituted a result without proceeding. There
        // is nothing to reconcile against and nothing to say.
        if (operationValue === undefined) return
        let reported: unknown
        try {
          // Counted while DECLARER code runs, so a `settle` that re-enters this
          // pipeline is refused rather than admitted against a stale total.
          settling += 1
          reported = settle(operationValue.value)
        } catch {
          rejectSettlement()
          return
        } finally {
          settling -= 1
        }
        // Nothing observed this run. The estimate stands, and the settlement
        // record is deliberately absent rather than reporting a figure nobody
        // produced; a reader adds the `action.estimated` instead.
        if (reported === undefined) return
        // `typeof` is redundant with `Number.isFinite`, which does not coerce and
        // is already false for a string, a boolean, null and an object. It is kept
        // for the reader and it is NOT a second guard: a mutant that deletes it is
        // equivalent, not uncovered.
        //
        // MAX_SAFE_INTEGER is the "absurd" bound, and the honest reason is
        // narrower than "past it every later total goes wrong": four legitimate
        // settlements can reach that state too. What the bound buys is that ONE
        // figure cannot put the total there in a single step, and since every
        // drift past it is upward, a cap that has lost precision fails CLOSED.
        if (
          typeof reported !== 'number' ||
          !Number.isFinite(reported) ||
          reported < 0 ||
          reported > Number.MAX_SAFE_INTEGER
        ) {
          rejectSettlement()
          return
        }
        // FLOORED at the estimate: a settlement may RAISE what a run costs and
        // never lower it. Measured before the floor: a well-formed 0 made the run
        // free, and `claude` on a logged-out machine prints an all-zero usage
        // object — so a cost cap did not survive a developer being signed out.
        // The estimate is the declarer's own number, so a declarer that wants a
        // low floor declares one honestly; over-charging is the fail-closed
        // direction and under-charging is the hole. This is what makes the comment
        // above true as written: failing, throwing or lying is never cheaper than
        // reporting honestly.
        const settled = reported < charged ? charged : reported
        // A DELTA against what this invocation stands charged, never `+= settled`:
        // the estimate was already added at admission, and adding the settlement
        // beside it is the double charge the matrix forbids. `charged` is then
        // moved so a second settlement — which `settlementDone` already prevents —
        // could not charge the difference twice either.
        totalCost += settled - charged
        charged = settled
        // What the total now carries, so a reader taking `action.settled` where it
        // exists and `action.estimated` where it does not reconstructs the total
        // EXACTLY. Silent on an unbudgeted pipeline — see `policyConfigured`.
        if (policyConfigured) recordSafely(log, { event: 'action.settled', subject: id, cost: settled })
      }

      /** A figure arrived and could not be charged. Coded, and the estimate stands. */
      function rejectSettlement(): void {
        if (policyConfigured) {
          recordSafely(log, {
            event: 'action.settle-rejected',
            subject: id,
            code: KERNEL_ERROR_CODES.settlementInvalid,
          })
        }
      }

      async function runAround(): Promise<T> {
        let revoked = false
        let proceeded = false
        const proceed = (): Promise<T> => {
          // A capability handed to a stage must not outlive the stage. Without
          // this, an `around` that stores `proceed` and calls it later runs the
          // operation uncounted, unrecorded and holding no concurrency slot —
          // with every cap already exhausted.
          if (revoked) {
            throw new StageFailedError(id, 'around', new RangeError('proceed() must be called before around returns'))
          }
          if (proceeded) {
            // Two runs against one budget charge is precisely the accounting
            // AD-10 exists to make trustworthy, so this is refused, not tolerated.
            throw new StageFailedError(id, 'around', new RangeError('proceed() may be called at most once'))
          }
          proceeded = true
          const running = (async (): Promise<T> => {
            try {
              const value = await run()
              // Captured HERE rather than from whatever `around` returns: a
              // substituted or cached result is the stage's answer, not the
              // operation's, and settling a cost against it would price a run
              // that never happened.
              operationValue = { value }
              return value
            } catch (error) {
              operationFailure = { error }
              throw error
            }
          })()
          operationRun = running
          // Marks the rejection handled the instant it can exist: an `around`
          // that returns without awaiting this would otherwise leave an unhandled
          // rejection, which terminates the process by default on the Node this
          // package requires. A forgotten `await` in a stage must not kill the kernel.
          void running.catch(() => {})
          return running
        }
        try {
          return await (around === undefined ? proceed() : around(contextNow(), proceed))
        } catch (error) {
          // The operation's own failure reaches the caller unswallowed and
          // UNWRAPPED: hiding a caller's error behind a kernel one loses the
          // stack that explains it.
          if (operationFailure !== undefined && error === operationFailure.error) throw error
          // Relayed verbatim ONLY when it is this action's own around failure. A
          // nested action's error passed straight through would report the outer
          // caller a failure under the inner action's id and stage.
          const own = error instanceof StageFailedError && error.actionId === id && error.stage === 'around'
          return fail('action.stage-failed', own ? error : new StageFailedError(id, 'around', error))
        } finally {
          revoked = true
        }
      }

      if (pre !== undefined) {
        try {
          pre(contextNow())
        } catch (cause) {
          // `post` is deliberately NOT run here: it is the release half of a
          // pre/post pair, and a `pre` that threw never completed its acquire.
          // Running it anyway is the double-release this ordering prevents.
          fail('action.stage-failed', new StageFailedError(id, 'pre', cause))
        }
      }

      // Past this line `post` is owed whatever happens, so anything `pre`
      // acquired is released even when the guard denies or the operation throws.
      let outcome: ActionOutcome = { status: 'completed' }
      try {
        const decision = runGuard()
        if (!decision.allow) fail('action.refused', new ActionDeniedError(id, decision.reason))
        admit()
        recordSafely(log, { event: 'action.invoked', subject: id })
        // At ADMISSION, because that is when the estimate was charged, and a
        // reader reconstructing the total needs the number for a run that never
        // settles just as much as for one that does.
        if (settle !== undefined && policyConfigured) {
          recordSafely(log, { event: 'action.estimated', subject: id, cost })
        }
        let value: T
        try {
          value = await runAround()
        } finally {
          // The slot belongs to the OPERATION, not to the stage that wrapped it.
          // An `around` that returns without awaiting proceed() (a Promise.race
          // timeout is the textbook case) leaves a real operation running, and
          // releasing here would let the fan-out cap admit another beside it.
          if (operationRun !== undefined) await operationRun.catch(() => {})
          // Before the slot is released, so the settled total is already in place
          // for whatever admits next. The usual stream reads
          // invoked -> estimated -> settled -> completed, but that order is not
          // universal: an `around` that throws AFTER the operation resolved lands
          // `action.stage-failed` first and there is no `action.completed` at all.
          settleCost()
          concurrent -= 1
        }
        recordSafely(log, { event: 'action.completed', subject: id })
        return value
      } catch (error) {
        if (refusal !== undefined && refusal === error) {
          outcome =
            refusal instanceof StageFailedError
              ? { status: 'stage-failed', error: refusal }
              : { status: 'refused', error: refusal }
        } else {
          outcome = { status: 'failed', error }
          // Without this the stream cannot answer "did the spend succeed": an
          // admitted invocation that failed was byte-identical to one that worked.
          recordSafely(log, { event: 'action.failed', subject: id, code: recordCodeOf(error) })
        }
        throw error
      } finally {
        if (post !== undefined) {
          try {
            post(contextNow(), outcome)
          } catch {
            // The ONLY stage whose throw is swallowed. `post` runs after the
            // outcome is decided, so propagating it would let `post` turn a
            // completed action into a failed one — mutating another stage's
            // decision after the fact, which the spec forbids outright.
            //
            // Swallowed is not silent, and it gets its OWN event rather than
            // sharing `action.stage-failed`: the action did not fail, only its
            // observer did. The thrown value itself goes nowhere because the 1.6
            // record shape is closed by design — no message, no cause, nowhere
            // for a secret to hide — and the kernel has no other channel for a
            // contained error; that gap is named in deferred-work.md.
            recordSafely(log, { event: 'action.post-failed', subject: id, code: KERNEL_ERROR_CODES.stageFailed })
          }
        }
      }
    }

    return Object.freeze({ id, invoke })
  }

  return Object.freeze({
    register,
    get usage() {
      return usageNow()
    },
  })
}
