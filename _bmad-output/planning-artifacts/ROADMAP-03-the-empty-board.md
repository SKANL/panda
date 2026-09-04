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
- **27.B — a remediation's write has no coded boundary.** `remediate.ts:530` is
  a bare `await atomicWriteText(filePath, next)` inside `discard()`, so a raw
  `EPERM` from a read-only target escapes uncoded out of `panda remediate
  discard --apply`. Its sibling at `ledger.ts:389-400` codes exactly this. The
  ledger entry that predicted it named the trigger — "if a second non-engine
  caller ever appears" — and the trigger has fired three times.
- **27.C — there is no `restore`.** "Take panda's version back" is `remediate
  adopt` then `init`: two commands with a window between them.

Ships as one story or three; the root is one sentence, so the review is one
review.

### M28 — The kernel's own record survives the process

*The root: observability that dies with the thing it observes.* Measured: zero
`process.on('exit'|beforeExit)` anywhere in the kernel or the CLI (control —
`process.on` returns 2 in `run.ts`, the interrupt handlers, so the query sees).

- **28.A — no exit drain.** Records still in flight when the process ends are
  lost, and only a seq gap survives to say so.
- **28.B — counters die with the pipeline**, so a budget cannot span two
  processes or survive a restart, and `registeredIds` grows without retirement.

This one has a real prerequisite and it is worth naming rather than
discovering: **a durable sink has no destination decision yet**. Retention,
rotation and location are Ask-First in spec 1.6. Do 28.A only after that
decision, or it invents a location a user did not choose — which is
correction-01's own rule pointed inward.

### M29 — Diagnosis as fine-grained as the thing diagnosed

*The root: `panda doctor` reports at a coarser altitude than it acts.* A user
told "this file differs" cannot tell which entry caused it, and the remediation
they are handed is file-shaped while the cause is entry-shaped.

- **29.A — drift per entry, not per file.** `doctor.ts:707-713` emits one
  file-level message; `ProjectionResult` carries no per-entry channel.
- **29.B — an entry nothing takes is registered in silence.** `panda add` on an
  entry no target accepts exits 0 saying only where it was stored.

The measured caution: `FINDING_EXITS` is a `Record` over a closed union, so a
new finding kind cannot ship without an exit. Widening the vocabulary is cheap
to get wrong and the compiler is what makes it safe.

### M30 — The trust surface, decided rather than patched

*The root: panda handles other people's bytes and its own secrets, and three
decisions are open.* M25.A closed the live one — a cloned repository's
`.panda/config.json` no longer executes — and named what it deliberately did
not build.

- **30.A — ownership on config writes.** It is the principled version of
  M25.A's fix: honour a project-layer method **panda itself wrote** via `project
  swap method`, rather than refusing the layer wholesale. Measured:
  `config-write.ts` records no ownership at all.
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

**Order matters here and nowhere else on this page:** 30.A first, because it is
the only one that removes a restriction rather than adding a mechanism.

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

## How to use this document

Take a root, not an item. Each milestone above is one sentence of diagnosis with
its symptoms attached, and the symptoms are how you know when the root is
closed.

And re-measure before starting. This project has now been wrong about its own
ledger 23 times, about a live-suite glob twice, and about NFR-8's blocker once —
every one of them found by driving something rather than by reading it.
