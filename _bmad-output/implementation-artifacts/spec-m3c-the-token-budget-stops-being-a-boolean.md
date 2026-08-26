---
title: 'The token budget stops being a boolean'
type: 'feature'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 1
baseline_commit: '92160c6'
context:
  - '{project-root}/_bmad-output/planning-artifacts/ROADMAP-02-the-container-and-the-promise.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-7-tool-call-interception-waterfall.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-m3b-plugins-mount-for-real.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-panda-2026-08-24/correction-01-native-projection.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-10 and NFR-2 require token budgets, loop caps and fan-out limits to be enforced at the interception waterfall and nowhere else. The waterfall shipped in Story 1.7 and M3.B made it kernel-owned, so two of those three budgets work. The token budget does not exist. `SESSION_ACTION_COST` is a flat `1`, so `maxTotalCost` and `maxInvocations` are the same cap wearing two names, and with one action per run all three collapse into a single boolean — "may this session spawn an executor at all". Nothing in the stack counts tokens: no vendor figure is read, `ResultEnvelope` carries none, and the adapters' metadata channel keeps only strings, so a number could not ride it even if one were read.

The deeper reason it does not exist is a shape problem, not an oversight. **A cost must be declared before the operation runs, and the only honest token figure exists after it.** A budget built on a number invented up front is a budget about nothing.

**Approach:** two halves that are useless apart. The pipeline learns to **settle** a cost once the operation resolves — admitted on a declared estimate, reconciled against what actually happened, with the caps enforced on the settled total. And the adapters learn to **report** what the vendor said it spent, extracted through the trait records that already describe every other field of every vendor's output.

**The vendor half is the half that can ship inert.** This project has already paid four stories to learn that: a subsystem whose acceptance criteria are all phrased in panda's own vocabulary passes green while doing nothing, because nothing ever confronts the external tool. Correction-01 wrote the rule for writing into a vendor's file; reading a figure out of a vendor's output is the same exposure. All three binaries are installed on the development machine, so every trait in this story is verifiable against the tool it describes, and a figure that cannot be verified against a real run does not ship as a guess.

**What this story is not.** It is not NFR-1. That requirement is the ≤4KB handoff budget, handoffs are a Workers & Workflows concept, and panda v1 has none — see the correction recorded in ROADMAP-02.

## Boundaries & Constraints

**Always:** the settled cost is what the caps are enforced against, and a refusal still happens BEFORE the executor runs for everything knowable up front; a run whose vendor reports no usage is charged its declared estimate and says so, never silently zero; every usage figure that ships is verified against that vendor's real output, by execution, and the verification names the vendor's own field; `panda run` is behaviour-neutral with no policy set — same envelope, same exit codes, same cancellation, same cleanup, and every existing assertion passes unmodified; the budget is enforced at the waterfall and nowhere else (NFR-2), never by a prompt instruction; a settled cost is observable in the record stream, because a budget whose accounting cannot be read is one nobody can audit.

**Ask First:** a monetary figure (vendors report cost in dollars as well as tokens, and money is a different promise); a budget that spans processes or survives a restart; per-model or per-executor cost weighting; charging anything other than the executor action; changing `ResultEnvelope`'s existing fields.

**Never:** no cost declared by the CALLER of an action — a caller that can price its own run prices it at zero; no cap enforced after the fact only, because a budget that admits everything and complains afterwards has not capped anything; no guessed vendor field — a usage figure ships verified or not at all; no token counting done by panda itself, by estimation or tokenizer, because a number panda invents is the problem this story removes; no behaviour change for a run with no policy set.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No policy | `panda run` with nothing configured | Byte-identical to today except an additive `usage` key on the envelope, and only for a run that reached an executor; exit code and stderr unchanged **[RENEGOTIATED 2026-08-26 by the spec author — see Spec Change Log 0]** | N/A |
| Settlement | An action whose vendor reports usage | The pipeline's total reflects the reported figure, not the estimate | N/A |
| Cap on the settled total | Two runs, the first spending more than its estimate | The second is refused on the settled total | Coded refusal |
| Refusal is still up front | A cap already exhausted | Refused BEFORE the executor spawns | Coded, nothing spawned |
| Vendor reports nothing | An executor that emits no usage | Charged the declared estimate, and the absence is visible | Not silently zero |
| Vendor figure is junk | Negative, NaN, a string, absurdly large | Rejected coded; the estimate stands; nothing is charged twice | Coded |
| Each vendor, verified | Each of the three real binaries | The figure is read from that vendor's own field, proven by a real run | Absent ⇒ no trait |
| Numbers survive the channel | A numeric usage figure | Reaches the envelope; today the metadata channel drops non-strings | N/A |
| Auditability | Any admitted run | The record stream shows what was estimated and what settled | N/A |
| Cancelled or failed run | A run that fails or is cancelled | Settled honestly for what it spent; the cap is not evaded by failing | N/A |
| Concurrency | Two in-flight actions settling out of order | Totals are correct regardless of settle order | N/A |
| Caps stay distinguishable | A cost cap and an invocation cap on the same pipeline | They can now refuse on different runs, and each refusal names its own code | Coded |

</frozen-after-approval>

## Code Map

- `packages/kernel/src/intercept.ts` -- cost settlement: admitted on an estimate, reconciled when the operation resolves, caps enforced on the settled total
- `packages/adapter-cli/src/traits.ts` -- the metadata channel carries a verified numeric usage figure, not only strings
- `packages/adapter-cli/src/executors/*.ts` -- a usage trait per vendor, each verified against that binary's real output
- `packages/adapter-cli/src/plugin.ts` -- the executor action declares an estimate and settles the reported figure
- `packages/session/src/run-session.ts` -- `SESSION_ACTION_COST` stops being the whole story
- tests -- the matrix, the settlement proof, and a live verification per vendor

## Tasks & Acceptance

- [x] Cost settlement in the pipeline, with caps enforced on the settled total
- [x] A numeric usage figure that survives the adapter's output channel
- [x] A usage trait per vendor, each verified by execution against the real binary
- [x] Estimate-and-settle wired through the executor plugin; absence charged honestly
- [x] The estimate and the settlement both visible in the record stream
- [x] Behaviour neutrality with no policy set; every existing assertion unmodified

**Acceptance Criteria:**
- Given a policy with a cost cap, when a run spends more than its estimate, then the next run is refused on the settled total and the refusal names the cost cap
- And a cost cap and an invocation cap can refuse on different runs, which today they cannot
- And each shipped usage figure is read from the vendor's own field, proven against that binary by execution rather than asserted
- And a run with no policy behaves exactly as it does today

## Spec Change Log

One entry per decision the frozen block did not settle. Each states what was
MEASURED, because a decision recorded without its measurement is an opinion that
outlives the evidence for it.

Entries corrected after review are corrected IN PLACE, with what was wrong stated
rather than a new entry filed beside the stale one.

### 0. RENEGOTIATION of the frozen block: the no-policy row

**This is an amendment to human-owned intent, made by the spec author on
2026-08-26 after a reviewer proved the frozen block contradicted itself.**

The matrix asked for two things that cannot both hold: *"No policy → byte-identical
to today, envelope and exit code"* AND *"Numbers survive the channel → reaches the
envelope"*. MEASURED with the real binaries: every run through every shipped
executor now emits an additional `"usage": N` key on stdout — seventeen cases,
stderr and exit code identical on all of them, stdout different on every one that
reached an executor.

The author's decision: `data.usage` **stays**, and the no-policy row is amended to
"byte-identical except an additive `usage` key on the envelope, and only for a run
that reached an executor". A token count on the envelope is useful to whoever pipes
it, and a side channel would be more machinery for less value.

Recorded here because the process failure was mine and is worth keeping: I raised
the record-stream collision loudly (entry 3) and resolved this larger one quietly.
A contradiction inside the frozen block must be RAISED, never resolved by an
implementer's silent choice — a frozen block that an implementer can quietly
reinterpret is not frozen.

### 1. Settlement is declared beside `run`, never passed to `invoke()`

`ActionDefinition` gained an optional `settle(value) => number | undefined`, read
once at `register` alongside `id`, `cost` and `run`. There is no settlement
parameter anywhere on `ActionHandle`.

MEASURED: `handle` has exactly the keys `['id', 'invoke']`, is frozen, and
`invoke.length` is 0 — so the party whose spend a cap bounds (the session, via
`ExecutorService.run`) has no way to price or re-price its own run. The DECLARER
gains no new power either: it already supplied `cost`, so it could always have
declared 0. Mutation M6 replaced the closed-over `settle` with a live read of
`definition.settle` and a definition mutated after registration re-priced the run
to 0 — the clause turned red, which is the TOCTOU hole M3.B found on `cost`
reopening on the settlement axis.

### 2. A junk figure is RECORDED coded, not thrown

The frozen matrix says "rejected coded". It does not say by what channel. The
settlement happens after the operation has already resolved, so throwing would
turn a completed run into a failed one and lose the work as well as the reason.

MEASURED: the run still resolves its value, `totalCost` still carries the
estimate, and the stream carries `action.estimated` followed by
`action.settle-rejected` with `PANDA_KERNEL_SETTLEMENT_INVALID`. Seven junk
shapes are covered (negative, NaN, Infinity, string, null, object, absurdly
large) plus a `settle` that throws.

**CORRECTED after review, and the correction is the important half.** Every junk
shape above makes a run MORE expensive, and none of them tested the one that makes
it FREE: a well-formed cheap figure. Three reviewers independently found that
`totalCost += reported - charged` had no floor, so a settlement could LOWER the
running total — measured at 25 runs admitted under `maxTotalCost: 1`, 20 real
process spawns under a cap of 2, and, decisively, `claude` on an unauthenticated
machine printing an all-zero usage object, so the cost cap did not survive a
logged-out developer. A settlement is now FLOORED at the estimate: it may raise
what a run costs and never lower it. The estimate is the declarer's own number, so
a declarer that wants a low floor declares one honestly, and over-charging is the
fail-closed direction where under-charging is the hole. This is what makes the
source comment true as written — *failing, throwing or lying is never cheaper than
reporting honestly*.

"Absurd" is bounded at `Number.MAX_SAFE_INTEGER`, and the bound is not arbitrary:
past it `totalCost + x` stops being exact, so one absurd figure would make every
LATER cap comparison quietly wrong rather than merely large.

### 3. The settlement records are gated on a POLICY being configured

**CORRECTED after review. The shape shipped first — emit the records only when a
figure arrived — was measurably wrong, and a reviewer found the better one.**

The frozen block asks for two things that collide: the record stream must show
"what was estimated and what settled" for any admitted run, AND every existing
assertion must pass unmodified.

MEASURED: five pre-existing clauses pin the exact action-event sequence of a run
through the executor plugin (`packages/session/test/run-session.test.ts:226`,
`packages/session/test/kernel-composition.test.ts:154`, and the consumer proof),
and every one of them injects a fake adapter that reports no usage. Emitting an
`action.estimated` at admission for every settleable action turned three of them
red.

My first resolution emitted the pair at SETTLEMENT time and only when a figure
arrived. That kept the pre-existing clauses green and FAILED the auditability
clause: a reviewer reconstructed the total from the stream across three actions
and got 59845 against an actual 59852, the gap being exactly the estimate of the
action nothing observed — charged permanently and appearing nowhere.

The shipped shape is the reviewer's: **gate the settlement records on a policy
actually being configured.** The frozen clause only promises neutrality *with no
policy set*, and all three pinned clauses run uncapped. So with no budget the
stream is byte-identical to Story 1.7's, and with a budget every admitted
settleable invocation emits `action.estimated` at ADMISSION and every reconciled
one an `action.settled` — which makes the reconstruction exact rather than
approximate, and is pinned by a clause that does the arithmetic.

An `action.unsettled` event was built and then deleted: under the gated shape the
`action.estimated` already carries what an unsettled run was charged.

### 4. `LOG_RECORD_VERSION` was NOT bumped for the additive `cost` field

`LogEntry` gained an optional `cost`, permitted only on `action.estimated` and
`action.settled`. The file's own rule says the version is bumped when the closed
shape changes.

MEASURED: `packages/kernel/test/log.test.ts:47` pins `version === 1`, and the
closed-key-set clause at `intercept.test.ts:730` pins an `action.invoked` record
to exactly five keys — which still holds, because `cost` never appears there. The
version exists so a reader knows how to parse what it is holding; a correct v1
reader still reconstructs everything v1 promised, since `cost` only ever rides two
events no v1 reader ever knew. Bumping would tell that reader its parse had become
invalid, which is false. A bump is owed the day an EXISTING event's record changes
shape.

CORRECTED after review: the premise as first written — that these are events a v1
reader "had to skip anyway" — understated the cost. With a budget configured they
appear on every run of every shipped executor, and a strict reader validating
against the closed `LOG_EVENTS` set errors rather than skips. The judgement stands;
no version number makes an unknown event known.

### 5. The usage figure rides its own `data.usage` key, not the metadata channel

`#data` kept a metadata value only when `typeof value === 'string'`, so a number
could not ride it. The channel was NOT widened.

MEASURED: widening `metadata` would have made every existing metadata key
numeric-capable, and `packages/adapter-cli/test/executor-suite.ts` asserts
`envelope.data` with `toEqual`, so the string-only contract is load-bearing in
three suites. Instead `usagePaths` is a separate trait field feeding an
engine-owned `usage` key, and `usage` joined `RESERVED_DATA_KEYS` so a metadata
key can no longer forge the figure a cost cap is enforced on (mutation M8: dropping
it from that list turns the collision clause red).

### 6. `usagePaths` is a LIST that is summed, and why that is not panda counting tokens

MEASURED, by running all three binaries:

| Vendor | Where it reports | Observed on a one-word task |
|---|---|---|
| claude-code 2.1.246 | `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` on the single result object | 2 / 4 / 42206 / 17630 |
| codex-cli 0.149.1 | `usage.{input_tokens, output_tokens}` on a separate `turn.completed` event | 28451 / 61 (also `cached_input_tokens` 6912, `cache_write_input_tokens` 0, `reasoning_output_tokens` 54) |
| opencode 1.18.23 | `part.tokens.total` on `step_finish` | 42599 (= input 34390 + output 17 + reasoning 0 + cache.write 0 + cache.read 8192) |

No vendor reports a single total for a RUN. claude's four components are disjoint,
and a reviewer proved that harder than the naming does: pricing each component at
its own published rate reconstructs the `total_cost_usd` the same payload prints,
to the last digit (0.431945). `input_tokens` counts only the UNCACHED input, so
charging it alone would have priced that run at 2 tokens instead of 59842. codex's
`cached_input_tokens` is the opposite case — a breakdown of input already counted —
and codex says so itself: its own session rollout records `total_tokens` as input
plus output with the cached figure EXCLUDED (27189 = 27184 + 5 on a measured run).
Summing it would have billed 53557 for a 28512-token turn.

**CORRECTED after review: the sum runs ACROSS records, not only within one.**
opencode's `step_finish` is emitted per STEP and each `total` is that step's own
spend rather than a running one. MEASURED on a real three-step task: 42770, 42875
and 43025, each equal to its own components, for a run that cost 128670. The
shipped rule took the LAST record and billed 43025 — and a task whose final step is
a one-line answer bills almost nothing. The single-step measurement in the table
above could not surface it, which is exactly why the defect shipped.

Because the figure is now summed across records, `usageWhen` became REQUIRED beside
`usagePaths`: an undiscriminated sum bills every record that happens to fit the
shape. It is `resultWhen` for the accounting half. The whole figure also fails
closed together — if any billed record cannot be read, the run reports no figure
rather than a sum missing a term, because dropping an unreadable term under-bills
silently.

Adding up numbers a vendor printed is not the panda-side token counting the Never
list forbids: nothing estimates, tokenizes or infers, and every term is a figure
the tool itself emitted.

Fail-closed on partial data: a record qualifies only when EVERY named path
resolves to a finite non-negative number. A partial sum is a wrong bill, and a
wrong bill is worse than an absent one — absence is a case the pipeline already
handles by keeping the estimate. Mutation M7 turned the partial-path skip into a
`continue` and the clauses went red.

### 7. Usage is read from a record that is NOT the result record, on EVERY outcome path

MEASURED: two of the three vendors report usage on a later event entirely
(`turn.completed`, `step_finish`). A channel that could only read the result
record — which is what `metadata` does — would have found nothing on either. The
scan therefore resolves usage independently of the result.

**CORRECTED after review.** The shipped version threaded the figure only through
`#failedFromRecord` and `#okFromRecord`. `#cancelled` never read `outcome.stdout`
at all, and the bare non-zero-exit, truncated-stdout, signal-terminated and
stream-error branches all discarded it. MEASURED: a cancelled run with 500,000
reported tokens in its captured stdout was charged 1, and ten failed runs produced
ten estimates and zero settlements — which contradicts both the frozen matrix row
and the source comment claiming no path on which failing is free. A killed child
settles through `close` carrying everything it printed, so the bytes were in hand
and thrown away. The scan now runs first and its figure reaches every path except
the one where no child ever started.

### 8. Money was read and deliberately dropped

MEASURED: claude prints `total_cost_usd` (0.430985 on that run) and a per-model
`modelUsage` with `costUSD`; opencode prints `cost`. All are available and none
ship. A monetary figure is on the frozen Ask-First list.

### 9. The default estimate stays 1, and stays honest about what that means

MEASURED: three pre-existing suites pin cost-1 behaviour
(`run-session.test.ts` at `maxTotalCost: 0.5`, `kernel-composition.test.ts` and
`plugin.test.ts` at 1.5). Raising `SESSION_ACTION_COST` or
`DEFAULT_EXECUTOR_ACTION_COST` to a token-scale placeholder refuses the FIRST run
in all of them, and would silently redefine every cap a user has already written
against "1 = one run".

Panda also may not invent a pre-run token figure — that is the Never list. So the
estimate stays a placeholder in whatever unit the caller's caps are denominated
in, the settlement is always in the vendor's token unit, and a host that budgets
in tokens passes its own `cost` through `createExecutorPlugin`. The unit mismatch
is real and is in `deferred-work.md` rather than narrated away.

### 10. Two pre-existing test files were edited, additively, and here is why

The brief asked for every pre-existing test file to be untouched. That is
impossible for exactly one of them, and the reason is evidence rather than
inconvenience.

MEASURED: `packages/adapter-cli/test/executors.test.ts` already contained
`{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":22}}` in its
codex fixture, written when Story 2.3 copied codex's real output. Once codex has a
usage trait, that fixture legitimately produces `data.usage === 33`, and the
shared harness asserts `envelope.data` with `toEqual`. The alternatives were to
ship codex without a usage trait — refusing to read a field the vendor
demonstrably prints, and the exact inertness correction-01 exists to prevent — or
to contrive codex's path set so the fixture would not match, which is a guessed
field wearing a disguise.

So `test/executor-suite.ts` gained an optional `expectedUsage?: number` and
`test/executors.test.ts` gained `expectedUsage: 33`. Both edits ADD an
expectation; no existing assertion was weakened or removed. Every other test file
in the repository is untouched.

### 11. The live verification is one real run per vendor, replayed

Following the repo's two idioms, and taking the lesson from
`codex-strict-config.live.test.ts`: the probe keys on `<binary> --version`
returning exit code 0 through the real spawner, never on "did a shell start".

Shape: probe, one real run captured verbatim, locate the vendor's field by
LITERAL name written in the test (never read from the trait record), replay those
exact bytes through the adapter and require the charged figure to match, then a
DIFFERENTIAL control that the same bytes with the usage record stripped charge
nothing. A vendor that ran and answered but printed no usage field is a HARD
failure naming the field, not a skip — a trait pointing at a field nobody prints
is what Story 2.7a shipped.

MEASURED: all three pass against the installed binaries. Mutation M11 (one
character changed in claude's field name) and M12 (opencode's `usagePaths`
deleted) both turn it red, so the gate is not vacuous. Skips are visible and
carry their reason: missing binary, non-zero version probe, timeout, or a
non-zero run exit (usually credentials). `PANDA_LIVE_USAGE=0` disables it.

**CORRECTED after review, and this is the entry I got most wrong.** The oracle was
not independent. It computed opencode's expectation as `finishes.at(-1)` — the
IMPLEMENTATION's own rule — so it could not see that the implementation was billing
one step of three, and it ran a single-step task where summing and taking-the-last
agree anyway. An oracle that shares the rule cannot detect the defect it shares,
and this repository has now shipped that pattern three times.

Each oracle now reads a DIFFERENT part of the payload than the trait record does:
claude's from `modelUsage`, which restates the same four figures under camelCase
spellings the trait never mentions; opencode's from the per-step COMPONENTS
(`input`, `output`, `reasoning`, `cache.write`, `cache.read`) summed over every
step, where the trait reads `total`. codex prints its usage in exactly one place,
so its oracle reads the same two fields — that limit is stated rather than dressed
up, and the weight there is carried by the WRONG-RULE controls.

Every vendor now also has wrong-rule controls: the plausible mis-reading must
produce a DIFFERENT number from the charge (claude: uncached input alone, and
input+output ignoring cache; codex: adding `cached_input_tokens`, and adding
`reasoning_output_tokens`; opencode: the last step alone, and the first step
alone). opencode's live task is deliberately multi-step, and a separate clause
asserts it really took more than one billed step — a one-step run would make the
summing rule untestable.

### 12. Every shipped usagePaths is verified, by construction rather than by list

Three hand-written `verifyVendor(...)` calls are a list that drifts from the thing
it names, which is the Story 2.7a shape this story exists to avoid. MEASURED: the
shared clause suite asserts a usage figure for codex only — claude-code's and
opencode's clause-suite fixtures carry no usage fields — so a fourth adapter with a
usage-free fixture and no live entry would have shipped a completely untested
`usagePaths`. Closed by walking `EXECUTOR_CATALOGUE`: every trait declaring
`usagePaths` must have a live entry, and must pair it with the `usageWhen` that
bounds its sum.

### 13. Prototype pollution, and where a per-field guard stops

MEASURED: `settle` is optional, so destructuring the definition walked the
PROTOTYPE CHAIN. With `Object.prototype.settle` set to a function returning 0, five
50-cost actions were admitted under a cap of 100 and `totalCost` read 0 — every
un-settled action in the process became free and the cost cap silently unlimited,
while the control pipeline refused three. `guard` and `around` have been pollutable
since Story 1.7, but those DENY or SUBSTITUTE; `settle` is the first member that
makes spend UNLIMITED, which is the one direction a budget seam must never fail.
`cost` is the same hole one step earlier — a definition omitting it would inherit a
price.

Every definition field is now read through `Object.hasOwn`. The honest limit,
stated rather than narrated away: a polluted prototype can still make a
REGISTRATION throw, which is a denial of service rather than a spend hole.

### 14. A re-entrant settlement is refused rather than served

MEASURED: `settleCost` calls declarer code before applying the delta, so an
`invoke()` re-entered synchronously from inside `settle` read the pre-settlement
total — cap 100, outer settles 100, nested admitted, final
`{invocations: 2, totalCost: 101}`. Refused now with
`PANDA_KERNEL_SETTLEMENT_IN_PROGRESS`: fail-closed at a budget seam means refusing
an admission nobody can price. This is narrower than the in-flight overshoot the
ledger records, where the figure genuinely does not exist yet.

## Design Notes

**Why settlement rather than a better estimate.** The pipeline has to admit or refuse before the operation runs, and no honest token figure exists then. Any pre-run number is a guess, and a budget denominated in guesses cannot be reconciled with a bill. Settlement keeps the up-front refusal — which is what makes a cap a cap — and makes the running total true.

**Why the caller never prices its own run.** M3.B established it for the executor plugin after a reviewer found the mounting caller could mutate its cost to zero. The same rule governs here: the estimate belongs to whoever declares the action, and the settlement belongs to whoever observed the vendor.

**Deliberately not built.** No money, no cross-process budget, no per-model weighting, no panda-side token counting, no handoff budget.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green, existing suites unmodified
- `pnpm proof:consumer-install` -- expected: still green
- the per-vendor live verification -- expected: each figure matched against a real run of that binary
