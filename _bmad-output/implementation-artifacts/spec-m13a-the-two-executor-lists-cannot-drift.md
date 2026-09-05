# Spec M13.A — the two executor lists cannot drift

**Status:** FROZEN
**Story:** resolves **5-5 (full diagnostics)** — one of its three cases with a
gate, one already shipped, and one closed as having no substrate. Closes the
parallel name list this project has ALREADY shipped a defect from and wrote the
lesson down for, twice, one package away from where it still lives.
**Base commit:** `2c4eaa2`

---

## Intent

`packages/adapter-cli/src/catalogue.ts:29-31` records this project's own defect:

> "Keyed from the traits, never from a list of string literals written beside
> them: **Story 2.7a shipped an executor that was never once exercised because a
> parallel name list drifted from the thing it named.**"

`packages/session/src/workspaces.ts:47-52` cites that lesson again when choosing
the workspace catalogue's shape.

`packages/environment/src/executors.ts` **is that parallel name list**. It
declares `executorId: 'claude-code'`, `'codex'`, `'opencode'` as string literals,
in a different package from the traits, with nothing connecting the two. It
drives DETECTION and PROJECTION; the catalogue drives RUNNING. They agree today
by discipline.

## The measurement this rests on

Executed 2026-09-03 at `2c4eaa2`, every zero with a control.

| # | Claim | Evidence |
|---|---|---|
| M1 | Two independent lists, neither derived from the other | `EXECUTOR_PROFILES` (`environment/src/executors.ts:147,172,196`) hand-writes three literals. `EXECUTOR_CATALOGUE` (`adapter-cli/src/catalogue.ts:44-46`) is keyed from `SHIPPED`'s trait records. **Control:** the same query finds the three files that import `EXECUTOR_PROFILES`, and finds ZERO importing the catalogue into `environment` or the profiles into `adapter-cli`. |
| M2 | They agree today | Both are exactly `claude-code`, `codex`, `opencode`. |
| M3 | `environment` structurally CANNOT ask | Its `package.json` declares `contracts`, `kernel`, `projection`, `registry` — not `adapter-cli` — and `packages/environment/test/guard.test.ts:50-53` pins that set by EXACT EQUALITY. |
| M4 | The disagreement is user-visible in BOTH directions | A profile with no adapter: `panda init` projects into that executor's config and `panda doctor` calls it clean, while `panda run --executor <id>` fails `PANDA_EXECUTOR_NOT_FOUND` — doctor certifying what run refuses, which is the M4.C promise inverted. An adapter with no profile: `panda run` works while `init` never projects skills or servers for it, so it runs degraded and silently. |
| M5 | 5-5's "pending secret" has NO substrate | `secret` appears in exactly three files under `packages/*/src`: the bundle export detector, one kernel comment, and the CLI. There is no pending state, no lifecycle, no vocabulary. **Control:** `PandaError` in `contracts/src/errors.ts` → 6 hits, so the search works. |
| M6 | 5-5's other two cases already shipped | "one drifted target" is `DRIFT_KINDS` with `FINDING_EXITS` over the closed union; "direct plugin writes to panda-owned files are detected" is `edited` + `foreign-collision`, asserted at `environment/test/doctor.test.ts`. |
| M7 | `packages/cli` already sees BOTH lists | `environment/src/index.ts:40` exports `EXECUTOR_PROFILES`; `session/src/index.ts:55` re-exports the adapter surface, and `ExecutorSelection.available` carries the runnable ids. `cli/package.json` declares both. No new package edge is needed. |

---

## Boundaries & Constraints

### D1 — a GATE, not a diagnosis, because the state is not a user's

This is the finding that shapes the story. Story 5.5's acceptance asks doctor to
report "one missing adapter" alongside a drifted target and a pending secret — as
if all three were environment conditions. They are not. A user cannot add an
executor to panda: `EXECUTOR_PROFILES` and `EXECUTOR_CATALOGUE` are both compiled
in. The lists can only disagree because a panda author made them disagree.

So a doctor finding here would be panda reporting **its own build defect to a
user who can do nothing about it**, which is worse than silence: it spends one of
`FINDING_EXITS`' remediations on a state with no user-side exit. The honest home
is a gate that fails in CI before the disagreement can ship.

### D2 — the gate DERIVES nothing, and that is deliberate

The obvious fix is the catalogue's own: derive the id from the trait record so a
profile cannot name an executor no adapter ships. It is refused here, measured:
`environment` would have to import `@skanl/panda-adapter-cli`, and
`packages/environment/test/guard.test.ts` pins its dependency set by exact
equality. Weakening an existing guard to enable a convenience is the trade this
repository has already refused once (M12.A's Ask First forbids it by name).

A gate in `packages/cli/test/` reaches both lists through packages `cli` already
declares. Zero new edges, zero guards weakened.

### D3 — both directions, because they are different defects

`detected \ runnable` is "panda sets up an executor it cannot run".
`runnable \ detected` is "panda runs an executor it never configured".
The first is loud at `panda run`; the second is SILENT, which makes it the worse
of the two and the reason the gate asserts set equality rather than containment.

### D4 — 5-5 is RESOLVED by this, not partially served

Its four clauses, each answered: drifted target — shipped. Direct plugin writes —
shipped. Missing adapter — this gate, with D1's reasoning that it is not a
diagnosis. Pending secret — closed as no-substrate, on the same ground 5-6 was
closed: the vocabulary does not exist and inventing it is the glossary-line-to-
requirement mistake this project has paid for most.

### D5 — not in this story

- Any doctor finding, `DiagnosisFindingKind` value, or `FINDING_EXITS` row.
- Any change to `EXECUTOR_PROFILES`' contents or to the catalogue.
- Any new package dependency, and any edit to any `guard.test.ts`.
- A "pending secret" state, in any form.

---

## I/O & Edge-Case Matrix

| # | Input / state | Expected |
|---|---|---|
| E1 | The repository as it is | Gate passes; the two sets are equal. |
| E2 | A profile whose id no adapter ships | FAIL, naming the id and the direction. |
| E3 | An adapter whose id no profile declares | FAIL, naming the id and the direction. |
| E4 | Both lists empty | FAIL — an empty set equals an empty set, so the gate must also assert the sets are non-empty, or it passes on a repository that ships nothing. |
| E5 | Same ids, different order | Pass — order is not the invariant. |
| E6 | A duplicate id within one list | FAIL — two profiles for one id is a different defect and must not be smoothed away by set comparison. |

---

## Code Map

- `packages/cli/test/executor-catalogue-parity.test.ts` — NEW, and the only code
  this story adds.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 5-5 resolved, with
  its four clauses answered in the row.

---

## Tasks & Acceptance

- [ ] The parity gate, both directions, with E4 and E6 covered
- [ ] 5-5's row records which clause was answered how

**Acceptance Criteria:**

1. **The gate FAILS in each direction separately**, proven by planting each: an
   id in the profiles that no adapter ships, and an adapter id no profile
   declares. Each names its own direction; each is removed afterwards and the
   gate returns green.
2. **The gate FAILS on two empty lists** — proven, not assumed. A set-equality
   assertion alone passes on a repository that ships no executors at all, which
   is the shape that would make this gate a decoration.
3. **The gate FAILS on a duplicated id**, so a set comparison cannot hide it.
4. **No package gained a dependency and no `guard.test.ts` changed** — verified
   by `git diff --stat`.

---

## Ask First

- Anything that would add a doctor finding or a remediation for this state.
- Any change to a `guard.test.ts` or to any `package.json` dependency list.
- Deriving one list from the other, which D2 refuses on measured grounds.

---

## Spec Change Log

0. Frozen at `2c4eaa2`.

---

## Verification

Written and falsified by the coordinator directly — one test file, fully
measured before it was written, so delegating it would have cost more than doing
it.

### Falsified FOUR ways, and each direction SEPARATELY

A single plant would have proved only that some assertion fires. These four are
chosen so that each clause fails on its own input:

| plant | result |
|---|---|
| A profile id renamed to one no adapter ships (`opencode` -> `opencode-x`) | `projected into but not runnable: 'panda init' would configure an executor 'panda run' cannot start: expected [ 'opencode-x' ] to deeply equal []` |
| A profile block REMOVED, so an adapter ships with no profile | `runnable but never projected into: 'panda run' would start an executor that never receives what the registry holds: expected [ 'opencode' ] to deeply equal []` |
| A profile block DUPLICATED | `duplicate executor id among the profiles: claude-code, codex, opencode, opencode: expected 3 to be 4` — named by its own clause rather than smoothed away |
| BOTH lists emptied | all three clauses red, including "no executor profiles ship at all" |

The removal and the rename are deliberately different edits: a rename fires both
directions at once and would have let one assertion hide behind the other, so the
second direction is proved by an edit that leaves the first direction passing.

The fourth plant is the one that matters most for the gate's honesty: two empty
sets ARE equal, so the equality clause alone passes on a panda that ships no
executors at all. That is the shape that would make this file a decoration.

Every plant was reverted and `git status` verified: only the new test file is
untracked, and no source file is modified.

### The gate

Bytes 0. Typecheck 0 across all ten packages. Lint 0. **1,445 tests green on
Node 24 AND on Node 26.8.1** (1,442 before; this adds three clauses), live suites
excluded. `pnpm build` clean and `pnpm proof:consumer-install` 10 passed / 1
skipped.

### No new coupling, verified

`git diff --stat` over `packages/` shows no `package.json` changed and no
`guard.test.ts` touched. The gate reaches the runnable ids through
`resolveExecutor`'s `ExecutorSelection.available` — the way the PRODUCT surfaces
them — rather than through `@skanl/panda-adapter-cli`, which `@skanl/panda-cli` deliberately
does not depend on. That follows the rule `executor-selection.test.ts` already
states in its own imports.

### What this resolves about story 5-5, clause by clause

- **"one drifted target"** — already shipped: `DRIFT_KINDS` with `FINDING_EXITS`
  as a `Record` over the closed union, so a kind without an exit does not
  compile.
- **"direct plugin writes to panda-owned files are detected"** — already shipped
  as `edited` plus `foreign-collision`, asserted in `environment/test/doctor.test.ts`.
- **"one missing adapter"** — this gate, and the reasoning is the finding: it is
  NOT a user-facing diagnosis. Both lists are compiled in and a user cannot add
  an executor, so the lists can only disagree because a panda author made them
  disagree. A doctor finding would report panda's own build defect to someone
  with no way to act on it, and would spend a `FINDING_EXITS` remediation on a
  state with no user-side exit.
- **"one pending secret"** — closed as having no substrate. `secret` occurs in
  exactly three files under `packages/*/src`: the bundle export detector, one
  kernel comment, and the CLI. There is no pending state and no lifecycle.
  Control: `PandaError` in `contracts/src/errors.ts` returns 6 hits, so the
  search works. Building it would invent vocabulary, which is the same ground
  5-6 was closed on.

### What is NOT done, and why

The catalogue's own fix — derive the id from the trait record so a profile cannot
name an executor no adapter ships — is the better shape and is refused here on
measured grounds: `@skanl/panda-environment` would have to import `@skanl/panda-adapter-cli`,
and `packages/environment/test/guard.test.ts` pins its dependency set by EXACT
equality. Weakening an existing guard to enable a convenience is the trade M12.A
refused by name one commit ago. The upgrade path is in the test's own comment: if
`environment` ever legitimately gains that dependency, replace this gate with the
derivation and delete it.
