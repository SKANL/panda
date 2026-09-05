# Renegotiation M32.A-01 — the stale break unlinks a successor's lock

**Against:** `spec-m32a-two-pandas-cannot-both-own-the-same-claim.md` (FROZEN)
**Clause invoked:** *Ask First* — "If the extraction cannot be a MOVE — if
preserving `acquireLock`'s behaviour requires rewriting the algorithm rather
than relocating it and renaming two codes."
**Raised:** 2026-09-04, at base `5de8e8a` + the M32.A working tree
**Status:** BLOCKING AC1 and AC2. The move itself is done and green; this is
about one function inside it.

## The short version

The move works and closes 99% of the window. It does not close all of it,
because **`acquireLock`'s stale-break path has a TOCTOU that lets two processes
hold the lock at the same time**, and no amount of work at the ledger can fix
that from outside. The defect is in `breakLock`, it is byte-identical to what
`@panda/registry` shipped at `5de8e8a`, and it is reachable from
`RegistryStore.register` today.

Fixing it means changing `acquireLock`'s concurrency behaviour. The spec froze
that as a MOVE. Hence this document rather than a commit.

## What was measured

The spec's own harness, unchanged apart from a round-count argument, against the
M32.A tree. **The control passed in every run below**; a run whose control fails
is reported as having measured nothing, and none did.

| run | control | concurrent rounds | writers | claims lost | non-zero exits |
|---|---|---|---|---|---|
| A | 8/8 PASS | 8 | 8 | **2** (round 4 `e7`, round 8 `e2`) | 0 |
| B | 8/8 PASS | 6 | 8 | 0 | 0 |
| C | 8/8 PASS | 6 | 8 | **1** (round 4 `e3`) | 0 |
| D | 8/8 PASS | 6 | 8 | 0 | 0 |
| E | 8/8 PASS | 10 | 8 | 0 | 0 |

**3 claims lost out of 288** (36 concurrent rounds × 8 writers), against **10 of
24** at base. Every losing writer still exits `0`. Nothing reports anything —
the same silence the spec's M2 describes, at a fortieth of the rate.

A single ten-round run came back clean (run E), which is exactly why no run is
reported as a pass on its own. AC1 asks for at least five rounds; five rounds
would have gone green four times out of five here and said nothing true.

M3's `EPERM` is **gone**: zero non-zero exits across all 26 rounds, and zero
across a further 30 rounds of an instrumented variant. That row of the I/O
matrix is satisfied.

## The mechanism, traced rather than reasoned

A trace was added to `acquireLock` and to `ProjectionLedger.#locked`, run until a
round lost a claim, and then removed. Timestamps are `Date.now()` in each child,
one machine, one clock. Trimmed to the two writers that collide:

```
...958551 pid=34936 acquired 98b76f25          <- holder H
...958562 pid=34936 released 98b76f25          <- H releases, then EXITS
...958563 pid=35076 LOCK saw held 34936/98b76f25   <- read completed after H died
...958563 pid=18776 LOCK saw held 34936/98b76f25
...958573 pid=35076 LOCK BREAK-STALE holder 34936 is provably dead (ESRCH); breaking stale lock
...958575 pid=35076 LOCK created-wx            <- 35076 now holds the lock
...958576 pid=18776 LOCK BREAK-STALE holder 34936 is provably dead (ESRCH); breaking stale lock
...958578 pid=18776 LOCK created-wx            <- 18776 ALSO holds the lock
...958579 pid=35076 acquired cf41dccf
...958581 pid=35076 read readable [e0,e3,e4]
...958583 pid=18776 acquired 447268b3
...958585 pid=18776 read readable [e0,e3,e4]   <- same read, two holders
```

Both then persisted from the same read. One claim died.

The sequence is:

1. Contender X reads the lockfile and captures `held by H`.
2. H releases (renames the lockfile away, unlinks it) and its process exits.
3. A successor S wins the free `path` and writes its own holder document.
4. X — still holding the *captured* state from step 1 — asks
   `isHolderDead(H.pid)`. H really is dead, so the answer is a correct `true`.
5. X calls `breakLock(path)`, which is:

   ```ts
   async function breakLock(path: string): Promise<void> {
     try {
       await unlink(path)
     } catch (error) { … }
   }
   ```

   **It unlinks by PATH.** It never checks that the file still carries the
   holder that was judged stale. So it deletes S's live lock.
6. X creates its own lock. X and S both hold it.

The judgement in step 4 is right and the action in step 5 is wrong: the evidence
was gathered about a document that no longer exists at that path.

`packages/lock/src/lock.ts` already knows the correct discipline and applies it
to the RELEASE path (`releaseAcquired`): *"rename the lockfile away FIRST, then
re-read the renamed file and unlink it ONLY if it still carries our token;
otherwise we lost an acquisition race to a successor and must put their lock
back."* The break path is the one place that rule is missing.

## M3's `EPERM` moved rather than survived — and it moved because of this

The spec's *Ask First* also says: *"If M3's `EPERM` turns out to survive the fix,
which would mean the rename contention has a second source this spec has not
found."* The honest answer is **half**, and the half that remains is this same
defect.

M3's `EPERM` was on the LEDGER DOCUMENT's rename
(`….json.<uuid>.tmp -> ….json`, `ledger.ts:396`). **That one is gone.** The
document is now only ever renamed while its lock is held, and across 26 rounds
on Node 24 and 58 on Node 26 not one writer failed there.

A DIFFERENT `EPERM` appears, on the LOCKFILE, caught on Node 26 at round 11 of
40:

```
PandaError: projection ledger '…\projection-ledger.json' could not be locked for
writing: lock release failed on '…\projection-ledger.json.lock': EPERM:
operation not permitted, rename
'…\projection-ledger.json.lock.13f51523-….releasing' ->
'…\projection-ledger.json.lock'
  code: 'PANDA_PROJECTION_LEDGER_UNAVAILABLE'
  [cause] code: 'PANDA_LOCK_UNAVAILABLE'   at lock.ts:291  (releaseAcquired)
```

`lock.ts:291` is the RESTORE branch — *"not ours anymore: restore whatever we
renamed so the real holder's lock keeps protecting the store."* It can only run
when the file this process renamed away did **not** carry this process's token,
which can only happen when someone broke our live lock and put their own there.
It is the stale-break TOCTOU, observed from the other end.

For the record on AC2's second half: in that round the ledger held **7 of 8**,
the refusing writer was `e2`, and `e2` was exactly the missing claim. So the
document on disk was intact and held every other claim — the loud, coded, non-
destructive failure the spec asks for. Nothing was corrupted; one writer was
told, in code, that it did not get its turn.

## This is not a regression the move introduced

`breakLock` in the new leaf is byte-identical to `5de8e8a`:

```
$ git show 5de8e8a:packages/registry/src/lock.ts | grep -A7 '^async function breakLock'
154:async function breakLock(path: string): Promise<void> {
155-  try {
156-    await unlink(path)
…
$ grep -A7 '^async function breakLock' packages/lock/src/lock.ts
165:async function breakLock(path: string): Promise<void> {
166-  try {
167-    await unlink(path)
…
```

## And it is already losing user data in `@panda/registry`

Not a projection-only concern. Eight processes each calling
`RegistryStore.register` behind a shared barrier, control first:

```
CONTROL sequential   store holds 8/8
round 1              store holds 8/8
round 2              store holds 8/8
round 3              store holds 7/8  LOST s1
round 4 … 10         store holds 8/8

SILENTLY lost (missing beyond the writers that refused): 1; coded refusals: 0
```

**A registered entry vanished with every writer exiting 0 and nothing raised.**
Driver: `.scratch/m32a-registry-measure.mjs` + `.scratch/m32a-registry-writer.mjs`.
This is present at `5de8e8a` and reachable from `panda init` whenever two runs
overlap; it is not created by this spec and it does not go away if this spec is
abandoned.

## What the fix would be, and why it is not in this commit

Apply the release path's own rule to the break path — rename-then-verify instead
of unlink-by-path, keyed on the token that was judged stale:

```ts
async function breakLock(path: string, judged: LockFileState): Promise<void> {
  const movedAside = `${path}.${randomUUID()}.breaking`
  try {
    await rename(path, movedAside)
  } catch (error) { /* ENOENT: someone else broke it; just retry the loop */ }
  const current = await readLockFile(movedAside)
  if (stillTheDocumentWeJudged(current, judged)) {
    await unlink(movedAside)          // genuinely stale: gone
  } else {
    await rename(movedAside, path)    // a successor's live lock: put it back
  }
}
```

Roughly fifteen lines, in the most safety-critical function panda has, with at
least one residual the design has to answer for: the rename momentarily frees
`path`, so a third contender can create a lock there and the restore branch
would then rename over it. The release path has the same shape and answers it by
never restoring over a file it did not move — the break path needs the same
argument made explicitly, plus a test that forces the three-way interleaving
rather than betting on it.

That is **new concurrency code**. The spec says, twice and in bold, that this is
a MOVE and that "if the extraction turns into a rewrite, that is a
renegotiation". So it is filed rather than written.

## What is asked

One of:

1. **Widen M32.A** to cover the stale-break TOCTOU, with its own measurement and
   its own forced-interleaving test, and accept that `acquireLock` changes.
2. **Split it**: land the move as it stands (it is green, it closes M3 entirely
   and 95% of M2, and it changes no published error), and open a follow-up spec
   for the break path — noting that until that lands, AC1 and AC2 cannot be
   claimed and the registry keeps its own silent loss.
3. Something else.

Option 2 leaves a spec whose headline acceptance criterion is not met, which is
worth saying out loud rather than burying in a verification section.

## State of the working tree while this is open

Implemented, uncommitted, and green apart from the acceptance criteria this
document blocks:

- `packages/lock/` — the new leaf, `@panda/contracts` and nothing else, with
  `test/guard.test.ts` and a neutral-code pin. 8 tests pass.
- `packages/registry/src/lock.ts` — the translating façade; 189 registry tests
  pass, including `lock.test.ts` and `contention.test.ts`, so no published
  registry error changed.
- `packages/projection/src/ledger.ts` — `#locked` around the read-modify-write;
  the lying `ponytail:` comment replaced.
- `packages/contracts/src/errors.ts` — `lockContention`, `lockUnavailable`,
  `projectionLedgerContention`.
- `packages/session/test/consumer-install.proof.ts` — `'lock'` added to
  `PACKAGE_DIRS`.
- `packages/contracts/test/topology.test.ts` — **the spec did not name this
  file.** It is the repo-wide AD-2 gate, and it pins a TIER for every package by
  exact equality in both directions, so a new package cannot be added without
  placing it in the order. `@panda/lock` is a genuinely new layer: it sits on
  `@panda/contracts` (so it cannot join tier 0, where the rule is "imports
  nothing at all"), and both `registry` and `projection` import it (so it cannot
  sit beside them). The order gained tier 1 and everything above shifted by one.
  Worth flagging because the spec's M5 measurement says "AD-2 is enforced by a
  guard test in only 4 of 12 packages" — true of the per-package guards, and
  silent about the graph-wide one that actually caught this.

`pnpm typecheck` passes for all 13 packages; `pnpm lint`, `pnpm build` and
`pnpm proof:consumer-install` all pass.

## Drivers, kept for whoever picks this up

- `.scratch/measure-ledger-race.mjs` — the spec's harness, plus a round-count
  argument (`node .scratch/measure-ledger-race.mjs 8`). Control first, always.
- `.scratch/m32a-measure.mjs` + `.scratch/m32a-writer.mjs` — instrumented
  variant; reports per-writer outcome and stale breaks on loss.
- `.scratch/m32a-trace-run.mjs` — runs rounds until one loses, then prints the
  interleaved trace. Needs the traces re-added to `lock.ts` / `ledger.ts`; they
  were removed before this was written.
- `.scratch/m32a-registry-measure.mjs` + `.scratch/m32a-registry-writer.mjs` —
  the registry arm.
