---
title: 'Roadmap 03 — the empty board, and what an empty board is not'
type: 'roadmap'
supersedes_scope_of: 'ROADMAP-02 (its milestones all shipped; its NFR-8 diagnosis is corrected below)'
created: '2026-09-04'
validation: 'measured'
---

# Roadmap 03 — the empty board

## The situation

The story board has **62 rows and none open**. Every epic is closed, the last
one (`2-6`) by measurement rather than by building it.

An empty board is not a finished product, and the gap between those two
sentences is what this document is for. Nothing below is a story anyone forgot.
It is what the work itself produced and what a 201-entry ledger re-measurement
(M24.A) separated from the 23 entries that were simply wrong.

## What the measurements say now

### The board's own vocabulary ran out before the product did

Every remaining item arrived as a by-product of shipping something else — a
ledger entry, a review finding, a lens. None came from an epic. That is not a
planning failure; it is what happens when the specified work is done and the
measured work is not.

### The ledger is now trustworthy, and it was not

M24.A drove all 201 entries against HEAD: **23 were wrong or already closed**,
11% of the artifact this project uses to decide what to build next. They are
marked in place with the re-measurement appended. So the piles below rest on
entries that were checked, which was not true of any previous roadmap.

### ROADMAP-02's NFR-8 diagnosis was wrong, and the correction is the method

It read *"NFR-8 … unimplementable while every package is private and
**unversioned**"*, which frames the version NUMBER as the blocker. It is not.
"Contracts semver together" is twelve manifests AGREEING, and they can disagree
at `0.0.0` exactly as easily as at `1.4.2`. M22.A wired it at `0.0.0` and moved
no version. **Re-measure the reason, not the entry** — five deferrals in one
session had a reason that had expired while the entry had not noticed.

## Diagnosis

The remaining work is not thirty items. It is **four roots and one decision**,
and the items are symptoms that group cleanly. Attacking them one by one would
grow the system; attacking the roots shrinks it.

## Milestones

### M27 — Panda takes back everything it makes

*The root: panda writes durable state whose removal is narrower than its
creation.* Panda's identity is "ownership tracked so it can undo exactly what it
wrote and nothing else." Three places do not hold up their half.

- **27.A — the local provider's workspaces have no exit.** Measured: `panda
  workspace remove` says "takes back a **worktree** panda made", and the default
  provider is `local`, whose per-run directories under `.panda/workspaces`
  accumulate with no verb. Two `panda run`s leave two UUID directories and
  `workspace remove` answers "nothing to remove".
- **27.B — a remediation's write has no coded boundary. SHIPPED, and designing
  it corrected this entry twice.** It did not escape UNCODED, which would be the
  ordinary hole. It escaped FALSELY coded: `describe()` duck-types `.code`, a
  Node errno has one, so the user read `EPERM: EPERM: … rename
  '<file>.<uuid>.tmp'` — doubled, leaking the temporary path, and at exit 2 where
  every sibling refusal exits 1. And the trigger fired ONCE, not three times:
  four call sites, of which `engine.ts:204` and `materialise.ts:785` are wrapped
  by their callers and `ledger.ts:394` codes panda's OWN document, leaving
  `config-write.ts:158` (coded, the first non-engine caller) and
  `remediate.ts:530` (bare). The model is `config-write.ts`, not `ledger.ts` —
  same non-engine caller, same VENDOR-file target.
- **27.C — CLOSED, and it should never have been listed.** `deferred-work.md`
  already rejects a `restore` verb on evidence, and M24.A re-drove that entry
  against HEAD and left it standing: a verb rendering one entry straight into a
  vendor file is a SECOND renderer beside `mergeNative`, which is the divergence
  correction-01 exists to remove. Its re-open condition is "only if the two-step
  is measured to be a real product problem", and this roadmap cited no such
  measurement. Measured since: in the window nothing on disk changes — `adopt`
  writes only the ledger — and in the one destructive case the window IS the
  safety feature, because it is where the user reads that the next `init` will
  REMOVE what the claim covers and can choose `release` instead. `AGENTS.md`
  says to read that ledger before claiming something is missing. I did not.

**And 27.A is bigger and more dangerous than it reads, which two seats agreed
on independently.** Removal does NOT go on the port: `dispose()` is documented
in five places as preserving state, with a PUBLISHED clause
(`dispose-idempotent-preserves-state`) asserting it, so making it the removal
would invert a shipped contract — and removal is already deliberately off the
port, as `removeWorktree(stateDir, id)`, a free function the CLI calls by name.
The local twin belongs in `@panda/workspace-local`, leaving `@panda/contracts`
and its nine clauses untouched.

What makes it dangerous is measured, not feared: the local provider hands out
read+write handles for `trees` and `records` — the git-worktree provider's own
worktrees and its ownership proof — because both share one state directory and
`acquire` consults no record (control: an id with no directory IS refused). A
removal keyed on "a UUID-shaped child of rootDir" would make `panda workspace
remove trees` delete every worktree in the project. Keying it on a record panda
wrote closes that for free, which is AD-6 in its own milestone.

Its honest cost is the backward-compatible half: every workspace that exists
today has no marker, so under that rule panda names them and refuses to remove
them. That is the `outside-panda` exit, it is self-liquidating, and it is the
only sentence AD-6 permits.

### M28 — The kernel's own record survives the process

*The root: observability that dies with the thing it observes.* Measured: zero
`process.on('exit'|beforeExit)` anywhere in the kernel or the CLI (control —
`process.on` returns 2 in `run.ts`, the interrupt handlers, so the query sees).

- **28.A — no exit drain.** Records still in flight when the process ends are
  lost, and only a seq gap survives to say so. **Owner-blocked**, see below.
- **28.B — CLOSED, measured.** "Counters die with the pipeline" and
  "`registeredIds` grows without retirement" are both true and neither can
  fire: `runSession` creates its kernel per invocation and stops it at the end
  (`run-session.ts:547,580`), so the growth is bounded by one command's
  lifetime. Same shape as `2-6`'s `idle` — a branch that cannot fire. It
  becomes real only for a HOST that keeps a kernel across many sessions, which
  nothing does today. Reopen with that host.

This one has a real prerequisite and it is worth naming rather than
discovering: **a durable sink has no destination decision yet**. Retention,
rotation and location are Ask-First in spec 1.6. Do 28.A only after that
decision, or it invents a location a user did not choose — which is
correction-01's own rule pointed inward.

### M29 — Diagnosis as fine-grained as the thing diagnosed

*The root: `panda doctor` reports at a coarser altitude than it acts.* A user
told "this file differs" cannot tell which entry caused it, and the remediation
they are handed is file-shaped while the cause is entry-shaped.

- **29.A — WRONG IN BOTH HALVES, measured.** `ProjectionResult` DOES carry a
  per-entry channel: `DriftEntry` has an `entryId` and a `location`
  (`contracts/src/projection.ts:109-114`). And doctor DOES read it —
  `doctor.ts:716-718` pushes one finding per drift entry carrying both, and
  `:719-721` does the same for `unprojectable`. Asserted by tests that run:
  `doctor.test.ts:248` expects `{ entryId: 'ctx', location: 'mcpServers.ctx' }`
  (control: 26 clauses in that file). What remains is far narrower than this
  entry claimed and may not be worth building: the file-level `out-of-date`
  finding does not say which entries would change — and it is a different fact
  from drift, since a registry change produces it with no drift at all.
- **29.B — still open**, and it is the one a lens actually drove: `panda add
  mcp-server nocmd` registers, prints only where it was stored, and no target
  says why nothing takes it.

The measured caution, if 29.B is built: `FINDING_EXITS` is a `Record` over a
closed union, so a new finding kind cannot ship without an exit. The compiler
is what makes widening the vocabulary safe.

### M30 — The trust surface, decided rather than patched

*The root: panda handles other people's bytes and its own secrets, and three
decisions are open.* M25.A closed the live one — a cloned repository's
`.panda/config.json` no longer executes — and named what it deliberately did
not build.

- **30.A — REJECTED, measured, with a reopen condition.** It read as "the
  principled version of M25.A's fix: honour a project-layer method panda itself
  wrote". Driven, it adds three mechanisms rather than removing a restriction: a
  record, a reader inside the mount guard, and a package edge —
  `packages/session/test/guard.test.ts:51-57` pins session's dependencies to
  five packages and `@panda/projection` is not one of them. And the record would
  prove the wrong thing: it hashes the config STRING, while the danger is the
  module BYTES, which any `git pull` replaces. AD-6's records authorise REMOVAL
  (`contracts/src/projection.ts:70-76`), never EXECUTION. direnv's public regret
  is this exact shape — hashing only the entry file left everything it sourced
  untrusted-but-executed, hence `watch_file` — and here that hole cannot be
  closed at all, because M25.A measured that a module is not inspectable without
  being loaded. So 30.A is 30.C wearing an ownership record's clothes.
- **30.D — SHIPPED (`11b2c20`, green on both legs), and the fix is not the one
  this entry proposed.** The defect was real: a cloned repository carrying a
  `method` key denied service to a method the machine's OWNER selected. But the
  proposal — "`selectMethod` skips the project layer and takes the next" —
  would have made the method selection the product's ONLY layer-by-layer reader,
  because `dump()` exposes just the winning layer and `snapshot()` has zero
  production consumers. It ships at ADMISSION instead: `seedExecutorConfig` drops
  the key before it becomes a layer, so composition alone yields the next one and
  no selection learns a new rule. `assertMethodMayMount` keeps its project clause
  for the supplied-kernel path, driven rather than argued. Renegotiates M25.A row
  E1, corrected in place. Frozen as `spec-m30d`.
- **30.B — FR-21's CI secret scan**, whose acceptance criterion says
  "CI-scanned" and which has never existed. The design is recorded whole
  (M24.A's ledger) with three measurements that demolished its original
  justification: a job-log scan is VACUOUS because the CLI's own tests capture
  every byte panda prints; gitleaks is 4-for-11 against panda's corpus with no
  OpenAI or Anthropic rule; and its independence covers SHAPE, not SITE. Build
  it when a story needs CI to emit an artifact for another reason.
- **30.C — per-directory trust.** The industry answer, and a mechanism. A trust
  store invented at speed under a security finding is how a bad trust store
  ships.

**The ordering sentence here was wrong, and it is the sixth correction on this
page.** It read *"30.A first, because it is the only one that removes a
restriction rather than adding a mechanism"* — written from what shipping had
just taught rather than from driving it. 30.A adds three mechanisms. The real
order was **30.D first**, and it shipped: it was the only item that removed a
restriction, the only one with a user losing a run today, and it needed no new
store. What is left under M30 is 30.B (FR-21's CI secret scan, waiting on a story
that needs CI to emit an artifact) and 30.C (per-directory trust, deliberately
not invented at speed).

### The decision that is not a milestone

**Publishing.** Twelve packages at `private: true`, and `spec-m3a…:30` lists
"publishing to any registry" and "a version-bump or release-automation policy"
as Ask First — in the same sentence. It is the only thing standing between
panda and "a stranger can install this", and it is irreversible: a registry name
cannot be taken back.

Everything else on this page is reversible and can be decided by whoever is
working. This one cannot, and no roadmap should pretend otherwise.

What is already true if the answer is yes: the FR-29 proof packs and installs
every tarball offline outside the repo on every push, `@panda/contracts` ships a
README whose code blocks CI compiles and runs, all twelve manifests carry
`description` and `repository`, and a gate refuses a version that disagrees with
its siblings or a package that quietly loses `private`.

## Why this document has been wrong six times, and what that means for the next one

Corrected so far, all by driving rather than reading: the `atomicWriteText`
trigger fired once and not three times; the `EPERM` escaped falsely coded
rather than uncoded; 27.C was already rejected on evidence with a reopen
condition; 28.B cannot fire; 29.A was wrong in both halves; and 30.A's ordering
rationale was backwards — it adds mechanisms, and the record it would add proves
the pointer rather than the payload.

The cause is not carelessness, and naming it is the point: **this document was
written from ledger summaries and from what shipping had just taught, not from
driving the code it describes.** A summary is a compression of a measurement
someone else made at a different commit, and compressions rot in exactly the
direction that makes work look necessary.

So the instruction is not "be careful". It is: **before starting any milestone
here, drive its subject.** Every correction above cost one command. Two of them
cost a red CI run instead, because the command was not run first.

## How to use this document

Take a root, not an item. Each milestone above is one sentence of diagnosis with
its symptoms attached, and the symptoms are how you know when the root is
closed.

And re-measure before starting. This project has now been wrong about its own
ledger 23 times, about a live-suite glob twice, and about NFR-8's blocker once —
every one of them found by driving something rather than by reading it.
