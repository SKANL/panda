# Spec M27.A — a workspace panda made is a workspace panda can take back

- **Story**: none open. `ROADMAP-03`'s M27, second half; 27.B shipped as `b0a1b1b`.
- **State**: frozen.

## Intent

`panda run` creates a directory per session and nothing removes it.
`panda workspace remove` exists, and its own help says it *"takes back a
**worktree** panda made"* — it is scoped to the git-worktree provider, while the
DEFAULT provider is `local`. So the default path accumulates directories with no
verb, and panda's stated identity is *"ownership tracked so panda can undo
exactly what it wrote and nothing else."*

`packages/session/src/run-session.ts:465-468` already says so in panda's own
source: *"the mounted provider creates a directory per session under
`<cwd>/.panda/workspaces/<uuid>` and NOTHING removes it."*

## The measurement this rests on

Executed 2026-09-04 at `b0a1b1b`. Two independent design passes reached the same
conclusion on the first point; the rest is driven.

1. **The local provider records nothing.** Its only memory is
   `#leases = new WeakMap<WorkspaceHandle, Lease>()`
   (`packages/workspace-local/src/local-workspace-provider.ts:41`) — in-process,
   keyed by the handle OBJECT. It `mkdir`s (`:58`) and forgets. So *"panda made
   this"* is **unknowable** for a local workspace after the process exits.
   Control: the git-worktree provider writes a durable `WorktreeRecord`
   (`packages/workspace-git-worktree/src/ledger.ts:8-17`) and returns 24 hits for
   `ledger` in its provider.

2. **The directories are INVISIBLE, not merely unremovable.** Driven in a
   throwaway project with two UUID directories:
   `{"outcomes":[],"claimed":[],"unclaimed":[]}` and *"nothing to remove: panda
   holds no worktrees"*, exit 0. `inspectWorktrees` lists only
   `join(stateDir, TREES_DIR)` while the local provider writes one level up. So
   they are not even reported as `unclaimed`.

3. **THE HAZARD, and it is why the design is what it is.** Both providers are
   seeded with the same `rootDir` (`run-session.ts:364`), and `acquire` consults
   no record — it tests the id pattern and `lstat`s (`local-workspace-provider.ts:65-87`).
   Driven, with a control:

   ```
   acquire('trees')      -> caps=read+write  path=<root>/trees
   acquire('records')    -> caps=read+write  path=<root>/records
   CONTROL no-such-dir   -> REFUSED PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID
   ```

   Those are the git-worktree provider's own worktrees and its ownership proof.
   Today the consequence is bounded because `runSession` only ever calls
   `create()`. **A removal keyed on a PATH would make `panda workspace remove
   trees` delete every worktree in the project.**

4. **Removal is already deliberately OFF the port.** `removeWorktree(stateDir, id)`
   (`git-worktree-provider.ts:370`) and `inspectWorktrees(stateDir)` (`:323`) are
   free functions the CLI calls by name (`packages/cli/src/run.ts:22-28`).
   `dispose()`'s own doc states the split: *"Tree removal SHIPPED, and it is
   deliberately not here … Disposal is the end of one run; a removal is a
   decision"* (`:174-184`).

5. **`dispose()` is not the removal under another name.** Five places say the
   opposite, one of them a PUBLISHED clause: `dispose-idempotent-preserves-state`
   (`packages/contracts/src/contract-suite/workspace-clauses.ts:161-179`) writes
   a payload, disposes twice, and asserts the state survives. Making `dispose()`
   the removal would require inverting a shipped clause.

## Boundaries & Constraints

### D1 — the port does not change

No edit to `packages/contracts/src/workspace.ts`, and `WORKSPACE_CLAUSES` stays
at nine. A `remove()` on the port would either be so under-specified that its
clause could only assert "it resolved" — degrading the published suite's promise
exactly as much as `ToolProvider` having no suite does — or it would force every
third-party implementer to build a destructive method to pass conformance.

### D2 — ownership is a RECORD panda wrote, never the shape of a path

`removeLocalWorkspace` deletes a directory **if and only if** that directory
holds a parseable record panda wrote. A directory without one is reported and
never touched — the same REPORTED, NEVER REMOVED clause as
`git-worktree-provider.ts:297-303`, whose own words are *"what makes a worktree
panda's is the record and never the path."*

This is not bookkeeping. It is the entire safety mechanism, and measurement 3 is
why: `trees` is not UUID-shaped, but `workspace.rootDir` is a user-writable
config key (`packages/workspace-local/src/plugin.ts:41`), so any path-shaped rule
reopens the class.

### D3 — the record lives INSIDE the workspace directory

`<uuid>/.panda-workspace.json`, not a sibling `records/`. Three reasons, and the
git ledger's own refusal of the in-tree marker does not apply here:

- `ledger.ts:66-78` refuses it because it *"makes every panda worktree
  permanently dirty: the file shows up as untracked in `git status`"*. A local
  workspace is not a checkout and has no `git status`.
- **No crash window at all.** `rm -rf <dir>` removes the directory and its proof
  in one operation, so there is no intent file, no `INTENT_MAX_AGE_MS`, no pid
  liveness check and no `interrupted` category — and therefore no change to
  `panda doctor`'s wiring.
- **No collision.** A sibling `records/<uuid>.json` would land in the directory
  `WorktreeLedger.listIds()` reads; `readRecord` would fail `isRecordShape` and
  THROW `#unusable`, breaking `panda workspace remove` for git worktrees.

### D4 — the CLI asks BOTH stores, never the selected provider

A project that switched `workspace.provider` has leftovers of both kinds, and a
verb that asked only the current selection would strand the other forever. The
ids are disjoint by construction (`w-<n>` versus a v4 UUID), so `panda workspace
remove <id>` routes unambiguously: whichever store holds a record wins, neither
means `unknown`.

### D5 — pre-existing workspaces are named and NOT removed

Every `.panda/workspaces/<uuid>` on disk today has no record. Under D2 they are
`unclaimed` forever. **There is no honest way out** — inferring ownership from
the UUID shape is exactly the AD-6 violation this story exists to avoid. Panda
names the paths and says they predate its ownership records, in the vocabulary
`doctor.ts:295-298` already has for `outside-panda`. It is self-liquidating:
every workspace made after this change carries a record.

### D6 — not in this story

- **Any retention policy** — age pruning, a `workspace.retain` key.
  `deferred-work.md:100-101` defers automatic retention deliberately (*"work
  inside a workspace is meant to survive"*) and names a user-invoked verb as the
  direction. A verb is not a policy.
- **The port**, per D1.
- **Fixing `acquire`'s cross-provider reach.** D2 removes its consequence for
  this verb. Narrowing `acquire` itself is a separate change with its own blast
  radius, and it is recorded.

## I/O & Edge-Case Matrix

| # | Input | Expected |
|---|---|---|
| E1 | `panda run` twice, then `workspace remove` | both directories listed as claimed; both removable |
| E2 | `workspace remove <uuid>` for a workspace panda made | removed; directory and record gone together |
| E3 | a UUID-named directory panda did NOT make | reported unclaimed; **not** removed; exit as `outside-panda` |
| E4 | `workspace remove trees` in a project that also uses git-worktrees | REFUSED — no record; every worktree survives |
| E5 | `workspace remove records` | same as E4 |
| E6 | `workspace remove <w-n>` (a git worktree id) | routes to the existing worktree removal, unchanged |
| E7 | `workspace remove` with no id, both kinds present | sweeps both stores; reports each |
| E8 | a directory whose record is corrupt | reported, not removed; the refusal names the path |
| E9 | `panda run` after this change | the record is written; a crash mid-run leaves a directory with a record, which E2 removes |

## Code Map

Read each package's guard test before putting code in it.

| Path | Change |
|---|---|
| `packages/workspace-local/src/local-workspace-provider.ts` | write `<rootPath>/.panda-workspace.json` in `create()`, after `mkdir` |
| `packages/workspace-local/src/removal.ts` | NEW — `inspectLocalWorkspaces(rootDir)` and `removeLocalWorkspace(rootDir, id)`, result shapes structurally matching the worktree pair so the CLI's formatter takes them unchanged |
| `packages/workspace-local/src/index.ts` | export both |
| `packages/cli/src/run.ts` | `runWorkspace` asks both stores; the help line says **workspace**, not worktree |
| `packages/workspace-local/test/removal.test.ts` | NEW — E1–E9, with E4/E5 as the hazard clauses |

## Tasks & Acceptance

1. **T1** — RED first, and E4 is the clause to write first: a `trees/` directory
   beside a local workspace must survive `workspace remove trees`. See it red
   against a path-keyed implementation if you write one; otherwise write it
   against the absent function and see it fail to import.
2. **T2** — the record in `create()`, then `removal.ts`.
3. **T3** — the CLI, both stores, and the help line.
4. **T4** — falsify each: delete the record check and E4/E5 must redden; key on
   the path and they must redden; drop the both-stores routing and E6 must redden.
5. **T5** — drive the binary end to end: two `panda run`s, `workspace remove`,
   and a planted foreign UUID directory that must survive.
6. **T6** — `deferred-work.md`: D5's pre-existing workspaces and D6's `acquire`
   narrowing.
7. **T7** — gate on Node 24 AND 26, plus `pnpm build && pnpm proof:consumer-install`.

## Ask First

- Any edit to `packages/contracts/src/workspace.ts` or `WORKSPACE_CLAUSES`.
- Any retention or age-based pruning.
- Removing a directory that has no record, for any reason.
- Changing `acquire`'s id acceptance.

## Verification

**T1 — red first, E4 first.** `packages/workspace-local/test/removal.test.ts` was written
against the absent function and run: `TypeError: removeLocalWorkspace is not a function`
×2 and `inspectLocalWorkspaces is not a function` ×1, 3 failed / 3.

**T4 — falsification.** Seven mutations, each applied to real source, the named suite run
for real, the file restored (`.scratch/falsify-m27a.mjs`). Every one reddens:

| # | Mutation | Reddened |
|---|---|---|
| A | delete the record check in `removeLocalWorkspace` (removal becomes path-keyed) | E4 `trees`, E5 `records`, E3; CLI E3, CLI E4/E5 |
| B | key removal on the UUID SHAPE of the id instead of the record | E3; CLI E3 |
| C | delete the record check in `inspectLocalWorkspaces` (report becomes path-keyed) | E4/E5 report clause, E3, E7; CLI E3 |
| D | stop writing the record in `create()` | 10 of 12 local clauses; 4 of 5 CLI clauses |
| E | drop the both-stores routing — ask only the LOCAL store | E6 at the binary (`removes the tree, retires the record…`) and the SIGKILL sweep |
| F | drop it the other way — ask only the WORKTREE store | CLI E1/E2, E3, E4/E5 |
| G | do not ask the worktree store for its own footprint | CLI E7 and the shipped `nothing to remove` clause |

**T5 — the binary, end to end** (`.scratch/t5-drive.mjs`, throwaway `HOME`/`USERPROFILE`).
Two `panda run`s each wrote `<uuid>/.panda-workspace.json`; the sweep reported both
`claimed` and removed neither; each named id removed the directory and its record together
(exit 0); a planted foreign UUID directory was reported `unclaimed` with D5's sentence,
refused `PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID` at exit 1 when named, and still held its
file at the end; `panda workspace remove trees` was refused the same way.

**T7 — gate.** Node 24.14.1 and Node 26.8.1: 12/12 packages green (1 405 tests) with
`**/*live*.test.ts` excluded. Bytes, `pnpm typecheck` and `pnpm lint` green.
`pnpm build` green; `pnpm proof:consumer-install` 10 passed / 1 skipped.
`adapter-cli/test/usage-live.test.ts` fails under a bare `pnpm check` — a real-vendor live
suite on the `LIVE_SUITES` roster, untouched by this change.

**Deviations from the Code Map, both driven rather than chosen.**

1. `packages/session/src/index.ts` re-exports the pair (and
   `packages/session/test/kernel-composition.test.ts`'s exact export roster widens by two).
   `@panda/cli` depends only on `@panda/environment` and `@panda/session`, so this is how
   the CLI reaches the capability — the same route `inspectWorktrees`/`removeWorktree`
   already take.
2. `WorktreeInspection.storeDirectories` (+ `InspectLocalWorkspacesOptions.ignore`).
   Both providers are seeded with ONE root, so the local store's listing of it sees the
   worktree store's `trees` and `records`. Without this the sweep told users panda holds no
   ownership record for panda's own worktree store, and the shipped
   `nothing to remove` clause went red — measured, not predicted. Each store declares its
   own footprint and the CLI forwards it; it narrows the REPORT only, and mutation G proves
   it is pinned.
