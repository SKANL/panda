---
title: 'Session composition through the kernel'
type: 'refactor'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 1
baseline_commit: '72675fc'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-01-composition-first.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-7-tool-call-interception-waterfall.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-5-first-execution-claude-code-driven-headlessly.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** the PRD says panda *"ships as an SDK first: a headless kernel usable from any project"*, and the only composition panda has lives inside its CLI. `runPanda` is 114 lines mixing argv parsing, exit codes and stdout formatting with the real work — create a workspace, obtain an adapter, run a prompt under a cancellation signal, release and dispose. A third party who installs the packages to do exactly that must reimplement it. Separately, Story 1.7's no-bypass guarantee is kernel-scoped by its own admission, *"because today `panda run` constructs adapters directly"*.

**Approach:** move the composition into an SDK-level package and have the CLI call it. While the composition moves, route the executor invocation through the Story 1.7 interception pipeline, so the two problems are solved by one move instead of the same code being rewritten twice. Behaviour-neutral for `panda run`: same envelope, same exit codes, same interrupt handling, same cleanup.

**Why a new package.** AD-2's topology is strictly downward: implementation packages depend on `@panda/contracts` and never on each other, while a consumer may depend on the kernel, contracts and implementations. A composition that wires an adapter to a workspace provider is therefore consumer-level, not implementation-level — the same tier the CLI occupies, which is exactly why the CLI is where it accidentally ended up.

## Boundaries & Constraints

**Always:** the SDK surface is reachable without `@panda/cli`, and a test fails if composition logic returns to the CLI package; `@panda/cli` keeps ONLY argv parsing, output formatting and exit-code mapping; `panda run` is behaviour-neutral — identical envelope, identical exit codes (0 ok, 1 failed/cancelled, 2 usage/environment), identical cancellation on interrupt, identical workspace release and dispose, including on the failure paths; the executor invocation flows through the Story 1.7 pipeline so the no-bypass guarantee holds end to end; every existing `packages/cli/test/run.test.ts` assertion keeps passing, because it pins the behaviour this story must not change; the new package respects AD-2's direction and declares its dependencies honestly.

**Ask First:** mounting adapters and providers as kernel PLUGINS with manifests (this story routes the invocation through the pipeline; full plugin mounting is a larger change); any change to the `ResultEnvelope` shape; any new CLI command.

**Never:** no behaviour change visible to a `panda run` user; no new capability — this story moves and rewires, it does not add; no composition logic left in or returned to `@panda/cli`; no bypass of the interception pipeline for the executor invocation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SDK use without the CLI | A consumer importing packages, not `@panda/cli` | Composes a session and receives the same envelope `panda run` prints | Coded errors surface unchanged |
| CLI stays thin | The `@panda/cli` sources | Only argv, formatting and exit codes; a test fails if composition returns | Test failure |
| Behaviour neutrality | Every existing CLI test | Passes unchanged | N/A |
| Interception | Any executor invocation through the session | Traverses the 1.7 pipeline; a policy violation refuses it before the executor runs | Coded kernel error |
| Workspace creation fails | Provider throws on create | Provider disposed, coded error surfaced, exit code 2 preserved | Coded error |
| Executor fails or is cancelled | Adapter returns failed/cancelled | Envelope returned; exit code 1 preserved; workspace still released and disposed | N/A |
| Interrupt mid-run | Signal fires during the run | Run cancelled, cancelled envelope, cleanup runs, handler unregistered | N/A |
| Cleanup itself fails | Release or dispose throws | Never masks the primary envelope or error, exactly as today | Contained |

</frozen-after-approval>

## Code Map

- `packages/session/` -- NEW consumer-tier package: the composition (`runSession` and its options), depending on kernel + contracts + the implementations it wires
- `packages/cli/src/run.ts` -- reduced to argv parsing, output formatting and exit-code mapping; calls the session
- `packages/cli/package.json` -- depends on the new package; drops what it no longer constructs
- `packages/cli/test/run.test.ts` -- unchanged assertions (the behaviour-neutrality proof), plus the pin that composition has not returned
- `packages/session/test/` -- the SDK surface exercised the way a third party would, including the interception path

## Tasks & Acceptance

**Execution:**
- [x] New consumer-tier package with the composition extracted verbatim in behaviour
- [x] Executor invocation routed through the Story 1.7 pipeline
- [x] CLI reduced to a binding; a test pins that it stays one
- [x] Every existing CLI assertion still passing, unmodified
- [x] Matrix covered, including cleanup on each failure path

**Acceptance Criteria:**
- Given a project that has NOT installed `@panda/cli`, when it composes a session, then it gets the same envelope `panda run` produces with no code copied from the CLI
- And `@panda/cli` contains only argv parsing, output formatting and exit-code mapping, pinned by a test
- And the executor invocation flows through the interception pipeline, so 1.7's guarantee holds end to end
- And `panda run` behaves identically — envelope, exit codes, cancellation, cleanup

## Spec Change Log

- **Review, a ledger entry that was not true (patch, PROCESS):** this story briefly closed Story 1.7's no-bypass deferral with "the only path from a prompt to an executor is `runSession`". A reviewer refuted it by execution — call `runSession` with `maxInvocations: 0`, watch it refuse, then invoke the same adapter object handed to `createAdapter`: the executor runs, uncounted and unrecorded. Any package can also import an adapter factory directly. The entry is now split into a NARROWED one stating exactly what changed (`@panda/cli` no longer bypasses the waterfall) and a reopened one carrying both bypass routes, and the narrowed entry names its own history. A closed entry that is not true is worse than an open one, because it deletes the record — and this session had already corrected the same "the text claims what the code does not do" defect three times in comments.
- **Review, cleanup did not run on every path (patch, BLOCKERS):** `removeSignalHandler()` was the first of THREE steps in a `finally` whose comment said "both cleanup steps are contained". Measured: a throwing deregistration replaced a successful `ok` envelope with a rejection AND skipped release and dispose. Separately, the interrupt registration sat OUTSIDE the `try` while the handle was already leased, so a throwing `onInterrupt` leaked the handle and the provider entirely. Both contained now, both pinned by the measured failure.
- **Review, the same root class a third time (patch):** `run: () => adapter.run({ prompt: options.prompt, … })` read the caller's live object at INVOKE time, with an `await provider.create()` in between handing control back. Measured: passed `'delete nothing'`, executor received `'rm -rf /'`. The comment above it claimed `register` read it once — what `register` closes over is the closure. Every option is destructured at the top of `runSession` now. The kernel defends against exactly this and says so in a comment; the session had handed it straight back.
- **Review, the boundary pin did not hold, and the fix was already in the repo (patch):** a reviewer planted a WORKING composition in the CLI — full workspace lifecycle, real adapter seam — using relative cross-package imports and destructured `release`/`dispose`. All four clauses, typecheck and lint stayed green. The `no-restricted-imports` rule with the `^\.\.[\/]\.\.` pattern already existed, scoped to the kernel; it is now repo-wide, and it rejects that composition. The vocabulary scan was DELETED rather than patched: a text scan is evadable (`provider['release'](h)`) and false-positive-prone (it fired on a comment naming the tokens), and a seam-only composition needs no `AbortController` at all since the signal is optional. What carries the claim instead is positive proof — a consumer test in `packages/session` importing only its own entry point, running a real session, and asserting the exact object the CLI prints.
- **Review, behaviour neutrality had two deltas outside the oracle (patch):** output now happens after cleanup on every non-usage path, and a throwing `createProvider()` now maps to exit 2 instead of escaping as an unhandled rejection. The second is a fix; both were unpinned. Three CLI assertions added that never existed — `JSON.stringify` failure, adapter-throws, and provider-construction-throws all mapping to exit 2.
- **Review, a knob that did nothing (patch):** with one action of cost 1 invoked once per pipeline, all three caps collapse to a single boolean. Measured: five sessions each capped at `maxInvocations: 1` ran five executors, while the README presented that exact policy as a budget. The README now states the collapse, and the cost test uses a FRACTIONAL cap — the only assertion available that a cost cap can satisfy and an invocation count cannot. The registered action id gained the workspace suffix so a future shared pipeline stays additive rather than colliding on a constant.
- **Review, ownership was unstated (patch):** the session DISPOSES the provider a caller supplies, so `createProvider: () => myProvider` breaks the second session with `PANDA_CONTRACT_PROVIDER_DISPOSED` — exactly what a host pooling workspaces would write. Documented and pinned. A blank prompt also used to cost a `mkdir` before failing inside the adapter; it is rejected before the provider is constructed now, using the contracts package's own predicate and code.
- **Review, the SDK was not usable as advertised (patch):** the README example opened with an import from `@panda/kernel`, which a `@panda/session`-only consumer cannot resolve under pnpm's strict layout — proven with `ERR_MODULE_NOT_FOUND`. The public surface is re-exported from the package's own entry point, and the example drains the sink before reading records, because an async sink has none visible when `runSession` resolves. The CLI's error formatter also duck-types on `code` now: `PandaKernelError` is a disjoint hierarchy by AD-1, so a refusal's code was being dropped from stderr. That removed the CLI's last runtime import of contracts — it now ships depending on exactly one package.

## Design Notes

**Why this precedes init, doctor and executor selection.** Those three build on this pattern. Establishing it first means they are written correctly by construction rather than corrected afterwards — the same argument that put the kernel seams before composition in M1, which held. It is also the cheapest this move will ever be: 114 lines today, three commands' worth after M2.

**Why the interception rides along.** Story 1.7's spec states plainly that its no-bypass guarantee cannot cover a caller in another package that constructs an adapter directly, and names this story as where that ends. Doing the extraction without the rewiring would mean touching the same code twice for one outcome.

**What "behaviour-neutral" is worth.** It makes the refactor independently verifiable: the existing CLI suite is the oracle, and it must pass without edits. A refactor that needs its tests rewritten to go green has not been shown to preserve anything.

**Deliberately not built.** No plugin manifests for adapters and providers, no new commands, no envelope changes, no capability. This story moves code and closes one guarantee.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, with the CLI suite passing unmodified
