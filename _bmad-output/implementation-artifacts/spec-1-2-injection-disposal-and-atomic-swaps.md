---
title: 'Injection, disposal, and atomic swaps'
type: 'feature'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'c5ec49ed8de1218e6e96060d259f68b4c8933747'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.1 loads and resolves plugin manifests but has no lifecycle: nothing starts, nothing disposes, and there is no safe way to replace an implementation. Services could observe half-initialized or half-destroyed state, and a bad replacement would take down a working system.

**Approach:** Add a start/stop lifecycle to the kernel on top of the existing loader: activations run in dependency order, disposers unwind in exact reverse order, disposal is idempotent with typed post-dispose errors, and service implementations swap only after full candidate validation commits atomically.

## Boundaries & Constraints

**Always:** every service registration pairs with a disposer; teardown unwinds in exact reverse activation order (verified via an injectable ordering log); double-dispose is a no-op; any operation targeting a disposed plugin raises a typed error carrying a stable `PANDA_KERNEL_*` code; a swap validates the candidate FULLY before commit — an invalid swap leaves the previous implementation serving and returns a typed error naming the validation failure; one plugin's failed activation is contained (kernel and other plugins keep running). New codes join `KERNEL_ERROR_CODES` and the contracts parity suite pins all of them. Zero runtime dependencies and no `@skanl/panda-contracts` imports in kernel remain enforced by the existing guard tests.

**Ask First:** changing readiness semantics beyond presence-propagation decided in 1.1; introducing async-only lifecycles (activation/disposal must work synchronously; async support only if trivially additive); any new package.

**Never:** no event bus or scoped subscriptions (Story 1.3); no layered config (Story 1.3); no executor/workspace/adapter work; no speculative retry/backoff machinery around swaps.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Chained teardown | Three plugins A→B→C chained by hard consumption, kernel started then stopped | Disposers execute in exact reverse activation order; injectable ordering log records sequence | N/A |
| Double dispose | Dispose the same plugin twice | Second call is a no-op (no error, no duplicate log entry) | N/A |
| Post-dispose use | Call a service operation after its plugin was disposed | Typed inactive error naming the plugin | Coded error |
| Invalid swap | Swap candidate fails its own validation | Previous implementation still serving; typed swap error listing the validation failures | Coded error, state untouched |
| Valid swap | Candidate passes validation | New implementation serves immediately; old disposer runs after commit | N/A |
| Activation failure containment | One plugin's activation throws | That plugin recorded as failed; remaining plugins activate and serve normally | Contained failure surfaced in start result |

</frozen-after-approval>

## Code Map

Builds directly on Story 1.1 output:

- `packages/kernel/src/loader.ts` -- existing load pipeline; lifecycle composes ON TOP of `loadPlugins` results (topo order derivable from hard-dependency edges)
- `packages/kernel/src/errors.ts` -- extend `KERNEL_ERROR_CODES` + add typed classes here (same structural pattern)
- `packages/kernel/src/lifecycle.ts` -- NEW: kernel container (start/stop/swap/get), activation ordering, reverse-order disposal, atomic swap
- `packages/contracts/src/errors.ts` + `packages/contracts/test/kernel-code-parity.test.ts` -- pin the new codes
- `packages/kernel/test/lifecycle.test.ts` -- NEW suites incl. ordering-log verification

## Tasks & Acceptance

**Execution:**
- [ ] `packages/kernel/src/errors.ts` -- add codes/classes (`PLUGIN_INACTIVE`, `SWAP_REJECTED`; keep vocabulary minimal) -- lifecycle failure modes need stable identities
- [ ] `packages/kernel/src/lifecycle.ts` -- createKernel: register(manifest, factory), start (dependency-ordered activation, containment), stop (reverse-order disposal, idempotent), getService (typed-absent/inactive semantics), swap (validate-then-commit) -- the story's core deliverable
- [ ] `packages/contracts` parity suite -- pin new codes -- drift protection per AD-7
- [ ] `packages/kernel/test/lifecycle.test.ts` -- lock all I/O matrix rows with an injectable ordering log -- regression protection for Stories 1.3+

**Acceptance Criteria:**
- Given three plugins chained A→B→C, when the kernel stops, then disposers ran in exact reverse activation order per the ordering log
- Given a disposed plugin, when dispose runs again, then it is a no-op; when a service operation is attempted, then a typed inactive error names the plugin
- Given a swap candidate failing validation, when the swap is attempted, then the previous implementation still serves and a typed swap error names each validation failure
- Given a valid swap candidate, when committed, then consumers observe the new implementation and the old disposer ran after commit
- Given one plugin whose activation throws, when the kernel starts, then other plugins are ready and serving, and the failure is contained in the start result

## Spec Change Log

- 2026-08-24 (code review round): Sanctioned review-driven amendments. A per-plugin `dispose(pluginId)` API was added — the matrix's double-dispose row demands plugin granularity, not just whole-kernel stop. New `PANDA_KERNEL_PLUGIN_START_FAILED` code sanctioned to de-conflate activation failure (contained start failures) from disposed-access (`PLUGIN_INACTIVE` is now exclusively for operations targeting disposed plugins). `stop()`/`swap()` return shapes extended with disposal-error containment: stop runs every disposer despite throws and reports `{disposed, disposalErrors}`; swap contains old-disposer throws in `disposalError`. Terminal-state silent no-ops replaced with typed errors: `start()`/`register()` on a stopped kernel raise `PLUGIN_INACTIVE` naming `'kernel'`; restart is unsupported in this story. Additional invariants enforced: activation outcomes must cover exactly `manifest.provides` (no missing/extra/undefined entries) and providing plugins must pair a disposer. KEEP note: presence-based readiness and live-registry soft resolution are correct as decided and must survive re-derivation.

## Verification

**Commands:**
- `pnpm -r typecheck` -- expected: zero errors
- `pnpm -r test` -- expected: all suites green including new lifecycle suites
- `pnpm -r lint` -- expected: zero warnings

## Suggested Review Order

**Kernel lifecycle surface**

- Entry point: container API and documented semantics
  [lifecycle.ts:61](../../packages/kernel/src/lifecycle.ts#L61)

- Dependency-ordered activation with containment
  [lifecycle.ts:209](../../packages/kernel/src/lifecycle.ts#L209)

**Disposal & swaps**

- Reverse-order teardown, per-plugin dispose, contained disposal errors
  [lifecycle.ts:62](../../packages/kernel/src/lifecycle.ts#L62)

- Validate-then-commit swap with coverage invariant
  [lifecycle.ts:64](../../packages/kernel/src/lifecycle.ts#L64)
