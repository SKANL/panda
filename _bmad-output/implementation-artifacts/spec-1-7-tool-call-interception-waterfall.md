---
title: 'Tool-call interception waterfall'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'dee3981'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-01-composition-first.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-6-kernel-owned-observability-log.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-scoped-event-bus-and-layered-configuration.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** panda has no place to enforce a budget. AD-10 requires a kernel-exposed pipeline through which every executor-action invocation flows, and states that token budgets, loop caps and fan-out limits are enforced *"exclusively at this seam as declarative policy — never by prompt instruction"*. That "exclusively" makes the seam a single point of failure: with no seam, a budget has nowhere legal to live, and the PRD's own line applies — *"a budget rule in a prompt is a preference"*.

**Approach:** a generic interception pipeline in the kernel — `pre → guard → around → post` — over an ACTION, not over an executor. The kernel never learns what an executor is (AD-1 forbids it from importing contracts), so an action is a declared descriptor with a numeric cost, and policies are data that cap counts, sums and concurrency over those descriptors. Violations raise coded kernel errors. The one way to execute a registered action is through `invoke`; there is no raw escape hatch to export.

**Why now (ROADMAP-01 M1):** measured, the kernel has zero production callers. An around-pipeline added to a container nobody mounts is contained; added after the CLI, registry, projection and adapters compose through it, it is a breaking kernel API change that NFR-8's joint-semver rule turns into a major bump of all seven contracts.

## Boundaries & Constraints

**Always:** the pipeline is the ONLY exported way to execute a registered action — no raw runner is exported, and a test pins that; stages run in the declared order `pre → guard → around → post`, with `post` running even when the action fails; a guard rejection and a policy violation raise CODED kernel errors from `KERNEL_ERROR_CODES`; policies are DECLARATIVE data (caps over counts, summed cost, and concurrency), never imperative callbacks that could read a prompt; one stage's failure is contained the way AD-5 contains a plugin's — a broken interceptor never takes the kernel down and never silently lets an action through; every invocation and every violation is recorded through the Story 1.6 sink; `@panda/kernel` keeps ZERO runtime dependencies and never imports `@panda/contracts` (AD-1).

**Ask First:** enforcing any budget expressed in a unit the kernel would have to interpret (tokens are a NUMBER to the kernel — who counts them is the caller's business); persisting counters across processes; any retry or backoff behaviour in the pipeline.

**Never:** no knowledge of executors, adapters, prompts or models inside the kernel; no budget expressed as prompt text anywhere; no stage that can mutate another stage's decision after the fact; no bypass parameter, debug flag or "unsafe" export that skips the waterfall.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stage order | An action with all four stages registered | `pre → guard → around → post`, observed in that order | N/A |
| Guard rejects | A guard denies the action | The action never runs; a coded error names the guard and the action | Coded error |
| Count cap | Declared cap of N invocations, N+1 attempted | The N+1th is refused before running | Coded error naming the cap |
| Cost cap | Declared total-cost budget exceeded by an invocation's cost | Refused before running; the partial total is reported | Coded error naming the cap |
| Fan-out cap | Declared max concurrency exceeded | Refused before running | Coded error naming the cap |
| Action fails | The wrapped operation throws | `post` still runs; the failure reaches the caller unswallowed | Original error preserved |
| Broken interceptor | A stage itself throws | Contained: the kernel keeps running, the action does NOT silently proceed | Coded error |
| No bypass | Any exported kernel surface | There is no exported path that executes a registered action without the pipeline | Pinned by test |
| Recording | Any invocation, allowed or refused | A record reaches the Story 1.6 sink | Degraded per 1.6 policy |
| Nested invocation | An action invoked from inside another | Counted against the caps once each, not double | N/A |

</frozen-after-approval>

## Code Map

- `packages/kernel/src/intercept.ts` -- NEW: the action descriptor, the four-stage pipeline, declarative policy shapes, and the counters
- `packages/kernel/src/lifecycle.ts` -- expose the pipeline on the activation context so plugins invoke through it
- `packages/kernel/src/errors.ts` -- coded errors for a guard rejection and each cap kind
- `packages/kernel/src/log.ts` -- one new event for an invocation and one for a violation (closed shape, per Story 1.6)
- `packages/kernel/src/index.ts` -- export the pipeline and the policy shapes
- `packages/kernel/test/intercept.test.ts` -- NEW: the matrix, including the no-bypass proof

## Tasks & Acceptance

**Execution:**
- [x] Action descriptor with a numeric cost + declarative policy shapes
- [x] Four-stage pipeline with `post` guaranteed and stage failure contained
- [x] Count, cost and concurrency caps with coded violations
- [x] Invocations and violations recorded through the 1.6 sink
- [x] No-bypass proof + every matrix row

**Acceptance Criteria:**
- Given the kernel's interception pipeline, when any registered action runs, then it flows through `pre → guard → around → post` with no exported path around the seam
- And token budgets, loop caps and fan-out limits are enforced there as declarative policy, never by prompt instruction
- And a policy violation raises a coded error from the AD-7 hierarchy
- And a test proves an invocation cannot reach its operation without traversing the pipeline

## Spec Change Log

- **Review, the seam validated one object and enforced against another (patch, BLOCKER):** `createActionPipeline` read its policy once and was safe; `register` read its definition three-to-five times and was not. A `cost` accessor validated at 90 and charged at -1000 drove `totalCost` to -999,910 under a cap of 100 — reopening the exact refund the comment beside it warned about, because freezing the descriptor froze the THIRD read. A `GuardDecision.allow` accessor answering `false, false, true` was validated as a well-formed DENIAL and then admitted, leaving a clean `action.invoked` and no refusal in the stream. An `id` accessor made every record for that action fail `seal`, and NEITHER of 1.6's loss signals fired (seal throws before `seq += 1` and before dispatch), so an invocation ran and spent budget with zero audit records. And `run`/`pre`/`guard`/`around`/`post` were re-read at every invoke, so `ActionDefinition.run`'s own doc — "held in a closure and never handed back" — described something the code did not do: a reviewer swapped the operation after registration and had it executed at the old price. `register` now destructures once, validates what it read, and closes over the locals. `recordSafely` additionally counts what it contained (`lostRecordCount`), because containment was otherwise indistinguishable from success.
- **Review, the fan-out cap did not bound fan-out (patch, BLOCKER):** `runAround` awaited the promise `around` RETURNED and never tracked the one `proceed()` created, so the slot was released when the stage returned. A textbook `Promise.race` timeout `around` reached a peak of three concurrent real operations under `maxConcurrent: 1`, with `usage.concurrent` reporting 0 — and the un-awaited rejection escaped as a process-level `unhandledRejection`, fatal by default on the Node this package requires. The slot now belongs to the operation: `proceed()`'s promise is retained, handled the instant it exists, and awaited before release. A reviewer also replaced the release `finally` with a `catch` that skipped `StageFailedError` and 172/172 still passed, because the "kernel keeps running" clauses used a fresh uncapped action; that loop now runs at `maxConcurrent: 1` and asserts the slot came back.
- **Review, a capability outlived its stage (patch, BLOCKER):** `proceed` was handed to `around` as a plain function with no lifetime, so an `around` that stored it ran the operation later — uncounted, unrecorded, holding no slot, with `maxInvocations`, `maxTotalCost` and `maxConcurrent` all exhausted. It is revoked in `runAround`'s `finally`.
- **Review, the pin moved with the thing it constrained (patch, BLOCKER):** `expectTypeOf(createActionPipeline).parameters.toEqualTypeOf<[LogSink, ActionPolicy?]>()` named `ActionPolicy` BY REFERENCE, so widening the interface widened the expectation in lockstep. A reviewer added `readonly unsafeBypass?: boolean` plus `if (policy.unsafeBypass === true) return await definition.run()` as the first line of `invoke` — a bypass parameter the Never list forbids in as many words — and got 172/172 tests, `tsc` exit 0 and clean eslint. `ActionPolicy` is now pinned structurally against a literal that moves independently. The related hole: the exported-surface pin was one `package.json` line from void, since `"./src/*": "./src/*"` would expose every internal module with the gate green; `guard.test.ts` now pins the exports map, and its contracts scan reads import SPECIFIERS (and covers `test/`, not only `src/`).
- **Review, admission and accounting were two steps (patch):** `recordSafely` ran between the cap check and the increment, so a sink that merely DOES something on that stack — it need not throw — saw the pre-admission counter and reached a peak of four under `maxConcurrent: 1`. The increments moved inside `admit()`. The count and cost caps were also exercised only sequentially: deferring the increments to a microtask passed 171/172. Both are now tested with overlapping invocations.
- **Review, the outcome vocabulary did not distinguish what the log distinguishes (patch):** an `around` that threw after `await proceed()` told `post` `{status:'refused'}` while usage read `{invocations:1, totalCost:10}`, so any `post` keying refund logic on `refused` concluded nothing was spent. `ActionOutcome` gained `stage-failed`. Same principle applied to the stream: `action.completed` and `action.failed` were added (a failed spend was byte-identical to a successful one), a throwing `post` now records `action.post-failed` rather than sharing `action.stage-failed` (the action did not fail, its observer did), and a `StageFailedError` is relayed verbatim only when it is THIS action's own `around` failure — a nested one was being reported to the outer caller under the inner action's id and stage.
- **Review, five comments were still standing in for tests (patch):** each was proven by a mutation that passed 172/172 — the context's `Object.freeze` was unobserved (the existing `TypeError` came from the descriptor's freeze), "post runs for a guard denial" was tested only for a cap refusal, "post does NOT run when pre threw" had no test at all (and that is the double-release the ordering exists to prevent), `BudgetUsage`'s freeze was unobserved, and the `ACTION_STAGES` cross-check filtered against the constant as an unordered set and compared to a hardcoded literal, so reordering it, deleting `'around'` from it, or adding a phantom fifth stage all passed. The trail is now derived FROM the constant.
- **Smaller:** `id.trim()` split registration identity from audit identity (two registrations, one subject; `handle.id !== definition.id`), so an untrimmed id is rejected rather than normalised, and duplicate ids are rejected per pipeline. `Infinity` caps are rejected along with NaN and negatives — "unlimited" is spelled by omitting the cap. The double-`proceed()` refusal is escapable by an `around` that catches its own `StageFailedError`: it then completes normally with no refusal recorded, which costs nothing in accounting (the operation still ran once) but is a doc-vs-code gap worth naming.

- **Three log events, where the Code Map anticipated two:** `action.invoked` and `action.refused` cover an invocation and a violation as written, but a stage that THROWS is neither. Filing a throwing `post` under `action.refused` would make the stream assert the action was refused when it had already run — the exact defect 1.6's review found in `plugin.disposed` being recorded for a disposer that failed. `action.stage-failed` is the third, and it carries `PANDA_KERNEL_STAGE_FAILED` for all four stages.
- **One code per cap kind, not one `BUDGET_EXCEEDED` plus a field:** the 1.6 record shape is closed (`event`, `subject`, `service`, `code`) and has nowhere to carry which cap fired, so a single code would make every violation in the audit stream indistinguishable from every other. Three codes, one error class — the classes would have been identical.
- **`post` is the only stage whose throw is swallowed:** `pre`, `guard` and `around` fail closed with `PANDA_KERNEL_STAGE_FAILED` (contained AND not silently allowed). `post` runs after the outcome is decided, so propagating its throw would let it turn a completed action into a failed one, which the Never list forbids as "mutating another stage's decision after the fact". Swallowed is not silent: it is recorded.
- **`post` balances `pre`, not the operation:** it runs for a guard denial and a cap violation too, so anything `pre` acquired is released. It does NOT run when `pre` itself threw — that acquire never completed.
- **Fail-closed details the matrix does not name, each pinned by a test:** a guard returning a non-decision is a stage failure, not an allow; a negative or NaN `cost` is refused at registration (a negative cost would REFUND spent budget); a NaN cap is refused at construction (every `>` against NaN is false, so it would silently disable the budget); caps are copied out of the caller's policy object, so mutating it later changes nothing; an `around` that calls `proceed()` twice is refused, because two runs against one budget charge is exactly the accounting AD-10 exists to make trustworthy.

## Design Notes

**Why an action and not an executor.** AD-1 forbids the kernel from importing `@panda/contracts`, so it cannot type an `ExecutorAdapter`. That constraint is a gift here: a generic action seam is what lets a budget cover anything an agent does, not only executor spawns. Tokens are a plain number to the kernel; who counts them is the caller's problem.

**Why declarative policy, not callbacks.** A callback can read anything, including a prompt, which is exactly the failure AD-10 names. Caps expressed as data can be dumped, diffed and reasoned about without executing them — and a policy nobody can execute is a policy nobody can trick.

**The honest limit of the no-bypass guarantee.** At kernel level this story can prove there is no exported way to execute a REGISTERED action outside the pipeline. It CANNOT prove that a caller in another package never bypasses the kernel and calls an adapter directly — today `panda run` does exactly that. Making that impossible is composition work, and it lands in Story 2.7a where the CLI stops constructing adapters with `new`. This spec deliberately claims only what it can enforce, and names the rest.

**Deliberately not built.** No retries, no backoff, no scheduling, no priority, no cross-process counters. The seam refuses or allows and records what it did.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green
