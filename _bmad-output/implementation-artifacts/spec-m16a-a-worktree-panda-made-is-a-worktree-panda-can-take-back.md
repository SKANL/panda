# Spec M16.A — a worktree panda made is a worktree panda can take back

**Status:** FROZEN
**Story:** implements **4-3 (crash-safe disposal)** / FR-20, and closes the gap
`git-worktree-provider.ts` names in its own source at the line where it declined
to remove anything.
**Base commit:** `3209fc7`

---

## Intent

Panda creates a git worktree on every `panda run` under the git-worktree
provider, and **has no way to remove one**. `panda --help` mentions workspaces
exactly once, under `run`, which is the verb that creates them. There is no
removal verb, no sweep, and no ledger path that retires a record.

The provider says so itself. `git-worktree-provider.ts:167-173`:

> "Idempotent, and it removes nothing. A worktree outlives the provider by
> design — that is what makes parallel work resumable. Removing trees here would
> also make `dispose()` a destructive operation on a path panda might merely have
> been handed; **tree removal is Story 4.3, where it can be crash-safe and
> branch-aware.**"

So the user's only exit today is `git worktree remove` by hand plus editing
panda's ledger by hand — which is "edit your vendor config" wearing a different
hat, and this project's stated rule is that panda absorbs the problem rather than
handing it back.

## The measurement this rests on

Executed 2026-09-03 at `3209fc7`, against real git, every zero with a control.

| # | Claim | Evidence |
|---|---|---|
| M1 | Panda cannot remove a worktree | `panda --help` mentions workspaces only under `run`. **Control:** the same help lists every other verb, so the search saw the document. `WorktreeLedger` exposes no removal or retirement path. |
| M2 | The source names this story at the exact line it declined | `git-worktree-provider.ts:167-173` (`dispose()` removes nothing) and `:100-103` (`--detach`, "branch lifecycle belongs to crash-safe disposal (Story 4.3)"). |
| M3 | Panda's worktrees are DETACHED, so FR-20's branch clause has no subject | `git worktree add --detach` at `:103`, and M10.A's own verification recorded `detached` in `git worktree list --porcelain`. Panda creates no branch, so there is no merged branch to delete and no unmerged branch to preserve. |
| M4 | **git protects dirty files and does NOT protect committed work on a detached HEAD** | Measured on a real repository. A worktree with modified or untracked files: `fatal: 'wt' contains modified or untracked files, use --force to delete it`. A worktree whose detached HEAD carries a commit: `git worktree remove` **succeeds silently**, and `git branch --contains <sha>` returns **0 branches** — the commit is reachable from nothing and is gc bait. |
| M5 | Ownership is already provable | `WorktreeRecord` is `{version, id, ordinal, path, repoPath, createdAt}`, one durable record per worktree, which is AD-6's "ownership is proven by durable metadata records written at creation — never inferred from paths". |
| M6 | Ordinals are already monotonic | The ledger's `nextOrdinal` "only ever increases", which is AD-6's "released workspace/worktree names are retired permanently". Removal must not reuse an ordinal. |

---

## Boundaries & Constraints

### D1 — the safety rule is M4's, not FR-20's, because FR-20's subject does not exist

FR-20 says "merged branches may be deleted while unmerged branches are
preserved". Panda creates **no branches** (M3). Implementing that clause
literally would mean first making panda create branches — which the provider
already refused for a measured reason ("branch creation would collide on
re-runs") — so the clause is closed as **not applicable to the shipped design**,
with its evidence, exactly as 5-5's "pending secret" and 2-10's worked example
were closed. It REOPENS the day panda creates a branch per worktree.

FR-20's INTENT — never destroy work that exists nowhere else — is not closed. It
is implemented against the design panda shipped:

- **Dirty tree** (modified or untracked files): panda does not reimplement the
  check. `git worktree remove` already refuses, in git's own words, and panda
  surfaces that refusal rather than translating it (correction-01: the external
  tool's own vocabulary).
- **A detached HEAD carrying a commit reachable from no ref**: git removes it
  SILENTLY (M4). This is the hazard FR-20 was written to prevent, and git does
  not cover it. **Panda checks it and refuses.** This is the load-bearing half of
  the story.

### D2 — panda removes ONLY what its ledger claims

A tree with no `WorktreeRecord` is not panda's, whatever its path looks like
(AD-6, and the same rule `foreign-collision` enforces for config). No path
pattern, no name prefix, no heuristic. A directory that looks like a panda
worktree and has no record is REPORTED, never removed.

### D3 — crash safety is INTENT RECORDED BEFORE ACTION, and a sweep that reads it

The AC's shape: "a disposal killed mid-operation" then "the next startup sweep
reconciles the trash-pattern leftover". So removal is two phases:

1. Record the intent to remove — durably, before touching the tree.
2. Perform the removal, then retire the record.

An interruption between them leaves a record marked for removal and a tree that
may be wholly there, partly there, or gone. The sweep resolves exactly that
state, and it resolves it the SAME way a fresh removal would, through one code
path — a sweep that reasons differently from the remover is a second answer that
drifts.

### D4 — the sweep is not a boot-time surprise

AD-6 asks for "a defined recovery sweep". It runs where a user can see it and
consent to it, not silently at every process start: `panda doctor` REPORTS a
leftover, and the removal verb RESOLVES it. A sweep that deletes on startup would
be panda destroying something on a run the user did not ask to be destructive.
That is the same reasoning `remediate` already rests on: report the state, and
let a verb be the way out.

### D5 — the ordinal is never reused

M6. Removal retires a record; it does not free its ordinal. A reused ordinal
would make two different worktrees share a name across time, which is exactly
what AD-6's permanent retirement forbids.

### D6 — one verb, and it is honest about what it will not do

The user needs an exit (Intent). The verb removes what panda owns and is safe to
remove, and for everything else it REPORTS with the reason and the command that
would resolve it — never a silent skip, never a partial success reported as
success.

### D7 — not in this story

- Creating branches per worktree, or anything that would give FR-20's clause a
  subject.
- `--force`, or any flag that overrides D1's refusals. A user who wants to
  destroy unreachable work has `git` for that, and panda naming git's own command
  is more honest than panda growing a destructive flag.
- Removing the workspace-local provider's directories. It is a different provider
  with a different medium and no git semantics; this story is the worktree one.
- Any change to `WorkspaceProvider`'s port signature.

---

## I/O & Edge-Case Matrix

| # | Input / state | Expected |
|---|---|---|
| E1 | A clean worktree panda's ledger claims | Removed; the record retired; the ordinal NOT reused. |
| E2 | The same tree, dirty (modified or untracked) | Refused, surfacing git's own sentence. Tree and record untouched. |
| E3 | Detached HEAD carrying a commit reachable from no ref | REFUSED by panda, naming the commit. This is the case git does not protect. |
| E4 | Detached HEAD at a commit that IS reachable from a ref | Removed — nothing would be lost. |
| E5 | A directory that looks like a panda worktree with NO record | Reported, never removed. |
| E6 | A record whose tree is already gone | The record is retired; this is the interrupted-removal tail and must not error. |
| E7 | Interrupted between intent and removal, tree wholly present | The sweep completes the same removal a fresh one would. |
| E8 | Interrupted, tree partly removed | Same path, same outcome; git's own `worktree remove`/`prune` vocabulary does the reconciling. |
| E9 | The repository is gone but records remain | Reported with the repo path; no removal attempted against a repo panda cannot reach. |
| E10 | Two concurrent removals of one id | One wins; the loser gets a coded error naming the holder, matching the registry's contention rule rather than inventing a second one. |
| E11 | `panda doctor` with a leftover | Reports it as a finding with a way out (M4.C: every state panda reports has an exit). |
| E12 | Nothing to remove | Says so and exits 0. |

---

## Code Map

- `packages/workspace-git-worktree/src/ledger.ts` — the removal-intent record and
  its retirement.
- `packages/workspace-git-worktree/src/git-worktree-provider.ts` — the removal
  itself, and the reachability check of D1. `dispose()`'s comment is updated: it
  currently promises this story.
- `packages/workspace-git-worktree/src/git.ts` — whatever git vocabulary the
  check needs, through the one existing seam.
- `packages/environment/src/doctor.ts` — the leftover finding (D4), with its exit.
- `packages/cli/src/run.ts` — the verb.

---

## Tasks & Acceptance

- [x] Removal of a worktree panda's ledger claims, with the record retired
- [x] Intent recorded before action; a sweep that resolves an interruption
- [x] The unreachable-commit refusal (D1's load-bearing half)
- [x] `doctor` reports a leftover with a way out
- [x] A verb, honest about what it will not remove

**Acceptance Criteria:**

1. **A commit made inside a panda worktree is never lost.** Driven against real
   git: commit on the detached HEAD, ask panda to remove, and it REFUSES naming
   the commit. Its control in the same run: the same tree at a reachable commit
   IS removed. Without the control, a refusal proves only that panda refuses
   everything.
2. **An interrupted removal is completed by the sweep, not compounded.** Proven
   by killing between intent and action — a real interruption, not a mocked one
   — and showing the next sweep reaches the same end state a clean removal does.
3. **Panda removes nothing it does not own**: a directory shaped exactly like a
   panda worktree, with no record, survives and is reported.
4. **The ordinal is not reused** after a removal, proven by removing and creating
   again.
5. **`git worktree list --porcelain` no longer names the tree** after a removal —
   git's own vocabulary, per correction-01 C5.

---

## Ask First

- Anything that creates a branch per worktree.
- Any `--force`-shaped override of a refusal in D1.
- Any sweep that removes without the user asking.
- Any change to `WorkspaceProvider`'s port.

---

## Spec Change Log

0. Frozen at `3209fc7`. FR-20's branch clause closed as not applicable to the
   shipped design (detached worktrees), with its intent implemented against what
   panda actually creates and against a hazard measured in real git that git
   itself does not guard.

---

## Verification

Executed 2026-09-03, Windows 11, git 2.49.0.windows.1, on **Node 24.14.1 AND
Node 26.8.1**. Every claim below is an execution, not a reading.

### The gate

- `node scripts/check-source-bytes.mjs` — clean.
- `pnpm typecheck` — clean, all 12 packages.
- `pnpm lint` — `ESLint: No issues found`.
- `pnpm test` per package with `--exclude "**/*live.test.ts"` — green on both Node
  versions: adapter-cli 153, cli 182, contracts 147, environment 126, kernel 264,
  memory-filesystem 7, memory-sqlite 10, projection 307, registry 161, session
  114, workspace-git-worktree 22, workspace-local 23.
- `pnpm build && pnpm proof:consumer-install` — 10 passed, 1 skipped.
- `pnpm check` itself aborts in `adapter-cli` on `test/usage-live.test.ts`, which
  spawns the real `claude-code` binary and got non-JSON back from it. A live
  suite and untouched by this story; the per-package runs above cover everything
  it skipped.

### The acceptance criteria

1. **A commit made inside a panda worktree is never lost.**
   `packages/workspace-git-worktree/test/removal.test.ts`. A commit on the
   detached HEAD, with git's own `branch --contains` asserted empty first so the
   fixture is proved to hold the hazard; `removeWorktree` refuses with
   `PANDA_CONTRACT_WORKSPACE_REMOVAL_REFUSED` naming the sha, and the tree, git's
   registration and the record are all still there afterwards.
   **The control, same run, same fixture:** a second worktree at a commit a ref
   DOES contain is removed. Also driven at the shipped binary:
   `panda workspace remove w-0` exits 1 with the refusal, `panda workspace remove
   w-1` exits 0.
2. **An interrupted removal is completed by the sweep, not compounded.**
   `packages/cli/test/worktree-remove.test.ts`, with a REAL interruption: a
   separate `node` process (`test/interrupted-removal-child.ts`) runs the real
   removal and SIGKILLs its own pid the instant its durable intent marker
   appears. The suite asserts the child did NOT complete, so a race that finished
   the removal fails rather than passing quietly. One `panda workspace remove`
   with no id then reaches an end state compared field-for-field against the end
   state of an UNINTERRUPTED removal of an identical tree in the same repository
   — git's listing, the tree, the record, the marker — and a second sweep reports
   nothing left.
3. **Panda removes nothing it does not own.** A directory shaped exactly like
   panda's — same parent, the `w-<n>` name, a REAL `git worktree` of the same
   repository inside it — and no ownership record: `inspectWorktrees` reports it
   as `unclaimed`, `removeWorktree` answers `PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID`,
   and it is still there and still known to git afterwards. The sweep prints
   `unclaimed: w-777` and leaves it.
4. **The ordinal is not reused.** Create `w-0`, remove it, create again: the new
   id is not `w-0` and its ordinal is strictly higher; the ledger's counter did
   not go backwards. At the binary, `worktrees.json` reads `nextOrdinal: 2` after
   one of two worktrees was removed.
5. **`git worktree list --porcelain` no longer names the tree.** Asserted in both
   suites in git's own vocabulary rather than by looking at the directory.

### The falsifications, each landing on ONE clause

| Plant | Reddened |
|---|---|
| `for-each-ref --contains` → `branch --contains` | ONLY "takes a tree whose commit only a TAG contains". The obvious spelling — and the spec's own M4 measurement used it — calls a tag-kept commit unreachable, so panda would refuse a removal that loses nothing. |
| The reachability check disabled | ONLY AC1's refusal clause. |
| Ownership inferred from the path shape instead of the record | ONLY AC3. |
| The sweep resolving nothing | AC2 and the doctor clause, nothing else. |
| **The intent recorded AFTER the tree is removed (D3 inverted)** | **NOTHING, at first — all 15 clauses stayed green.** An end state cannot witness the order two writes happened in. Closed by one synchronous observation taken inside the killed child at the instant the marker appears: was the tree still on disk? Re-planting the inversion then reddened exactly that clause. Recorded in `deferred-work.md` as a negative result. |

### The measurements this rests on, re-taken here

- A worktree with modified or untracked files: `fatal: '<path>' contains modified
  or untracked files, use --force to delete it`, rc 128 — surfaced verbatim, not
  translated (E2).
- A detached HEAD carrying a commit: `git worktree remove` exits 0 SILENTLY and
  `git branch --contains <sha>` names zero branches. Confirmed at `3209fc7`'s
  successor in this working tree.
- `git rev-list <sha> --not --all` is NOT usable for the reachability check:
  `--all` includes the HEAD of every other worktree, so it calls the commit
  reachable *because it is checked out here* — measured with its control (it
  answered empty for both a reachable and an unreachable commit).
  `--single-worktree` fixes it only when placed BEFORE `--all`.
  `for-each-ref --contains` was chosen instead and driven with its control.
- A tree directory deleted while git still registers it: `git worktree remove`
  exits 0 and cleans the admin entry — no `prune` needed (E6).
- Admin directory gone, tree present: `fatal: '<path>' is not a working tree`,
  rc 128, and the directory survives. This is the state an interrupted
  `git worktree remove` leaves, and it is what the E8 branch answers.

### What is NOT here, deliberately

D7 in full: no branch is created, there is no `--force` or any other override of
a D1 refusal, no workspace-local directory is removed, and `WorkspaceProvider`'s
port signature is untouched. FR-20's branch clause stays closed (D1). `panda
doctor` at machine scope reports no leftover — worktrees are project state, and
the reason is recorded in `deferred-work.md`.

---

### Coordinator verification, on top of the implementer's

Both halves of the safety property driven against REAL git, each with its
control in the same run.

**AC1 — a commit made inside a panda worktree is never lost.** Two worktrees
created by two real `panda run` invocations, then:

| | HEAD reachable from | `panda workspace remove` | tree |
|---|---|---|---|
| A — commit made inside the tree | **0 branches** | **exit 1**, `PANDA_CONTRACT_WORKSPACE_REMOVAL_REFUSED: refusing to remove 'w-0': its HEAD is …` | **still present** |
| B — the CONTROL, clean, reachable | a branch | exit 0 | **removed**, and `git worktree list --porcelain` no longer names it |

The control is the half that matters: a refusal alone would also be produced by
a panda that refuses everything.

**A PLANT THE IMPLEMENTER'S SIX DID NOT COVER, aimed at the half that is NOT
panda's own check.** Panda's reachability check is silent when there is no
commit, so for an UNTRACKED file git's refusal is the only thing between the user
and loss. Planted `unsaved-notes.txt` — untracked, uncommitted — in a panda
worktree and asked panda to remove it:

- refused, exit 1
- the tree is still in `git worktree list`
- **the user's file survived**
- and the message carries **git's own words**, `modified or untracked`, rather
  than a panda translation of them (correction-01 C5)

That last point is the one worth keeping: panda did not reimplement git's
dirty-tree check, so there is no second answer to drift from git's.

**What the implementer's own mutation round found, and it is the best finding in
this story:** inverting D3 — writing the intent AFTER removing the tree instead
of before — left **all fifteen clauses green**. An end state cannot witness the
ORDER two writes happened in, so every clause that inspects the aftermath is
blind to it. Closed with one synchronous observation taken inside the dying child
at the instant the marker appears — *was the tree still on disk?* — and
re-planting the inversion then reddened exactly that clause. **A crash-safety
ordering guarantee cannot be proven by looking at what is left behind.**

**Two git re-measurements worth carrying forward**, both recorded in the ledger:
`git rev-list <sha> --not --all` is unusable for this check because `--all`
includes other worktrees' HEADs, so it called a commit reachable *because it was
checked out in the tree being removed* — it answered empty for both a reachable
and an unreachable commit, which is a false zero from the instrument. And an
interrupted `git worktree remove` leaves admin gone with the tree present, after
which a retry says `fatal: '<path>' is not a working tree` permanently.

**The gate**: bytes 0, typecheck 12/12, lint 0, **1,516 tests green on Node 24
AND Node 26.8.1** across twelve packages (1,501 before), build 12/12, and
`proof:consumer-install` 10 passed / 1 skipped.

