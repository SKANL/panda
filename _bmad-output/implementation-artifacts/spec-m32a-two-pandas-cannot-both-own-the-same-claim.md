# Spec M32.A — two pandas cannot both own the same claim

**Status:** FROZEN
**Created:** 2026-09-04
**Base commit:** `5de8e8a` (M31.A, CI green on `gates (24)` and `gates (26)`)
**Story:** none. Not an epic story — panda's own `ponytail:` comment named this
gap and its upgrade path; the third DeepSeek Harness pass measured that DSH
ships that upgrade path.

## Intent

`packages/projection/src/ledger.ts:205-214` says it:

> `ponytail:` in-process only, so two panda **PROCESSES** can still interleave
> and lose a claim. A cross-process lock cannot be borrowed from
> `@panda/registry` (AD-2/AD-7: that edge was removed in Story 2.8 and leaked
> `PANDA_REGISTRY_*` codes out of a projection API); **extracting a leaf lock
> package with its own codes is the upgrade path**, recorded in
> `deferred-work.md`.

The ledger is **the only proof of ownership** (`ledger.ts:17-19`). A lost claim
is not a cosmetic loss: panda stops knowing it owns a file it wrote, which the
next `doctor` reports as `foreign-collision`, and which on the materialisation
path removes panda's authority to clean up what it created.

This spec makes the loss impossible instead of unlikely.

## The measurement this rests on

Driven at `5de8e8a` with real child processes. **The control ran first and had to
pass before any concurrent number was believed** — the first version of this
harness failed its control (every writer exited non-zero on module resolution)
and produced a confident, entirely meaningless "24 claims lost".

Harness: N separate `node` processes, each constructing its own
`ProjectionLedger` over one `homeDir` and calling `updateEntry` for its own
`entryId`, released together by a shared wall-clock barrier so the reads overlap
by construction rather than by luck of scheduling.

### M1 — the control

| scenario | writers | claims in the ledger |
|---|---|---|
| **CONTROL — the identical writers, sequential** | 8 | **8, none lost** |

The control is what makes every row below mean something. Eight writers that
lose nothing in sequence prove the harness writes, the record shape is accepted,
and the reader reads.

### M2 — the same writers, concurrent

| round | writers | claims kept | lost |
|---|---|---|---|
| 1 | 8 | 3 | `e2,e3,e4,e5,e7` |
| 2 | 8 | 7 | `e1` |
| 3 | 8 | 4 | `e1,e3,e4,e6` |

**10 of 24 claims lost.** A losing writer exits **0**: it read, it filtered, it
persisted, and a sibling that had read the same earlier document persisted over
it. Nothing reports anything.

### M3 — and a second, different failure mode in the same window

Some concurrent writers exit non-zero at `ledger.ts:396` with

```
PandaError: projection ledger '…' could not be written: EPERM: operation not
permitted, rename '….json.<uuid>.tmp' -> '….json'
  code: 'PANDA_PROJECTION_LEDGER_UNAVAILABLE'
```

Two processes renaming onto the same destination; Windows refuses while another
handle is open. **This one is the better failure** — loud, coded, and it changes
nothing on disk. It is named here so the fix is not measured only against M2 and
so a reviewer does not rediscover it as a regression.

### M4 — the prior art panda already ships

`packages/registry/src/lock.ts` — 283 lines, and the design is right:

- acquired by **exclusive create**, with the holder document written through the
  SAME handle that created the file and only then closed, so *"a contender can
  never observe an empty lock created by us"* (`:164-168`);
- stale-lock breaking with a reported `StaleLockBreak`;
- **ownership-safe release** (`:251-253`): rename the lockfile away FIRST, then
  unlink it only if it still carries our token — *"otherwise we lost an
  acquisition race to a successor and must put their lock back."*

### M5 — the two objections in the ledger's comment, measured

The comment gives two reasons the lock cannot be borrowed. Both are real, and
both dissolve under the same move.

1. **AD-2** — a `projection → registry` edge. Measured:
   `packages/projection/package.json` declares `@panda/contracts` and
   `jsonc-parser`; `packages/registry/package.json` declares `@panda/contracts`,
   `@panda/kernel` and `jsonc-parser`. The edge does not exist and must not be
   created.
2. **AD-7 code leakage** — measured, and **smaller than the comment implies**:
   the lock raises exactly **two** distinct codes, `registryContention` and
   `registryStoreUnavailable`, at five sites. Both already live in
   `@panda/contracts`.

Also measured: `acquireLock` and its four types are **already exported from
`@panda/registry`'s public index** (`registry/src/index.ts:1-2`), so this is not
private machinery being promoted — it is a published surface moving down.

## The decision, and the alternative it refused

**Extract the lock into a dependency-free leaf package with NEUTRAL codes.**
Both `@panda/registry` and `@panda/projection` depend on it. AD-2 holds by
construction: a leaf below both is strictly downward.

Neutral codes are what dissolves objection 2. The leaf raises its own
lock-flavoured codes; `@panda/registry` catches and re-raises
`registryContention` / `registryStoreUnavailable` **exactly as today**, so no
published registry error changes; `@panda/projection` raises its own
projection-flavoured contention code.

**The refused alternative is duplication**, and it was not refused lightly —
panda has chosen duplication for this exact constraint before, and wrote the rule
down at `projection/src/document-fault.ts:22-26`:

> `ponytail:` `@panda/registry` carries its own copy of this, because AD-2
> forbids the edge that would let it import this one … Ceiling: two copies to
> keep in step. **Upgrade path: a shared dependency-free leaf package, worth it
> the first time a third package needs it.**

That rule says duplicate at two, extract at three, and a lock would be the second
consumer. It is refused here anyway, for a reason the rule itself supports:
`document-fault` is roughly forty lines of pure, total functions whose two copies
drift visibly and harmlessly. A lock is 283 lines of concurrency-critical code
with stale-breaking and successor detection, where two copies drifting is the
failure the lock exists to prevent — and this project has already measured that
**a duplicated shape is invisible to a blast-radius graph** (M18.A: *"a
duplicated shape is not an edge — grep as well as query"*). The ceiling named in
the `document-fault` rule is "two copies to keep in step"; for concurrency code
that ceiling is not acceptable, and saying so is the whole content of this
decision.

**This is a MOVE, not new concurrency code.** No new locking algorithm is written
here. If the extraction turns into a rewrite, that is a renegotiation.

## Boundaries & constraints

- **AD-2.** The new package depends on `@panda/contracts` and nothing else. It
  must carry its own `test/guard.test.ts` pinning that, because AD-2 is enforced
  by a guard test in only 4 of 12 packages and a new package arriving without one
  continues a measured trend.
- **AD-7.** The leaf's codes are new entries in `PANDA_ERROR_CODES`. No package
  raises another package's code.
- **No published registry error changes.** `@panda/registry` keeps raising
  `registryContention` and `registryStoreUnavailable` from the same five
  situations. This is pinned by a test, not by intent.
- **`acquireLock`'s behaviour does not change.** Exclusive create, holder written
  through the creating handle, stale-break reporting, ownership-safe release with
  successor restoration — all preserved verbatim.
- **The in-process queue stays.** `LEDGER_QUEUES` is not replaced by the file
  lock; it is cheaper and it is correct for its own case. The file lock is the
  outer boundary.
- **The `ponytail:` comment at `ledger.ts:205-214` must be updated or deleted.** A
  comment that describes a gap that no longer exists is a comment that lies, and
  this project has shipped three of those.
- All code, comments and identifiers in English.

## I/O & edge-case matrix

| situation | expected |
|---|---|
| one process, one write | unchanged; no lock contention observable |
| N processes, concurrent writes | **all N claims present.** This is M2's row and it is the whole point |
| N processes, concurrent writes | **no `EPERM` rename failure** (M3) |
| a process dies holding the lock | the stale-break path fires and is REPORTED, not silent |
| lock held longer than the timeout | coded contention error, and the ledger document is untouched |
| ledger unreadable while the lock is held | today's refusal is preserved: `projectionLedgerUnavailable`, nothing overwritten |
| registry store contention | **still `PANDA_REGISTRY_CONTENTION`** — pinned |
| registry lock write failure | **still `PANDA_REGISTRY_STORE_UNAVAILABLE`** — pinned |

## Tasks & acceptance

1. **AC1 — the loss is gone, and the control still passes.** The M1/M2 harness,
   unchanged, run against the fix: sequential 8 → 8 (control), concurrent 8 → 8,
   over at least 5 rounds. A run where the CONTROL fails is a run that measured
   nothing and must be reported as such, not as a pass.
2. **AC2 — M3's `EPERM` is gone too.** No concurrent writer exits non-zero. If a
   writer legitimately loses a contention race, it exits with the coded
   contention error and the ledger on disk is intact — state which.
3. **AC3 — no registry error changed.** Drive the registry's contention path and
   assert `PANDA_REGISTRY_CONTENTION` and `PANDA_REGISTRY_STORE_UNAVAILABLE`
   still surface from the same situations.
4. **AC4 — AD-2 is enforced, not stated.** The new package carries
   `test/guard.test.ts` pinning its dependency set by exact equality, in the
   shape `environment/test/guard.test.ts` already uses. Falsify it: a planted
   upward import is reported as exactly one violation naming only that package.
5. **AC5 — falsified.** Removing the lock acquisition from the ledger's write
   path turns AC1 red. Run the revert; state which assertion reddens.
6. **AC6 — the comment no longer lies.** `ledger.ts:205-214` is updated to
   describe what is now true, or deleted.
7. **AC7 — the gate.** `pnpm check` green on Node 24 **and** 26, plus
   `pnpm build && pnpm proof:consumer-install`. The new package must be added
   wherever the proof enumerates workspace packages — `03a6b89` exists because
   that list was once incomplete.

## Ask First

File a renegotiation rather than implementing past any of these:

- If the extraction cannot be a MOVE — if preserving `acquireLock`'s behaviour
  requires rewriting the algorithm rather than relocating it and renaming two
  codes.
- If a neutral-code leaf turns out to require an edge this spec did not
  anticipate, or if `@panda/kernel` (which `registry` depends on and `projection`
  does not) is reachable from the lock.
- If holding a file lock across the ledger's read-modify-write introduces a
  deadlock with the registry's own lock on any path where both are held.
- If the concurrent harness cannot be made to pass its control on Node 26 as
  well as 24.
- If M3's `EPERM` turns out to survive the fix, which would mean the rename
  contention has a second source this spec has not found.

## Spec change log

- 2026-09-04 — frozen at `5de8e8a`. Duplication refused with its reason recorded
  above, against a rule in this repo that would otherwise have permitted it.

## Verification

Landed as **NARROWED**, not closed. That word is this ledger's own
(`deferred-work.md` carries 9 of them across 225 entries), and the entry it
answers is the one against `spec-2-8`, which named this exact gap and this exact
fix: *"Two panda PROCESSES can still interleave and lose a claim … Cross-process
needs a real lock, which cannot be borrowed from `@panda/registry` (AD-2/AD-7) —
the upgrade path is a leaf lock package with its own error codes."* M32.A is that
upgrade path arriving.

### AC1 — RESTATED, NOT MET AS WRITTEN

The clause asked for `concurrent 8 → 8` over at least 5 rounds. **That criterion
is itself a bet and is not recorded as a pass.**

Measured on this tree, control green in every run: **62 concurrent rounds × 8
writer processes = 496 processes; 12 claims absent, 7 of them announced by a
coded refusal; 5 SILENT losses — 1.0%.** Four of the 62 rounds carried a silent
loss, so a 5-round clause goes green ≈72% of the time against a tree that still
loses claims. AC1's own bar would have reported a pass roughly two runs in three.

What IS established, same harness, same machine: `5de8e8a` lost **≥57 of 96
claims silently (≥59%)** and killed 16 writers with `EPERM` on the ledger
document's rename.

**The residual is not the gap this story set out to close.** It is
`acquireLock`'s stale-break TOCTOU, byte-identical to `5de8e8a`, reachable from
`RegistryStore.register` with or without this change. Renegotiation
`renegotiation-m32a-01-the-stale-break-unlinks-a-successors-lock.md`.

**No `N processes keep all N claims` clause is committed**, deliberately. At 6.5%
per round it would be red one run in four with nothing changed AND green two runs
in three with the defect live — both directions of the failure
`packages/registry/test/lock.test.ts:172-181` already names. The clauses that DO
ship force their premise: `ledger-lock.test.ts:64-65` writes its own pid into the
lockfile; `:99` takes a pid from a child that has provably exited;
`packages/lock/test/lock.test.ts:40-41` holds the lock for the whole clause.

### AC2 — REDUCED ~40×, NOT ELIMINATED

The destructive `EPERM` on the **ledger document**'s rename went from 16 of 96
writers at `5de8e8a` to **1 of 160** on this tree — and in that occurrence every
writer reported `breaks=[]`, so no stale break was involved and the mechanism is
unexplained. It was non-destructive: the refusing writer's id was exactly the
missing claim and the document held the rest.

A second `EPERM` appears on the **lockfile**, coded
`PANDA_PROJECTION_LEDGER_UNAVAILABLE` ← `PANDA_LOCK_UNAVAILABLE`, from the
release-restore branch. That is this same TOCTOU seen from the successor's end.

Saying "gone" here would be the claim this project's whole defect class is about.
It is reduced.

### AC3, AC4, AC6, AC7 — GREEN

- **AC3** — no published registry error changed. `PANDA_REGISTRY_CONTENTION` and
  `PANDA_REGISTRY_STORE_UNAVAILABLE` still surface from the same situations,
  now carrying the leaf's code as `cause`. `packages/registry` 189/189 with
  `lock.test.ts` and `contention.test.ts` unmodified.
- **AC4** — falsified. A planted `import type { RegistryStore } from
  '@panda/registry'` in `packages/lock/src/index.ts` produced
  `expected [ '@panda/registry' ] to deeply equal []` — exactly one violation,
  naming only that package.
- **AC6** — the lying `ponytail:` comment is replaced (`ledger.ts:219-230`).
- **AC7** — typecheck 13/13, lint clean, bytes clean, build 13/13,
  `proof:consumer-install` 10 passed / 1 skipped, with `'lock'` added to
  `PACKAGE_DIRS` (`consumer-install.proof.ts:57`). Suites green on Node 24 and
  Node 26 apart from the known local-only `skills-discovery.live` reds.

### AC5 — GREEN, and driven by the COORDINATOR rather than inherited

The implementer reported AC5 green; the only revert driver in `.scratch/` targets
`store.ts` and `doctor.ts`, which are **M31.A's** halves. So it was re-driven
here: `#queued`'s `.then(() => this.#locked(work))` reverted to `.then(work)`,
edit confirmed at the line before running, `ledger-lock.test.ts` → **2 of 3
clauses red** (the contention clause and the stale-break observer clause).
Restored, 3/3 green. The clauses are not theatre.

### What the follow-up spec must cover, and why it is not optional

1. `breakLock` unlinks by PATH with no token check
   (`packages/lock/src/lock.ts:165-172`), while `releaseAcquired` in the same
   file renames aside, re-reads, unlinks only on token match and otherwise
   restores the successor's lock — and states that rule in a comment. The file
   applies its own rule in one place and not the other.
2. **BOTH break call sites**, `:228` (dead pid or `maxAgeMs`) and `:247`
   (corrupt lockfile). The second is worse: its own evidence string says
   *"breaking regardless of host"*, so it can unlink a cross-host successor's
   live lock. Fixing one and leaving the other is the sibling-leak failure one
   story later.
3. **The leaf has zero tests of its break path.** Measured: `stale|break` over
   `packages/lock/test/` → 0; control `acquire` → 5. `LockOptions` has a
   `beforeReleaseVerify` seam and no break-time counterpart, so a forced
   three-way clause needs one added.
4. **The third contender**, named rather than inherited: the rename momentarily
   frees `path`, so someone can create a lock there and the restore branch would
   rename over it. `releaseAcquired` answers this by never restoring over a file
   it did not move; the break path must make that argument explicitly.
5. Its AC1 is a **registry-arm** measurement, because `epics.md:237` — Story
   2.1's criterion, and Story 2.1 is `done` — says *"two concurrent panda
   processes writing the Registry produce a typed contention error naming the
   holder, never lost updates"*, and that is where user data is silently lost.

### Two measurements this landing does NOT claim

- **The registry arm was not A/B'd.** The coordinator drove it at base (working
  tree stashed, control green): 30 rounds × 8 writers = 240 processes, **zero**
  silent losses. The implementer saw 1 in 80. Both are consistent with a rare
  event — the break path only fires once a holder's pid is gone, which is rare in
  health and normal after a kill, i.e. exactly when stale-breaking is what you
  are relying on. Nobody has rated it.
- **The ledger-document `EPERM` seen once in 160** has no explained mechanism.
