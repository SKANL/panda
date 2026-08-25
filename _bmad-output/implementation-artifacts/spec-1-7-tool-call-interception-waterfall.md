---
title: 'Tool-call interception waterfall'
type: 'feature'
created: '2026-08-25'
status: 'draft'
review_loop_iteration: 0
baseline_commit: 'TBD — set to the commit that lands Story 1.6'
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
- [ ] Action descriptor with a numeric cost + declarative policy shapes
- [ ] Four-stage pipeline with `post` guaranteed and stage failure contained
- [ ] Count, cost and concurrency caps with coded violations
- [ ] Invocations and violations recorded through the 1.6 sink
- [ ] No-bypass proof + every matrix row

**Acceptance Criteria:**
- Given the kernel's interception pipeline, when any registered action runs, then it flows through `pre → guard → around → post` with no exported path around the seam
- And token budgets, loop caps and fan-out limits are enforced there as declarative policy, never by prompt instruction
- And a policy violation raises a coded error from the AD-7 hierarchy
- And a test proves an invocation cannot reach its operation without traversing the pipeline

## Spec Change Log

## Design Notes

**Why an action and not an executor.** AD-1 forbids the kernel from importing `@panda/contracts`, so it cannot type an `ExecutorAdapter`. That constraint is a gift here: a generic action seam is what lets a budget cover anything an agent does, not only executor spawns. Tokens are a plain number to the kernel; who counts them is the caller's problem.

**Why declarative policy, not callbacks.** A callback can read anything, including a prompt, which is exactly the failure AD-10 names. Caps expressed as data can be dumped, diffed and reasoned about without executing them — and a policy nobody can execute is a policy nobody can trick.

**The honest limit of the no-bypass guarantee.** At kernel level this story can prove there is no exported way to execute a REGISTERED action outside the pipeline. It CANNOT prove that a caller in another package never bypasses the kernel and calls an adapter directly — today `panda run` does exactly that. Making that impossible is composition work, and it lands in Story 2.7a where the CLI stops constructing adapters with `new`. This spec deliberately claims only what it can enforce, and names the rest.

**Deliberately not built.** No retries, no backoff, no scheduling, no priority, no cross-process counters. The seam refuses or allows and records what it did.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green
