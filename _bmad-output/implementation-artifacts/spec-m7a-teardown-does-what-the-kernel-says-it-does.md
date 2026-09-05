# Spec M7.A — the kernel's teardown does what the kernel says it does

**Status:** FROZEN
**Implements:** three defects found by comparing panda's kernel against cordis (`planning-artifacts/research/cordis-spatiotemporal-composability-2026-09-01/research.md`); no FR — this is the kernel keeping promises it already makes
**Created:** 2026-09-01

---

## Intent

Panda's recorded defect class is *a guarantee stated in PROSE instead of enforced
by something that FAILS when violated*. Reading cordis's `Fiber` against panda's
`lifecycle.ts` found three places where panda's teardown does not do what panda's
own words say it does — and one of them can take the process down.

None of these is a cordis feature panda lacks. Each is panda's own stated rule,
unenforced.

## The measurement this rests on

Executed on 2026-09-01 at `fcb6f0b`, verified by the author after a subagent
reported it — two of four subagent findings turned out to be redesigns of
deliberate decisions rather than defects, so every claim below was re-read at the
line.

1. **A rejected candidate's disposer is discarded.**
   `packages/kernel/src/lifecycle.ts:279`:
   `if (issues.length > 0) return { reason: pairing ? 'pairing' : 'coverage', issues }`.
   The factory has already run to completion and returned `result.dispose`; that
   value is never called and no reference to it survives. The `pairing` branch is
   harmless by construction (it fires only when `dispose === undefined`); the
   **coverage** branch is the leak — services disagreed with `provides`, so a
   plugin that opened resources and returned a disposer has them stranded.
   Two tests build exactly this shape and assert nothing about it:
   `packages/kernel/test/lifecycle.test.ts:183-193` and `:196-214`. The second is
   worse: a rejected **swap** candidate leaks while the previous implementation
   keeps serving.

2. **Plugin disposal is typed synchronous, so panda's own plugins fire-and-forget
   real async teardown.** `lifecycle.ts:56` declares `readonly dispose?: () => void`.
   Consequences measured in shipped code:
   - `packages/registry/src/plugin.ts:119` — `void store.dispose()`, **no catch**.
     `RegistryStore.dispose()` is `async` (`packages/registry/src/store.ts:276`)
     and its own comment says it *"waits for all in-flight mutations"*. So
     `kernel.stop()` can resolve while a registry write is still in flight, and a
     rejection there is an **unhandled rejection that terminates the process**.
   - `packages/workspace-local/src/plugin.ts:172-178` — the same shape, but with
     a `.catch()` and a reasoned comment. Correct for THAT provider; the comment
     argues from what `LocalWorkspaceProvider.dispose()` happens to do, not from
     the contract, and `WorkspaceProvider.dispose(): Promise<void>`
     (`packages/contracts/src/workspace.ts:28`) lets a third party's provider have
     real teardown the kernel structurally cannot await. panda ships SDK-first
     (FR-29), so "fine for our two providers" is not the same as fine.

3. **The bus stays open across the disposer loop and is never drained again.**
   `lifecycle.ts:378-411`: `await bus.drain()` → `await drainLog()` → the disposer
   loop → `record kernel.stopped` → `bus.close()` → `await drainLog()`. A disposer
   CAN emit (the bus is not closed yet), and its listeners' async continuations
   are never drained, so their failures never reach `handlerFailures`.

   **Correcting the subagent that reported this:** the comment at `:411` reads
   *"stop() resolves quiescent: nothing teardown **recorded** is still pending"*
   and is scoped to the record stream, which `drainLog()` does drain. The comment
   is accurate. The hole is real and separate — no test covers it, and no shipped
   disposer emits, so it is latent rather than active.

4. **Control for the zeros above.** `grep -c "dispose" packages/kernel/src/lifecycle.ts`
   → **43**; `grep -n "\.swap(" packages/*/src` → **0 production callers**, every
   hit is in `lifecycle.test.ts`. So `swap()` has no production consumer, which is
   what makes D2 affordable.

## Boundaries & Constraints

- **AD-1** — the kernel keeps zero runtime dependencies and never imports
  `@skanl/panda-contracts`. Nothing here needs either.
- **AD-2** — no new package, no new dependency. Changes land in
  `packages/kernel/`, `packages/registry/`, `packages/workspace-local/`.
- **AD-5** — typed absence over silence. A teardown that did not finish is not a
  teardown that finished.
- **AD-7** — coded errors. **No new error code**: a failed disposer already lands
  in `DisposalFailure` / `SwapResult.disposalError`.
- **Every `guard.test.ts` stays green UNMODIFIED.** A red guard is a finding about
  this design, not a file to adjust.
- All artifacts in English; relative imports carry `.ts`.

### D1 — the rejected candidate is disposed, and its teardown failure is reported

`runCandidate` calls `result.dispose?.()` before returning a `coverage` or
`pairing` rejection, contained. A throw there is appended to `issues` rather than
replacing them: the author needs to know both that their services did not match
AND that their cleanup failed, and the second must not hide the first.

The disposer currently runs **zero** times, so calling it once cannot break a
passing test — which is what makes this the cheapest of the three.

### D2 — disposal may be asynchronous, and `stop()`/`dispose()` await it

`PluginFactoryResult.dispose` widens to `() => void | Promise<void>`. `stop()` and
`dispose()` are already `async` and simply `await` it, so `stop()` resolves
genuinely quiescent for plugin teardown rather than only for the record stream.

`registry`'s and `workspace-local`'s disposers then RETURN their provider's
promise instead of voiding it. That deletes the unhandled-rejection hazard at
`registry/src/plugin.ts:119` outright — it becomes the kernel's contained
`DisposalFailure` instead of a process-level crash.

**`swap()` stays synchronous.** It has no production caller (measurement 4), and
making it async is a breaking change to a published surface for a path nothing
takes. It attaches a `.catch()` to a thenable previous disposer so a rejection is
recorded rather than floating, and its docblock states that an async previous
teardown is not awaited. Recorded in `deferred-work.md` with the upgrade path
rather than left as an omission.

### D3 — the bus is drained again after the disposer loop

One `await bus.drain()` between the loop and `bus.close()`, with its failures
appended to `handlerFailures`. Additive: with no shipped disposer emitting, it is
a no-op today and cannot break a passing test, and it closes the window before
something starts using it.

**Rejected alternative, and why:** closing the bus BEFORE the loop, so a disposer
that emits is refused (cordis's posture — a disposed context refuses `ctx.on`).
It is the stricter rule and it changes behaviour for a case panda has never
exercised, on the same commit that changes disposal timing. Draining is the
smaller step that makes the window observable; refusing it can follow once
something is measured to want it.

### D4 — not in this story

No `ctx.effect()` primitive (refused with reasoning in `deferred-work.md`, M5.D).
No re-activation of `unready` plugins — measured as a DELIBERATE decision, not a
gap: `lifecycle.ts:339` carries *"A plugin activates at most once; its failure (if
any) is reported once ever"* and `lifecycle.test.ts:412-431` pins it. No
`{kind:'absent'}` reason discriminant and no every-violation manifest validation:
both are real and both are additive author-facing surface, which is a different
story from fixing what is false.

## I/O & Edge-Case Matrix

| # | Input / state | Expected behaviour |
|---|---|---|
| 1 | `start()`, factory returns services that do not match `provides`, plus a disposer | the disposer RUNS exactly once; the plugin still fails to start with the coverage issues |
| 2 | the same, where the disposer throws | start still fails; the message carries BOTH the coverage issues and the teardown failure |
| 3 | `swap()` rejected for coverage, candidate returned a disposer | the candidate's disposer runs; the previous implementation still serves |
| 4 | `pairing` rejection (`provides` non-empty, no disposer) | unchanged — there is nothing to call |
| 5 | a plugin whose disposer returns a promise, `stop()` | `stop()` does not resolve until that promise settles |
| 6 | that promise REJECTS | the rejection is a `DisposalFailure` in `StopResult.disposalErrors`, not an unhandled rejection |
| 7 | the same through `dispose(pluginId)` | same containment; the plugin still ends `disposed` |
| 8 | a synchronous disposer | unchanged in every observable way, including ordering |
| 9 | two plugins, one async disposer and one sync | reverse activation order is still exact — the async one is awaited before the next runs |
| 10 | a disposer that emits on the bus, with an async listener that rejects | the failure appears in `StopResult.handlerFailures` |
| 11 | `swap()` whose previous disposer returns a rejecting promise | recorded, not floating; `swap()` still returns synchronously |
| 12 | `kernel.stop()` twice | unchanged; the second is the same settled result |

Row 6 is the one that is a live crash today. Row 9 is the one that would be
silent: awaiting inside a loop is easy to write as `map` + `Promise.all`, which
would destroy the reverse-order guarantee `lifecycle.test.ts:65-77` pins.

## Code Map

```
packages/kernel/src/lifecycle.ts
  ~ PluginFactoryResult.dispose  -> () => void | Promise<void>
  ~ RuntimePlugin.disposer       -> same
  ~ runCandidate                 + dispose the rejected candidate (D1)
  ~ stop()                       + await the disposer; + one bus.drain() after the loop (D2, D3)
  ~ dispose(pluginId)            + await the disposer (D2)
  ~ swap()                       + catch a thenable previous disposer (D2)
packages/registry/src/plugin.ts        ~ return store.dispose() instead of voiding it
packages/workspace-local/src/plugin.ts ~ return provider.dispose() instead of voiding it
packages/kernel/test/lifecycle.test.ts + rows 1-3, 5-11
_bmad-output/implementation-artifacts/
  deferred-work.md   + swap()'s synchronous teardown, with its upgrade path
  sprint-status.yaml + m7a
```

## Tasks & Acceptance

- [x] T1 — D1: dispose the rejected candidate, contained, issues appended (rows 1-4).
- [x] T2 — D2: widen the disposer type; `await` in `stop()` and `dispose()`; keep reverse order exact (rows 5-9).
- [x] T3 — D2: `swap()` catches a thenable previous disposer (row 11); docblock states it is not awaited.
- [x] T4 — the two shipped plugins return their promise instead of voiding it.
- [x] T5 — D3: one `bus.drain()` after the disposer loop, failures appended (row 10).
- [x] T6 — tests for every matrix row; row 9 must FORCE the interleaving, never time it.
- [x] T7 — `deferred-work.md` + `sprint-status.yaml`.
- [x] T8 — gate green on Node 24 **and** Node 26, **plus** `pnpm build && pnpm proof:consumer-install` (§4 of the handoff: `pnpm check` is not the CI gate). No `guard.test.ts` edited.

**Done means:** the gate is green on both Node versions and the consumer-install
proof passes; every matrix row has a test; and rows 1, 5, 6 and 9 each fail when
their guard is removed.

### The falsification must be per rule

Rows 1, 6 and 9 are three independent guards and two of them are invisible when
they fail: a leaked disposer and a lost async teardown both exit 0 today. Remove
each alone and name the test that dies. Row 9 in particular: a `Promise.all`
refactor of the disposal loop passes rows 5-8 and destroys ordering, so the
ordering row must die on that exact mutation.

## Ask First

Stop and ask rather than deciding:

- Any **new** `PANDA_*` error code (the Boundaries say none is needed).
- Making `swap()` async, or any other breaking change to a published signature.
- Closing the bus BEFORE the disposer loop (D3 rejected it for this story).
- Editing any `guard.test.ts`.
- Touching a third plugin, or any plugin's behaviour beyond returning the promise
  it already creates.

## Spec Change Log

- 2026-09-01 — frozen at `fcb6f0b`. Two of four subagent findings were discarded
  after the author re-read the lines: unready-plugin re-activation is a
  deliberate documented decision, and the `stop()` "quiescent" comment is scoped
  to the record stream and accurate. Both are recorded in the measurement section
  so the next reader does not re-derive them.

## Verification

Executed on 2026-09-01, not inferred.

### The gate — including the half `pnpm check` does not run

- bytes clean; `pnpm typecheck` **10/10 Done**; `pnpm lint` no issues.
- `pnpm build && pnpm proof:consumer-install` — **8 passed / 1 skipped**. Run
  BEFORE pushing this time, which is §4 of the handoff applied rather than
  re-learned.
- Suites (live files excluded — the known local `skills-discovery.live` red):

  | package | result |
  |---|---|
  | kernel | **239 passed** (was 229, +10) |
  | registry | **69 passed** (was 68, +1) |
  | workspace-local | 23 passed |
  | contracts 142 · projection 256 · session 98 · environment 100 · workspace-git-worktree 13 · adapter-cli 147 · cli 122 | unchanged |

- **Node 26.8.1 canary** — kernel 239, registry 69, workspace-local 23.

### Falsification — five guards, five killed, per rule

| Mutation | Killed |
|---|---|
| the rejected candidate is not disposed | 3, incl. both the start and the swap rows |
| the teardown failure is not appended to `issues` | 1: `reports a teardown failure BESIDE the coverage issues` |
| `stop()` does not await the disposer | 3, incl. `keeps reverse activation order exact when a disposer is asynchronous` |
| the post-loop `bus.drain()` removed | 1: `drains listener continuations a disposer started` |
| the registry plugin voids its promise again | 1: `does not resolve stop() until the store has finished disposing` |

**The harness needed correcting mid-run, and that is worth recording.** Its first
two mutations were syntactically invalid, so the suite failed to compile and the
harness scored a "kill" that proved nothing — the same class of lie M5.B's
harness told by a different route. Both were rewritten as valid substitutions and
re-run; the table above is the corrected run, with no compile-error kills in it.

**The registry fix had ZERO coverage when first written**, and the harness is
what said so (`0 killed`, honestly reported rather than skipped). That is the
change which removes a live unhandled-rejection hazard, so shipping it unguarded
would have been this project's own defect class. `packages/registry/test/plugin.test.ts`
gained the test the row above now names.

### The discriminating assertion, twice

Two tests here would have passed WITHOUT the fix if written the obvious way:
gating a disposer and asserting it has not finished proves nothing, because the
gate holds it shut either way. What discriminates is asserting that **`stop()` is
still pending** while the gate is shut, after `setImmediate` has drained the whole
microtask queue. Both the kernel row and the registry row are written that way.

### What is NOT verified here

`swap()` still does not await an async previous disposer — contained, never
awaited, recorded in `deferred-work.md` with its upgrade path. No `ctx.effect()`.
No unready-plugin re-activation (a deliberate decision, not a gap). No
`{kind:'absent'}` reason and no every-violation manifest validation: both real,
both additive author-facing surface, and both a different story from fixing what
is false.
