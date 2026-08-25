---
title: 'Kernel-owned observability log'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 1
baseline_commit: 'aa5f15a'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-01-composition-first.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-scoped-event-bus-and-layered-configuration.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** nothing in panda records what happened. AD-4 requires a kernel-owned append-only log *initialised before any plugin loads*, with a fixed failure policy, and NFR-4 requires every model-visible interaction to be reconstructable from it. Neither has a story, and the kernel has no log module at all. Without it, an agent's actions are auditable only through whatever summary the agent chose to emit — which is the thing panda exists not to trust.

**Approach:** one append-only record sink owned by the kernel and taken as a CONSTRUCTOR INPUT of the load path, so "before any plugin loads" is true by construction rather than by documentation. A fixed, typed failure policy: a sink that cannot write enters an observable degraded state and counts what it dropped; it never swallows a record silently and never takes the kernel down with it. The kernel keeps its zero-runtime-dependency rule — no logging library, no levels, no sinks framework.

**Why now (ROADMAP-01 M1):** the kernel has zero production callers today. AD-4's ordering guarantee is about a container other things mount into, so it is cheap now and a breaking API change the moment composition lands.

## Boundaries & Constraints

**Always:** the log is a required input to the plugin load path, so no code path can load a plugin without one — proven mechanically, not by comment; records are append-only and never mutated or reordered; a write failure produces a TYPED degraded state that is observable by the caller and counts dropped records, and the kernel keeps running; the record shape is closed and versioned; writes are serialised so two records can never interleave; secrets never enter a record, and the record shape gives them nowhere to hide; `@panda/kernel` keeps ZERO runtime dependencies and still never imports `@panda/contracts` (AD-1); error codes come from `KERNEL_ERROR_CODES`.

**Ask First:** any log rotation, retention or size policy; any sink other than the in-process one this story defines; emitting log records onto the scoped event bus.

**Never:** no logging library; no severity levels, no formatters, no transports — this is a record sink, not a logging framework; no reading or replaying the log inside the kernel beyond what a test needs; no interception-waterfall records (that is Story 1.7, which feeds this seam).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ordering guarantee | Any kernel start | The log exists before the first manifest is validated; there is no overload that loads without one | Compile-time impossible |
| Lifecycle reconstruction | Plugins load, activate, dispose | The record sequence alone reconstructs the order of those transitions | N/A |
| Sink write fails | Underlying write throws | Typed degraded state, observable, dropped count increments; kernel keeps running | Typed, never thrown at the caller |
| Degraded then recovered | Write fails, later succeeds | State reports it degraded and how many records were lost; recovery does not erase that history | N/A |
| Concurrent records | Two records emitted in the same tick | Both land, in emission order, neither interleaved | N/A |
| Closed record shape | A caller passes an unknown field | Rejected with a coded kernel error naming the field | Coded error |
| Secrets | A record carrying a credential-shaped value | The shape has no free-form payload slot for one; the test pins that | N/A |
| Disposal | Kernel stops | Pending record writes drain before disposers run, as AD-8 requires of lifecycle transitions | N/A |

</frozen-after-approval>

## Code Map

- `packages/kernel/src/log.ts` -- NEW: the closed record shape, the append-only sink, its degraded state, and the in-memory default
- `packages/kernel/src/loader.ts` -- take the log as a required input; record manifest validation and service resolution outcomes
- `packages/kernel/src/lifecycle.ts` -- record activation, disposal and swap transitions; drain the sink before disposers run
- `packages/kernel/src/errors.ts` -- one new code for a rejected record shape
- `packages/kernel/src/index.ts` -- export the sink type and the record shape
- `packages/kernel/test/log.test.ts` -- NEW: the matrix, plus the reconstruction assertion

## Tasks & Acceptance

**Execution:**
- [x] Closed, versioned record shape + coded rejection of unknown fields
- [x] Append-only sink with serialised writes and a typed degraded state that counts drops
- [x] Log as a required input to the load path — no overload can skip it
- [x] Lifecycle and loader transitions recorded; drain before disposers
- [x] Matrix covered, including the mechanical ordering proof

**Acceptance Criteria:**
- Given a kernel starting with any set of plugins, when the first plugin loads, then the log already exists — and no code path can load one without it
- Given a completed run, when the records are read back, then the order of lifecycle transitions is reconstructable from them alone
- Given a sink whose write fails, then the kernel keeps running, the state is typed and observable, and the dropped count is visible
- Given the closed record shape, then there is no free-form slot a secret could occupy

## Spec Change Log

- **Review, the diagnostic broke what it observes (patch, BLOCKER):** twelve unguarded `log.record` sites and four unguarded `log.drain()` awaits meant a caller-supplied sink could abort `start()` mid-activation, and a rejecting `drain()` made `stop()` skip EVERY disposer, never close the bus, and leave the kernel marked stopped without having stopped — plus an unhandled rejection that terminates the process under Node's default. The file already stated the rule three lines away: `logOrder` was wrapped in try/catch under the comment "a throwing diagnostic must never abort activation or teardown". The new mechanism received that guarantee in prose instead of in code. Now one `recordSafely` and one `drainLog` contain all sixteen sites; a direct `sink.record()` caller still gets the raw throw, because that one IS a caller bug.
- **Review, one line defeated three guarantees (patch, BLOCKER):** `instanceof Promise` is realm-specific, so a structurally valid non-native thenable — a worker boundary, a bundled polyfill, a wrapped transport client — was treated as a completed synchronous write. Verified: two records ran with no serialisation, `drain()` resolved claiming quiescence, both writes then rejected, and the sink reported `{status:'healthy', dropped:0}`. Serialisation, drop counting and drain all evaporated together. Replaced with a duck-typed `.then` check through `Promise.resolve`.
- **Review, two Always clauses were documentation standing in for enforcement (patch):** "records are append-only, never mutated or reordered" rested on a `readonly` annotation that is erased at runtime — a reviewer reversed the array and rewrote a record's subject. And "the kernel keeps running" was a comment. Both are now enforced: `records` returns a copy, `seal` freezes each record, and the containment above is real. This story's own Design Notes argue that a guarantee proven by documentation cannot rot; it shipped two clauses with exactly that property, which is the finding worth remembering.
- **Review, the audit trail logged only what worked (patch):** a rejected swap, a swap of an unknown plugin, a swap whose old disposer threw, and a manifest rejected at `register()` all left NO record — the transitions most worth auditing were invisible, and `register()` is the only production path where a bad manifest is actually rejected. `stop()` additionally recorded `plugin.disposed` for a disposer that had thrown, contradicting its own result object. New `plugin.swap-rejected` and `plugin.disposal-failed` events, `register()` records before throwing, and the hardcoded `manifestInvalid` code was replaced by `recordCodeOf` — it had been stamping a validation failure onto a `RangeError` from a throwing getter.
- **Review, the kernel was not the only writer (patch):** `PandaKernel.log` exposed the full sink, so any plugin holding the kernel could forge `plugin.activated` for a plugin that never loaded, and `kernel.stopped`. The reconstruction claim only holds if the kernel is the sole writer. `log` is now a real reader object without `record` — the first attempt was a type annotation over the live sink and `record` stayed callable at runtime, which a test caught rather than review. Plugin ids also reached `subject` verbatim, so a newline in an id forged a second log line in any line-oriented writer; one shared identifier guard now rejects control characters and caps length.
- **Review, `dropped` was never proven to count (patch):** replacing the counter with `if (!everDegraded) dropped = 1` — a boolean wearing a number's clothes — passed the entire suite, because the one test that dropped two records asserted only `> 0`. Exact counts are now asserted, including a five-drop case a boolean cannot satisfy. `state` also lied for async sinks between `record()` and settlement; a `pending` count was added and `status`/`dropped` documented as authoritative only after `drain()`.
- **Review, the mechanical pin, honestly measured (patch):** the `@ts-expect-error` was mutation-tested and DOES catch the weakening a contributor would actually reach for — `log: LogSink = createMemoryLogSink()` produces TS2578 as the only error in the whole typecheck. It does not catch a second unrelated error appearing on the same line, and it cannot see a bypass added beside it. Both were reproduced. The directive is kept and joined by `expectTypeOf(loadPlugins).parameters` and a pin on the package's exported surface, which is what closes the `loadPluginsUnlogged` hole.
- **`orderLog` deleted, not deferred:** it was actively costing coverage — the test named "no duplicate log entries" watched `orderLog`, which never receives `kernel.stopped`, so the test whose name promised this story's invariant did not cover this story's log. All six sites migrated, including two in `packages/registry` the original note had not counted.
- **Repeat offender recorded:** a literal NUL reached a source file for the third time in this session, plus a literal DEL. The byte scan wired into the gate caught the NUL. Both are escapes now.

## Design Notes

**Why a constructor input rather than a module singleton.** `deferred-work.md` already records the cost of the alternative: Story 1.1's "before any I/O" guarantee is *"scoped to kernel-owned code by documentation only; no spy-based test harness proves it mechanically"*. A required parameter makes the ordering a type error to violate, which is the only form of that guarantee that cannot rot.

**Why degraded rather than throwing.** AD-5 already establishes that an individual plugin's failure is contained and the kernel keeps running. A log that takes the process down when a disk fills would be a worse failure than the one it is reporting. But silence is not acceptable either — that is why the state is typed and the drops are counted: the caller can always tell "nothing happened" from "we lost eleven records".

**Why the record shape is closed.** An open payload is where secrets end up. Closing the shape means a credential has nowhere to be written by accident, which is a stronger guarantee than a redaction pass that has to be remembered.

**Deliberately not built.** No rotation, no retention, no levels, no transports. The sink appends typed records and reports whether it is healthy. Everything else can be added by whoever has a real requirement for it.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green
