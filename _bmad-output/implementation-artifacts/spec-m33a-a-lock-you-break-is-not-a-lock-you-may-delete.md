# Spec M33.A — a lock you break is not a lock you may delete

**Status:** FROZEN
**Created:** 2026-09-04
**Base commit:** `bcc0923` (M32.A, CI green on `gates (24)` and `gates (26)`)
**Story:** none as a board row — but this is the one item here that makes a
**shipped story's acceptance criterion true.** See § "What this is really about".

## Intent

`acquireLock`'s stale-break path deletes a lockfile **by path**, without ever
checking that the file still carries the holder it judged stale. So it can
delete a live successor's lock, and two processes end up holding one lock.

The same file states and applies the opposite rule 100 lines away.
`releaseAcquired` (`packages/lock/src/lock.ts:261-264`):

> Ownership-safe release: rename the lockfile away FIRST, then re-read the
> renamed file and unlink it **ONLY if it still carries our token**; otherwise we
> lost an acquisition race to a successor and must put their lock back.

`breakLock` (`packages/lock/src/lock.ts:165-172`) is:

```ts
async function breakLock(path: string): Promise<void> {
  try { await unlink(path) } catch (error) { … }
}
```

The file knows the rule, implements it, **and pins it with a three-party test**
(`packages/registry/test/lock.test.ts:167`) — and then does not apply it at the
other site. That is this project's own defect class, inside the function it
matters most in.

## What this is really about

`_bmad-output/planning-artifacts/epics.md:237` is Story 2.1's acceptance
criterion, and `sprint-status.yaml` marks Story 2.1 `done`:

> two concurrent panda processes writing the Registry produce a typed contention
> error naming the holder, **never lost updates** (FR-11, AD-4, AD-7)

That criterion is not kept, and nothing tests it across processes. This spec is
what makes it true — which is why it goes before the two enhancement items
queued behind it.

## The measurement this rests on

> **THIS SECTION WAS FROZEN WITH A FALSE MEASUREMENT AND IS CORRECTED IN PLACE.
> The correction is the most useful thing in this spec, so the wrong version is
> described rather than deleted.**

### What was frozen, and why it was wrong

The frozen text claimed the defect was *"forced, not raced"* by a process-level
harness — two contenders released at a barrier against a planted stale lock,
`5 runs of 5` showing **2 acquirers** against a control of 0.

**It measured a LEGITIMATE break.** Its contenders EXITED as soon as they held.
So the second contender arrived, found a holder whose pid was now genuinely dead,
and broke that lock lawfully. The harness was reporting correct behaviour and
calling it the bug — with a green control, five times out of five, because the
control (a live holder that never releases) exercises a different path entirely.

Corrected in three steps, each found by reasoning about the mechanism rather than
by looking at the number:

1. Holders made to STAY ALIVE while holding → still 2 acquirers.
2. A/B against base with the fix stashed → base gave **2** as well, so the
   harness was not discriminating.
3. Holder made to outlast the contender's timeout (hold 6s, `timeoutMs` 1500) →
   **base and fixed BOTH give exactly 1.** The second contender had simply been
   waiting out the first's 2-second hold inside its own 3-second budget and then
   breaking a genuinely dead holder's lock.

**A process-level harness cannot place this interleaving at all.** The window
between the break's read and its write is a few statements wide. That is not a
weakness of the harness; it is why the spec asks for a seam.

### What the defect actually is, driven through the seam

In-process, with `beforeBreakVerify` planting a live successor's lock in the
freed path — the only way to force the window:

| `breakLock` body | seam fired | breaker | lockfile afterwards |
|---|---|---|---|
| **pre-M33.A** (`unlink(path)`) | 1 | **acquired** | the **breaker's** token — the successor's live lock was deleted |
| **M33.A** (rename → verify → unlink-or-restore) | 1 | refused `PANDA_LOCK_CONTENTION` | `SUCCESSOR` — it survived |

`seamFired >= 1` is the control: a clause where the seam never ran would pass
while forcing nothing, which is exactly how the first measurement lied.

### What this changes about the defect's severity

The defect is **real** — the table above is deterministic and falsifiable — but
the frozen spec's implication that two ordinary concurrent processes reproduce it
readily is **not established**. Nobody has rated it. What is established: the
window exists, it is reachable, and the code deletes a live successor's lock when
execution lands in it.

`breakLock` is byte-identical to `5de8e8a`; the M32.A extraction moved it and did
not introduce it.

## The design

**The fix is not "check before unlink" — a check before an unlink is the same
TOCTOU one line later.** The primitive that already works in this file is
`rename`, because exactly one process can rename a given file away; the loser
gets `ENOENT`. `releaseAcquired` uses it that way. The break path must too:

1. `rename(path, <path>.<uuid>.breaking)` — **this is the mutual exclusion.** Two
   breakers cannot both pass it.
2. Re-read the renamed file.
   - It still carries the token judged stale → it really is the dead holder's.
     `unlink` it and loop to retry acquisition; the path is now free.
   - It carries **anything else** → a successor's live lock was moved. Put it
     back with `rename` and loop.
3. `ENOENT` at step 1 → someone else already broke it. Loop.

Applied at **BOTH** call sites — `lock.ts:228` (dead pid or `maxAgeMs`) and
`lock.ts:247` (corrupt lockfile). The second is the more dangerous one: its own
evidence string says *"breaking regardless of host"*, so today it can unlink a
**cross-host** successor's live lock. Fixing one and leaving the other is the
sibling-leak failure one story later, and this spec names it so that cannot
happen quietly.

For the corrupt case there is no token to judge, so the identity to verify is the
**document bytes** read at judgement time. State that in the code, because it is
a different identity than the dead-pid case and a reader will otherwise assume
one rule.

### The residual, named rather than inherited

Step 2's restore has a window: the rename in step 1 frees `path`, so a third
contender can create a lock there, and the restore would rename over it.

**`releaseAcquired` has the identical window and does not argue about it** — it
is where M32.A's once-in-160 `EPERM` comes from. Two facts to record rather than
solve here:

- On Windows a rename onto an existing open file **fails** — which is why the
  symptom is a loud coded `EPERM` and not silent loss. That is the safe
  direction.
- On POSIX `rename` **silently replaces** the destination. The same window is
  therefore quieter on Linux than on Windows, and CI runs Linux.

Do not widen this spec to close that window. Record it, in the code comment and
in `deferred-work.md`, with the observation that the release path has carried it
since 2.1 — and that it is the next thing to look at if a claim is ever lost
after this ships.

## Boundaries & constraints

- **The break path needs an injection seam**, mirroring `beforeReleaseVerify`
  (`packages/lock/src/lock.ts:63-66`), awaited the way that one is. Without it
  the three-way clause cannot force its premise, and `packages/registry/test/lock.test.ts:172-181`
  records what happens then: an un-awaited version of the sibling clause *"lost
  on Node 24 in CI while passing on Node 26, and it would equally have PASSED on
  a build where the restore was broken."*
- **The clause lives in `@skanl/panda-lock`'s own suite.** Measured: `stale|break` over
  `packages/lock/test/` → **0**, control `acquire` → 5. The leaf currently pins
  only that its codes are neutral, and its algorithm is pinned inside a consumer.
- **No published code changes.** `PANDA_LOCK_CONTENTION` / `PANDA_LOCK_UNAVAILABLE`
  and the registry's translated pair keep their meanings.
- **Stale-breaking must still work.** A genuinely dead holder's lock is still
  broken, and the `StaleLockBreak` observer still fires with its evidence. A fix
  that makes the break path refuse to break is a regression, not a fix.
- **AD-7**: route on `error.code`, never message text.
- All code, comments and identifiers in English.

## I/O & edge-case matrix

| situation | expected |
|---|---|
| holder alive, never releases | **0 acquirers**, both coded `PANDA_LOCK_CONTENTION` (today's behaviour, must not change) |
| holder provably dead, one contender | it breaks and acquires; `onStaleBreak` fires naming the pid and `ESRCH` |
| holder provably dead, TWO contenders, forced stagger | **exactly 1 acquirer.** This is the defect row |
| holder dead, a successor acquires inside the break window | the successor keeps its lock; the breaker loops and either waits or times out coded |
| lockfile corrupt and older than `corruptGraceMs` | broken only if the bytes still match what was judged; otherwise loop |
| lockfile corrupt, a successor replaced it mid-break | successor's lock survives |
| `maxAgeMs` exceeded on a LIVE holder | unchanged: still broken, still reported |
| lockfile vanished between read and break | loop, no throw |

## Code map

| file | change |
|---|---|
| `packages/lock/src/lock.ts:165-172` | `breakLock` takes the identity judged stale and becomes rename → verify → unlink-or-restore |
| `packages/lock/src/lock.ts:228` | pass the holder token judged stale |
| `packages/lock/src/lock.ts:247` | pass the document bytes judged corrupt; comment why the identity differs |
| `packages/lock/src/lock.ts:63-66` | `LockOptions` gains the break-time seam beside `beforeReleaseVerify` |
| `packages/lock/test/lock.test.ts` | the FORCED three-way clause, plus a clause that stale-breaking still works |
| `packages/registry/test/lock.test.ts` | unchanged if possible; if a clause moves, say which and why |

## Tasks & acceptance

1. **AC1 — the forced harness inverts.** `.scratch/force-double-hold.mjs`
   unchanged: CONTROL still **0 acquirers**, DEFECT row now **1**. Run it at
   least 5 times and report every run, because 5-of-5 is what makes it a forced
   result rather than a lucky one.
2. **AC2 — the registry arm, which is what `epics.md:237` governs.** Drive
   `RegistryStore.register` from concurrent processes with a green sequential
   control, and report the numbers. The pre-fix rate is unrated — the implementer
   saw 1 loss in 80, the coordinator 0 in 240 at base — so **report what you
   measure and do not claim a rate you did not establish.**
3. **AC3 — stale-breaking still works.** A genuinely dead holder's lock is still
   broken and `onStaleBreak` still fires with its pid and `ESRCH`. A fix that
   passes AC1 by never breaking anything fails here.
4. **AC4 — both call sites.** Drive the corrupt-lockfile path too, not only the
   dead-pid path. State the evidence for each separately.
5. **AC5 — committed as a FORCED clause in `@skanl/panda-lock`'s own suite**, using the
   new seam. It must fail with the fix reverted; run the revert and say which
   assertion reddens.
6. **AC6 — the residual is recorded**, in the code comment and in
   `deferred-work.md`, including that `releaseAcquired` has carried the same
   window since 2.1 and that POSIX silently replaces where Windows fails loud.
7. **AC7 — the gate.** `pnpm check` on Node 24 **and** 26, plus
   `pnpm build && pnpm proof:consumer-install`.

## Ask First

- If rename-aside turns out not to be atomic-enough on Windows for the mutual
  exclusion in step 1 — measure it, do not assume it.
- If closing the break window requires closing the release window too, i.e. if
  the two cannot be separated. That is a widen, and it needs saying before it is
  done.
- If the corrupt-lockfile identity (document bytes) cannot be captured at
  judgement time without a second read that reopens the same TOCTOU.
- If making the break path correct forces a change to a published code or to
  `StaleLockBreak`'s shape.
- If the forced harness stops being deterministic on Node 26.

## Spec change log

- 2026-09-04 — frozen at `bcc0923`. The defect was forced 5 times out of 5 with a
  green control before a line of this was written.

## Spec change log addendum

- 2026-09-04 — **the frozen measurement was FALSE and is corrected in place**, not
  deleted. The implementer stalled mid-story; the coordinator finished it and
  found the error while trying to drive AC1. See "The measurement this rests on".

## Verification

Driven by the coordinator after the implementer stalled with the source change
complete and no clause written. HEAD was clean; nothing had been committed.

**AC1 — RESTATED. The criterion as frozen is unmeasurable.** It asked the
process-level harness to invert from 2 acquirers to 1. Corrected, that harness
gives **1 on base as well** — it never measured the defect. Replaced by the
in-process seam-driven table above, which is deterministic in both directions.

**AC3 — GREEN.** `still breaks a lock whose holder is provably dead, and reports
it`: the breaker acquires, `onStaleBreak` fires once, the evidence names `ESRCH`.
This clause exists because a break path that refuses to break passes AC1's
successor clause while destroying the feature.

**AC5 — GREEN, falsified surgically.** Reverting only `breakLock`'s body to
`unlink(path)` — keeping the seam so the clause can still place the successor —
reddens **exactly one** assertion, `leaves a successor's live lock alone when it
acquires inside the break window`, and leaves the other nine green. Restored:
10/10.

**AC6 — GREEN.** The residual is in the `ponytail:` comment on `breakLock` and in
`deferred-work.md`: the restore has a window, `releaseAcquired` has carried the
identical one since Story 2.1, and POSIX `rename` silently replaces where Windows
fails loud — so the same window is quieter on Linux, which is what CI runs.

**AC2 and AC4 — NOT DRIVEN, and named rather than glossed.** The registry-arm
measurement and the corrupt-lockfile call site were not separately driven here.
The corrupt site takes the same `breakLock`, with document BYTES as its identity
instead of a token, and is covered by typecheck and by the existing suite — but
no clause forces a successor into ITS window. Recorded in `deferred-work.md`.
