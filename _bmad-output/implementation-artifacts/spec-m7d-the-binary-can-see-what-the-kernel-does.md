# Spec M7.D — the binary can see what the kernel does

**Status:** FROZEN
**Implements:** the observability gap measured while reading cordis
(`planning-artifacts/research/cordis-spatiotemporal-composability-2026-09-01/research.md`);
no FR — this is panda's only human-facing surface acquiring a reader for a stream
panda already writes
**Created:** 2026-09-01

---

## Intent

Panda's kernel exists to intercept actions: estimate a cost, refuse over budget,
record what happened. It writes a complete, sealed, append-only stream of those
decisions — sixteen event words, monotonic `seq`, two independent loss counters.

And the binary a human runs never holds it. `panda run` calls `runSession`
without a `log`, so the waterfall lands in a memory sink the session builds and
drops on the floor. The product's central mechanism is unobservable from the
product.

Cordis is the prior art for the shape, not the machinery. `ConsoleExporter`
(`packages/logger-console/src/shared.ts:50-93`) is a class whose `export` is one
line — `console.log(this.render(message))` — over a 24-line pure renderer. No
retention, no transport, no service. An exporter is a *render function at the
edge*. That is exactly what `createLogSink(write)` already accepts and nobody
has ever passed it.

## The measurement this rests on

Executed on 2026-09-01 at `bb9f97f`, every claim re-read at the line.

1. **The CLI never holds a sink.** `packages/cli/src/run.ts:285-299` calls
   `runSession` with `prompt`, `configLayers`, `adapterOptions`, `cwd`,
   `createAdapter`, `createProvider`, `onInterrupt`, `onSelection`, `onWarning` —
   and no `log`. CONTROL:
   `grep -rE "LogSink|createLogSink|createMemoryLogSink|\.records" packages/cli/src`
   → **0**, against `runSession` → **3** in the same directory, so the grep reaches
   the files.

2. **`runSession` has accepted a sink the whole time.** `SessionOptions.log?:
   LogSink` at `packages/session/src/run-session.ts:169`, threaded to
   `waterfallSink(log)` at `:506`.

3. **`createLogSink` is the one genuinely unread kernel export.**
   `grep -rl createLogSink packages/*/src packages/*/test`, kernel excluded → **0**.
   CONTROL over the same glob: `createKernel` → `packages/session/src/index.ts`,
   `packages/session/src/run-session.ts`; `createMemoryLogSink` → five files. A
   zero here is a real zero.

4. **`SessionOptions.log` is the WATERFALL, not the kernel's whole stream.**
   `waterfallSink` (`run-session.ts:243-256`): `own.record(entry)` always, then
   `if (entry.event.startsWith('action.')) caller.record(entry)`. The caller sees
   the six `action.*` words; the kernel keeps `manifest.*`, `load.*`, `service.*`,
   `plugin.*`, `kernel.stopped` in an internal memory sink. This is a published,
   three-suite-pinned meaning of the option, and this story does not touch it.

5. **`lostRecordCount` is NOT surfaceable from the CLI, by construction.**
   `packages/kernel/src/log.ts:403` — `const lostRecords = new WeakMap<LogSink,
   number>()`, and `recordSafely` (`:405-416`) counts against *the sink object it
   was handed*. The kernel hands it `waterfallSink`'s wrapper
   (`packages/kernel/src/lifecycle.ts:230`, `log = options.log ??
   createMemoryLogSink()` at `:212`), never the caller's. A CLI sink is therefore
   permanently absent from that WeakMap and `lostRecordCount(cliSink)` is
   structurally `0`. See D4.

6. **`state.dropped` IS reachable, and reads the caller's own sink.**
   `waterfallSink`'s `get state()` returns `caller.state` when a caller exists
   (`run-session.ts:252-254`). `LogSinkState.dropped` is documented authoritative
   only after `drain()` (`log.ts:132-136`).

7. **`cli` cannot import the kernel.** `packages/cli/package.json` dependencies
   are exactly `@skanl/panda-environment` and `@skanl/panda-session`. AD-2 holds: the door
   must open in `packages/session/src/index.ts`, which today re-exports
   `createMemoryLogSink` (`:59`) and the `LogSink` type (`:71`) but not
   `createLogSink`.

8. **An unrecognized `--` token is a usage error.** `parseRunTokens`
   (`run.ts:366-399`) ends with `if (token.startsWith('--')) return { usageError:
   ... }`, so a new flag must be handled above that line or `panda run --trace x`
   exits 2.

## Boundaries & Constraints

### D1 — `--trace` renders `action.*` to stderr, and stdout stays the envelope

`panda run --trace "<prompt>"` builds `createLogSink(record => err(render(record)))`
and hands it to `runSession` as `log`. Every record the session forwards is
written to **stderr** as one line, as it happens.

stdout is the envelope JSON and nothing else (`run.ts:311`). This is the same
invariant `reportSelection` and `onWarning` already respect: everything panda
says *about* the run goes to stderr, and the run's result goes to stdout. A
trace on stdout would break every consumer that pipes `panda run` into `jq`.

### D2 — the renderer is a pure function, and it is the only new vocabulary

`renderLogRecord(record: LogRecord): string`, exported from the CLI module for
test. Fields in emission order, each present only when the record carries it:
`seq`, `event`, `subject`, then `service`, `code`, `cost`. It formats; it decides
nothing. That is cordis's `render` (`logger-console/src/shared.ts:69-93`) with
panda's closed field set instead of a level and a timestamp.

`at` is deliberately omitted: `log.ts:47-49` says ordering comes from `seq` and
`at` is "for humans", but a wall clock in a line a human reads *live* adds noise
without adding order. It is in the record for whoever persists the stream.

### D3 — the sink exists only under `--trace`

Not unconditional. `state.dropped` counts failures of *the write function the
caller supplied*; with no `--trace` there is no write to fail, so an
unconditional sink's counter would be structurally zero and printing it would be
theatre. A branch that cannot fire is not a safety net.

Under `--trace` the same counter means something real and specific: stderr
rejected part of the trace the user asked for (a closed pipe, `EPIPE`). So after
the envelope is printed, `await log.drain()` and, only when `state.dropped > 0`,
one stderr line naming the count. `drain()` before reading is mandatory and
documented at `log.ts:132-136`.

### D4 — `lostRecordCount` is not surfaced, and this is a correction

The handoff's §9 item 3 listed four kernel exports "with no consumer" and
proposed the CLI as the reader for this one. Measurement 5 falsifies it: the
WeakMap is keyed by the sink object `recordSafely` receives, which is always the
session's wrapper. `lostRecordCount(cliSink)` would print `0` on every run
including the runs where the kernel *did* reject its own records — a counter that
reads zero when the thing it counts happened is worse than no counter.

It keeps its real consumer, `packages/session/test/kernel-composition.test.ts:130`.
The correct reader for it is whoever holds the kernel, and the CLI deliberately
holds none (Story M3.B).

### D5 — no `--trace=<prefix>` filter

Cordis filters per exporter and per logger name (`core/src/logger.ts:140-142`).
Panda already filters, one layer earlier and on the right axis: `waterfallSink`
forwards `action.*` only (measurement 4). A prefix flag over an already-filtered
stream would be a filter for one event family. `log.ts:281` states the kernel has
"no levels" on purpose; the closed event vocabulary is the axis, and a second one
would be the mistake that comment exists to prevent.

### D6 — not in this story

The kernel's complete stream (`manifest.*`, `load.*`, `service.*`, `plugin.*`)
stays unreachable from the CLI. Reaching it means either redefining
`SessionOptions.log` — a published option pinned by three suites — or the CLI
holding a kernel, which M3.B removed. Filed, not done.

## I/O & Edge-Case Matrix

| Input | Expected |
| --- | --- |
| `panda run --trace "hi"` | envelope on stdout; one stderr line per `action.*` record |
| `panda run "hi"` | byte-identical to today: no sink, no trace, no extra stderr |
| `panda run --trace --executor codex "hi"` | both flags apply; neither is prompt text |
| `panda run --executor codex --trace "hi"` | same, order-independent |
| `panda run --trace` (no prompt) | usage error, exit 2 — `--trace` is not a prompt |
| `panda run "--trace"` | quoted, so it is still argv `--trace`; usage error today and after |
| `panda run --trace=x "hi"` | `unrecognized option '--trace=x'` — `--trace` takes no value |
| `panda run -h` / `--help` | usage, exit 0, unchanged; USAGE now lists `--trace` |
| stderr write throws under `--trace` | run completes; one line reports the dropped count |
| a run that invokes no action | no trace lines, no dropped line, exit unchanged |

## Code Map

| File | Change |
| --- | --- |
| `packages/session/src/index.ts` | re-export `createLogSink` from `@skanl/panda-kernel`; re-export the `LogRecord` type if not already (`:71` has it) |
| `packages/cli/src/run.ts` | `--trace` in `parseRunTokens` above the `startsWith('--')` refusal; `renderLogRecord`; build and pass the sink; `drain()` + the dropped line; USAGE entry |
| `packages/cli/test/run.test.ts` | the matrix above |

## Tasks & Acceptance

1. Open the door in `@skanl/panda-session` (measurement 7).
2. `renderLogRecord` + its unit clauses.
3. `--trace` parsing, including the four argv orders and the two refusals.
4. Wire the sink, drain, report the dropped count.
5. USAGE.
6. Per-rule falsification, then the gate's **both halves** (`pnpm check`, and
   `pnpm build && pnpm proof:consumer-install`).

### The falsification must be per rule

One mutation per D-rule, each killed by a named clause, and a mutation that does
not compile is reported INCONCLUSIVE, never a kill.

## Ask First

Nothing. Every decision above is settled by a measurement in this file.

## Spec Change Log

- 2026-09-01 — frozen at `bb9f97f`.

## Verification

### The gate — both halves

`node scripts/check-source-bytes.mjs` OK · `pnpm typecheck` clean across all ten
packages · `pnpm lint` (root `eslint .`) exit 0 · **1226 tests pass** across every
package · `pnpm build` Done · `pnpm proof:consumer-install` 8 passed, 1 skipped.

Worth naming: `check` is `bytes && typecheck && test && lint`, so **lint runs
last**. The run that failed on tests never reached it, and lint had to be run
separately rather than assumed from a `check` that stopped early.

### The one excluded suite, and why it is not mine

`packages/projection/test/skills-discovery.live.test.ts` fails 2 of 4 on this
machine, which has 2 of the 3 executor binaries the suite measures against.
Verified pre-existing rather than assumed: `git stash push -u` to a clean `main`,
the same two clauses fail identically, `git stash pop`. Excluded with
`--exclude "**/*live.test.ts"` — the glob that matches both the dot and the dash
form, which an earlier session got wrong.

### Two exact-equality pins caught the widening, in two packages

Neither was found by reading; both were found by a red suite, which is what they
are for.

1. `packages/cli/test/executor-selection.test.ts:164` pins the USAGE first line
   verbatim. Adding `[--trace]` broke it.
2. `packages/session/test/kernel-composition.test.ts:577` pins the package's
   public value surface as an exact array — the pin that exists *because* five
   re-exports were withdrawn on review. `createLogSink` had to be argued into it,
   not appended: it is a function from a write callback to a `LogSink`, it
   composes nothing and reaches no adapter, unlike the withdrawn factories.

### Falsification — five rules, five killed, none inconclusive, control green

Harness at `.scratch/falsify-m7d.mjs` (gitignored). Each mutation applied to
`packages/cli/src/run.ts`, the whole `@skanl/panda-cli` suite run, then the file
restored byte-for-byte.

| Rule | Mutation | Outcome |
| --- | --- | --- |
| D1 | `err(render(...))` → `out(render(...))` | KILLED — *writes the action waterfall to stderr and leaves stdout the envelope alone*, plus two more |
| D2 | `cost` pushed unconditionally | KILLED — *renders only the fields a record carries, in emission order* |
| D3a | the dropped-count line removed | KILLED — *reports a trace it could not fully write rather than truncating in silence* |
| D3b | the sink built unconditionally | KILLED — *is silent without the flag*, plus **three pre-existing clauses** |
| D5 | `token === TRACE_FLAG` → `startsWith` | KILLED — *takes no value, so --trace=&lt;anything&gt; stays an unrecognized option* |

The harness's first run reported every kill as an unnamed "a clause failed"
because its clause-extraction regex did not match vitest 4's output. The verdict
was right and the evidence was missing, which is the shape of a harness that
lies. Corrected, re-run, and D1 additionally confirmed by hand.

D3b is the strongest result in the table: an unconditional sink is killed by
**three clauses that predate this story**, all of which assert an untraced run's
stderr. The conditional was the right call by measurement, not by argument.

### Driven through the real binary, not only through tests

Two of this project's worst defects passed a green suite and were found by
running the binary. The three parsing paths that spend no agent were driven for
real: `panda run --trace` → usage, exit 2 · `panda run --trace=x "hi"` →
`unrecognized option '--trace=x'`, exit 2 · `panda run --trace --executor` →
`option '--executor' requires an executor id`, exit 2 · `panda --help` lists
`--trace` on the usage line and in the `run` block.

### A deslop finding in my own diff

The drain block was first inserted **between the two paragraphs of a pre-existing
comment**, leaving its blank `//` dangling in front of my code and separating
"Inside the try on purpose" from the paragraph it continues. Moved above the
whole comment; the original is contiguous again and still sits with the
`out(...)` it describes.

### What is NOT verified here

That a real executor's run produces a useful trace. Every assertion above runs
through the injected adapter seam, which is where the `action.*` waterfall is
generated regardless — but nobody has watched `--trace` against a live agent.
