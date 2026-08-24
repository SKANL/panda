---
title: 'Scoped event bus and layered configuration'
type: 'feature'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 0
baseline_commit: '9cf86ac51681838bd766306fd1a3972c03213146'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-2-injection-disposal-and-atomic-swaps.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Concurrent agent sessions cannot isolate their events, and configuration composition is invisible: there is no way to see which layer supplied a value, and nothing prevents a narrow scope from clobbering a wider one.

**Approach:** Add a synchronous scoped event bus (`global | project | agent`) with ordered fan-out and drained shutdown, plus layered config resolution (defaults → global → project → agent → invocation) with deep-merge and a diagnostic dump showing the originating layer per key.

## Boundaries & Constraints

**Always:** event fan-out is synchronous and ordered within scope; each listener's errors are contained per-listener (one rejection never breaks siblings); handlers never synchronously re-emit during fan-out (typed violation); kernel stop drains pending handler continuations BEFORE unwinding registrations; agent-scoped listeners receive only their own agent's events; config resolution is pure over immutable layer snapshots — setting an agent/project-scoped value NEVER mutates wider-scope state; the diagnostic dump shows composed values with originating layer per key. New failure codes join `KERNEL_ERROR_CODES` + contracts parity pins. Existing guards (zero deps, no contracts import) stay green.

**Ask First:** any persistence of config to disk (file-backed layers are NOT this story); any async bus mode.

**Never:** no projection sentinel grammar or file writing (Epic 2 owns sentinels); no wildcard/global event subscription for agent listeners; no speculative middleware/pipeline stages on the bus.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Agent isolation | Two agents emit interleaved events; each holds an agent-scoped listener | Each listener observes exactly its own agent's subset, in emission order | N/A |
| Scope visibility | Global-scoped listener vs agent emissions | Global listener sees ALL events incl. every agent's | N/A |
| Handler rejection | One listener throws mid-fan-out | Remaining listeners still run; error contained to that listener | Contained per-listener |
| Re-emit during fan-out | Handler emits synchronously into the same bus | Typed coded rejection naming the rule | Coded error |
| Config override trace | Same key set at defaults/global/agent | Composed value = narrowest; dump shows originating layer per key | N/A |
| Cross-scope safety | Set a value at agent scope | Wider layers (global/project/defaults) remain byte-identical | N/A |
| Drained shutdown | Listener awaiting continuation while kernel stops | Kernel drains pending continuations before disposing plugins | N/A |

</frozen-after-approval>

## Code Map

- `packages/kernel/src/lifecycle.ts` -- createKernel owns start/stop; bus + config mount here so stop() drains before disposal unwind
- `packages/kernel/src/events.ts` -- NEW: scoped bus (subscribe/emit per scope id), ordered sync fan-out, re-emit guard, drain support
- `packages/kernel/src/config.ts` -- NEW: layer stack resolution, deep-merge, `dumpConfig()` with provenance
- `packages/kernel/src/errors.ts` -- extend codes minimally (re-emit violation; invalid scope)
- `packages/contracts/test/kernel-code-parity.test.ts` -- pin new codes
- `packages/kernel/test/events.test.ts`, `packages/kernel/test/config.test.ts` -- NEW suites locking matrix rows

## Tasks & Acceptance

**Execution:**
- [ ] `packages/kernel/src/errors.ts` -- add minimal codes (e.g. `REEMIT_DURING_FANOUT`, `INVALID_SCOPE`) -- stable identities for new failure modes
- [ ] `packages/kernel/src/events.ts` -- scoped bus with sync ordered containment fan-out + drain -- FR-4/AD-8 core
- [ ] `packages/kernel/src/config.ts` -- layered deep-merge resolution + provenance dump -- FR-5 core
- [ ] lifecycle integration -- kernel exposes bus+config; stop drains first -- shutdown ordering guarantee
- [ ] parity suite + tests -- pin codes; lock all matrix rows -- regression protection

**Acceptance Criteria:**
- Given two concurrent agent sessions emitting interleaved events, when each holds an agent-scoped listener, then each observes exactly its own subset in order
- Given the composed config after multi-layer overrides, when the dump runs, then it prints values with originating layer per key
- Given an agent-scope override, then no wider-scope layer state changes
- Given a handler that throws mid-fan-out, then sibling listeners still complete
- Given kernel stop with pending handler continuations, then drain completes before disposers run

## Spec Change Log

## Verification

**Commands:**
- `pnpm -r typecheck` -- expected: zero errors
- `pnpm -r test` -- expected: all suites green including new events/config suites
- `pnpm -r lint` -- expected: zero warnings
