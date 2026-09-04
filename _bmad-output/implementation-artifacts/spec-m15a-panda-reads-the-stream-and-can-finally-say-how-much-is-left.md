# Spec M15.A — panda reads the stream, and can finally say how much is left

**Status:** FROZEN
**Story:** reopens and implements **5-6 (environment status with read-only quota
surfacing)**, whose row says "REOPEN the day a vendor publishes a documented
usage endpoint, and only then". That day arrived and was measured. Carries the
prerequisite both 5-6 and 2-6 share: panda reads Claude Code's EVENT STREAM
instead of its single-result object.
**Base commit:** `fc6a693`

---

## Intent

Story 5-6 was closed twice, and the second closure was emphatic: `DO NOT
SCHEDULE`, "blocked on the industry, not on panda". The evidence was real —
panda read no rate-limit surface, and DeepSeek Harness, a shipped ~50-package
agent harness, reads no `x-ratelimit-*` header anywhere, calls no usage endpoint,
and classifies quota against rate-limit by regex over provider error prose.

That evidence was about HTTP headers and provider endpoints. It was never about
the executor CLI's own output stream, and that is where the surface turned out to
be. Claude Code emits a typed `rate_limit_event` carrying per-window utilisation.

**This is the third deferral this session whose REASON expired while its ledger
entry did not notice** — after M9.A's D8 ("the medium is not the filesystem",
false) and this coordinator's own D4 ("the bytes would be the same", false). The
reusable rule is now earned three times over: **re-measure the reason, not the
entry.**

## The measurement this rests on

Executed 2026-09-03 at `fc6a693` by RUNNING the real binaries, every zero with a
control.

| # | Claim | Evidence |
|---|---|---|
| M1 | Claude Code emits a typed quota surface in its own stream | `claude --print --output-format stream-json --include-hook-events --verbose` emits `rate_limit_event` carrying `rate_limit_info`: `status`, `rateLimitType`, `resetsAt`, `overageStatus`, and `unifiedWindows` with `five_hour` → `{utilization: 0.12, resetsAt}` and `seven_day` → `{utilization: 0.22, resetsAt}`. |
| M2 | Panda cannot see it today, and that is WHY 5-6 looked blocked | `packages/adapter-cli/src/executors/claude-code.ts:55` passes `--print --output-format json`. That mode's top-level keys were dumped in full: `duration_api_ms, stop_reason, session_id, total_cost_usd, usage, modelUsage, …` — **no `rate_limit_info`, no `unifiedWindows`**. The whole key list is the control: the search saw the object. |
| M3 | `--verbose` is REQUIRED and does not pollute stderr | `stream-json` without it exits **1** with "Error: When using --print, --output-format=…". With it, exit **0** and stderr carries only a stdin warning caused by the measurement's own unredirected stdin, not by the flag. |
| M4 | The stream's terminal event carries what the single-result mode carries | The stream's `result/success` event holds `duration_api_ms`, `stop_reason`, `session_id`, `total_cost_usd`, `usage`, so the existing envelope is buildable FROM the stream rather than rebuilt. |
| M5 | The other two executors advertise no usage surface | `codex --help` and `opencode --help` show no usage, quota or rate-limit output mode. Their event streams are already parsed by panda (`turn.completed`, `step_finish`) and the 5-6 row's earlier measurement found the only `usage` hits to be per-run token accounting. |
| M6 | 2-6 shares this prerequisite | Claude also streams `system/init`, `assistant`, `result/success` and three `hook_*` events. Story 2-6's lifecycle vocabulary is reachable from the same stream. It is NOT in this story, but it is why the prerequisite is not speculative. |

---

## Boundaries & Constraints

### D1 — this is NOT screen scraping, and the distinction is the story's licence

FR-10 and story 2.6 forbid screen scraping; the 5-6 row warned that anything less
than a documented surface "is the screen-scraping 2.6 forbids under a different
name". Reading `rate_limit_event.rate_limit_info.unifiedWindows.five_hour.utilization`
out of a structured JSON event the vendor emits deliberately, under a flag the
vendor documents, is the opposite of scraping: it is correction-01's own rule —
NATIVE vocabulary at a NATIVE location — applied to READING rather than writing.

Panda renders the vendor's numbers in the vendor's words and invents nothing.

### D2 — the stream change ships WITH its consumer, never alone

Switching the claude adapter to `stream-json` produces no user-visible change by
itself: the envelope must stay identical. A capability with no reachable
consumer is this project's most expensive defect class and it has shipped three
times. So the adapter change and `panda status` land together.

### D3 — the envelope is built FROM the stream's terminal result, not rebuilt

M4 measured that the stream's `result/success` event carries the same fields the
single-result mode returns. The existing `ResultEnvelope` construction is fed
from that event. Any field the stream does not carry is a finding to report, not
a value to invent.

### D4 — quota is TYPED ABSENCE, not an empty string

AD-5. An executor that emits no usage surface reports absence with its reason —
"this executor publishes no usage surface" — never a blank row, never a zero, and
never an error. The 5-6 acceptance says "unsupported executors show no quota row
rather than erroring"; a row that shows `0%` for an executor panda cannot measure
is worse than no row, because it is a measurement that was never taken.

### D5 — what panda reports is what the vendor said, at the vendor's own grain

`unifiedWindows` has named windows (`five_hour`, `seven_day`) with their own
`resetsAt`. Panda reports the windows the vendor names. It does not average them,
does not pick one, does not convert a utilisation into a "remaining" figure the
vendor did not state, and does not turn a reset timestamp into a duration that
starts drifting the moment it is printed.

### D6 — `panda status` writes nothing

It is a report. It opens no store for writing, projects nothing, and its exit
code follows `doctor`'s convention rather than inventing a third: 0 when it could
report, non-zero only when it could not produce a report at all.

### D7 — a quota reading is per-EXECUTOR and costs a run, so it is not taken silently

`rate_limit_event` arrives during a real invocation. `panda status` must not
secretly spend a user's quota to report on their quota — a report that costs the
thing it reports on is a trap, and it would make `status` unrunnable on exactly
the day a user most wants it.

**DECIDED, so the implementer is not blocked on it:** the observation is RECORDED
by the run that produced it, and `status` READS that record. A run panda drove
already paid for the number; writing it down costs nothing more, and it makes
`status` answer instantly and offline.

The record is an OBSERVATION, not a measurement panda owns: it carries the
vendor's values verbatim plus WHEN they were observed, because a utilisation is
only true as of its reading and a report that hides its age is a report that
lies with a straight face. Where no observation exists, `status` says so and
names the command that would produce one (E4). It never invokes an executor
itself — that half is not a choice.

### D8 — not in this story

- **Story 2-6.** The lifecycle events are visible from the same stream and that
  is recorded as M6, but mapping `started/working/idle/exited` across three
  executors, with the PTY/OSC fallback its AC names, is its own story.
- Any change to codex or opencode's invocation. They keep the modes panda
  verified for them.
- Any billing, cost projection, or "time remaining" arithmetic.
- Any write of any kind from `status`.

---

## I/O & Edge-Case Matrix

| # | Input / state | Expected |
|---|---|---|
| E1 | A claude run that emits `rate_limit_event` | The windows the vendor named, with their utilisations and resets, reported verbatim. |
| E2 | A claude run that emits none | Typed absence with its reason; never a zero. |
| E3 | codex / opencode | Absence with "publishes no usage surface"; no row invented, no error. |
| E4 | `panda status` with no prior observation | Says so, and names the command that would produce one (D7). |
| E5 | The stream ends without a `result` event | Coded failure naming what was missing — the run produced no envelope, which is different from a run that failed. |
| E6 | A malformed line inside the stream | Skipped and REPORTED; one bad line must not discard a completed run. |
| E7 | `stream-json` invoked without `--verbose` | Cannot happen — the adapter passes both, and a clause pins that it does, because M3 measured that omitting it exits 1. |
| E8 | The envelope from the stream vs the envelope from the old mode | Identical for the same run: same `ResultEnvelope` fields, same exit semantics. |
| E9 | An executor whose binary is absent | Unchanged from today's behaviour; this story does not touch detection. |

---

## Code Map

- `packages/adapter-cli/src/executors/claude-code.ts` — the invocation moves to
  `--output-format stream-json --verbose`, with the measurement recorded in the
  comment beside it the way the current mode's is.
- `packages/adapter-cli/src/traits.ts` — the claude stream is parsed the way the
  other two already are; the terminal `result` event feeds the envelope; the
  `rate_limit_event` is surfaced.
- `packages/contracts/src/executor.ts` — a typed usage-observation shape, with
  absence and its reason.
- `packages/cli/src/run.ts` — `panda status`.
- `AGENTS.md` — nothing, unless a rule changes.

---

## Tasks & Acceptance

- [x] The claude adapter reads `stream-json`, envelope unchanged
- [x] The vendor's usage observation surfaced as a typed value with typed absence
- [x] `panda status`, reporting per executor
- [x] The two executors with no surface report absence with a reason

**Acceptance Criteria:**

1. **`panda status` prints a real utilisation from a real claude run**, in the
   vendor's own window names, verified by driving the binary — not a fixture.
2. **The envelope did not change.** The same prompt through the new mode produces
   the same `ResultEnvelope` shape and exit code as before, proven against the
   old mode rather than asserted.
3. **Absence is typed and reasoned** for codex and opencode: a clause that FAILS
   if either reports a zero, a blank, or an error instead of a stated absence.
4. **`panda status` invokes no executor**, proven by a run that would have to
   spend quota if it did (D7).
5. **A malformed stream line does not discard the run** (E6), planted.

---

## Ask First

- Anything that makes `panda status` invoke an executor (D7 decided the rest;
  this half stays forbidden).
- Any derived figure the vendor did not state — remaining time, cost projection,
  an averaged utilisation.
- Any change to codex's or opencode's invocation modes.
- Any change to `ResultEnvelope`'s existing fields.

---

## Spec Change Log

0. Frozen at `fc6a693`. Reopens 5-6 on measured evidence that its own stated
   reopen condition — a vendor publishing a documented usage surface — is met.

---

## Verification

Every claim below was produced by RUNNING something. Three live `claude`
invocations were spent in total, all on a one-word prompt.

### The acceptance criteria, by execution

| AC | Where | What was executed |
|---|---|---|
| 1 | `packages/cli/test/status-live.test.ts` | One real `panda run` through the production path (no injected adapter, no injected spawner), then `panda status`. It asserts absence BEFORE the run so the observation cannot be something already there, then reads the vendor's own window names and numbers back off both stdout and stderr. Green in 9.5s. |
| 2 | `packages/adapter-cli/test/stream-mode-live.test.ts` | The pre-M15.A trait record is reproduced as DATA in the test and both records are run against the real binary on the same prompt. Key set, per-value types, `data` key set, `data` value types, status, error count and the exit code the CLI's ternary computes are compared. Values cannot be (session ids and token counts differ between any two runs). Green in 20.8s. |
| 3 | `packages/session/test/usage.test.ts` and `packages/cli/test/status.test.ts` | The clause fails on all three wrong answers separately: an ERROR would not have resolved, a BLANK is refused by asserting the stated reason, and a ZERO is refused by asserting no row anywhere carries a `utilization` at all. |
| 4 | `packages/cli/test/status.test.ts` | `node:child_process` is patched and `panda status` reaches it zero times — WITH a control in the same clause that drives a real `panda run` through the same patch and sees exactly one spawn, so the zero is a measurement and not "I did not look". A second clause snapshots both scope directories and finds them unchanged (D6). |
| 5 | `packages/adapter-cli/test/usage-windows.test.ts` and `test/executor-suite.ts` | A malformed line is PLANTED between the quota event and the result — the position that matters — and the run still returns its result, its metadata and its observation, with `malformedStreamLines: 1` in `data`. The shared clause plants two mid-stream for every jsonl executor. |

### What the plants reddened, one clause each

- A `system` event with `subtype: "error_hook_timeout"` beside a successful
  result: without `failureWhen` this returns a FAILED envelope for a run the
  vendor completed. It reddens exactly
  `reads Claude's failure vocabulary off the RESULT and off nothing else`, and
  its control (a real `result/error_max_turns`) proves the narrowing did not make
  the failure path unreachable.
- A malformed line mid-stream: reddens
  `keeps a completed run when a malformed line lands mid-stream, and counts it`
  and nothing else — the run, the metadata and the reading all survive it.
- Four inert `usageWindows` records (empty discriminator path, empty window
  path, empty utilisation key, empty reset key): each is refused at
  construction, with the shipped record as the control that the rejections are
  not rejecting everything.

### Measurements taken during implementation, and what changed because of them

- **`--include-hook-events` is not needed.** The spec's M1 command carried it;
  re-run without it, the stream still emits `rate_limit_event`. Panda does not
  pass it.
- **`resetsAt` is a NUMBER** (Unix epoch seconds) and `utilization` is a
  FRACTION, not a percentage. Both are typed and reported verbatim; nothing
  scales either.
- **`--verbose` really is required**, re-verified: without it the binary exits 1
  printing the requirement. It costs no quota, because the refusal is argument
  validation.
- **`failureWhen` had to be added.** Not in the Code Map, and it is what makes
  E8/AC-2 true: the single-object mode had ONE record, so Claude's failure
  vocabulary could only ever be read off the result. The stream carries nine
  other records with a `subtype` of their own.

### Gate

`check-source-bytes`, `typecheck`, every package's suite (`--exclude
"**/*live.test.ts"`), `lint`, `build` and `proof:consumer-install` all green on
Node 24.14.1 and Node 26.8.1. Three suites needed updating and each is a real
consequence rather than a fixture repair: the claude argv is pinned in four
places (adapter suite, session, CLI, and the packed-tarball proof), and two
shared fixtures had to become two lines because Claude's stream now
discriminates its result on `type == "result"` while the other two vendors
discriminate theirs on other values of that same key.

---

### Coordinator verification, on top of the implementer's

**AC1, driven, with panda's state isolated and the child's auth intact.** The
first attempt was INCONCLUSIVE and the reason is worth keeping: repointing `HOME`
to a sandbox breaks Claude Code's authentication, so `panda run` exited 1 and
there was no reading to record. The split that works is `runPanda`'s own
`homeDir` option for panda's state while `process.env` — and therefore the
child's `HOME` — stays real, which is exactly what
`node-child-spawner.ts` already documents about per-user executor state. With
that split:

```
"observedAt": "2026-09-04T02:53:23.082Z",
"windows": [
  { "name": "five_hour", "utilization": 0.18, "resetsAt": 1788491400 },
  { "name": "seven_day", "utilization": 0.23, "resetsAt": 1788728400 }
]
```

The vendor's own window names, real numbers, and WHEN they were read. The
`five_hour` figure had been 0.12 in the measurement this spec was written from
and is 0.18 here, because the session spent quota in between — a live number, not
a fixture.

**The typed absence proved itself before the payoff did.** The inconclusive run
was not wasted: across it, `panda status` reported THREE distinct absences
correctly — `PANDA_USAGE_NOT_OBSERVED` before any run and naming the command that
would produce one, `PANDA_USAGE_NO_SURFACE` for codex and opencode, and
`PANDA_USAGE_NOT_REPORTED` after a run that produced no reading. Three states
that a single blank row or a zero would have flattened into one. That is AD-5
doing visible work.

**A PLANT THE IMPLEMENTER DID NOT TRY, aimed at D5's exact risk.** Every fixture
in this story comes from the two windows the vendor emits today, so a
`five_hour`/`seven_day` pair hardcoded anywhere would pass every one of them. The
coordinator fed a fabricated stream carrying a THIRD window no vendor emits —
`thirty_day` — through the real adapter with an injected spawner:

```
window names reported: five_hour, seven_day, thirty_day
verbatim: {"name":"thirty_day","utilization":0.33,"resetsAt":333}
```

Reported verbatim, values untouched. D5's "report the windows the vendor NAMES"
holds under an input the code was not designed around, which is the only kind of
input that can prove it.

**The gate**: bytes 0, typecheck 12/12, lint 0, **1,501 tests green on Node 24
AND Node 26.8.1** across twelve packages (1,462 before), build 12/12, and
`proof:consumer-install` 10 passed / 1 skipped.

**Live quota spent by the coordinator: 2 billed invocations** — one that failed
on the auth trap above, one that produced the reading. The plant cost none, which
is the point of feeding a fabricated stream through the real adapter.

