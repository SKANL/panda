# Spec M6.A — Parallel work is infrastructure, not a bolt-on

**Status:** FROZEN
**Implements:** Story 4.1 (Managed git worktrees with durable ownership), FR-18, AD-6
**Created:** 2026-08-27

---

## Intent

Ship the git-worktree `WorkspaceProvider`. The product brief promised
"concurrent workspaces from day one: agents run on isolated git worktrees via a
workspace contract, so parallel work is native infrastructure, not a bolt-on."
The contract shipped. The provider never did. This closes that gap.

A worktree panda created is **provably** panda's, forever: it carries a durable
on-disk ownership record, its name is never reissued to a different tree, and a
directory without that record is classified external and never auto-modified.

## The measurement this rests on

Every claim below was executed, not remembered, on 2026-08-27 at `d66d59c`.

1. **The provider does not exist.** `grep -ril worktree packages/*/src` → **0
   files**. Control: `grep -rl WorkspaceProvider packages/*/src` → **9 files**.
   A zero without a control means "I did not look" (session ledger), so the
   control was run first.
2. **The seam is already built and contract-tested.** `WORKSPACE_CLAUSES` in
   `packages/contracts/src/contract-suite/workspace-clauses.ts` holds **8**
   clauses: `create-yields-valid-handle`, `acquire-roundtrip`,
   `acquire-unknown-id-rejected`, `release-forged-handle-rejected`,
   `double-release-rejected`, `state-persists-across-sessions`,
   `dispose-idempotent-preserves-state`, `disposed-provider-rejects-operations`.
   `LocalWorkspaceProvider` (140 lines) passes all 8. This story adds a second
   provider against an already-proven port — not new architecture.
3. **The premise Epic 4 stands on is already paid.** Story M4.A ("the workspace
   is a boundary or panda says it is not") is `done` in `sprint-status.yaml`.
4. **Package topology, measured from the manifests**: `workspace-local` depends
   on exactly `@skanl/panda-contracts` + `@skanl/panda-kernel`. `registry` depends on the
   same two. They are siblings; AD-2 permits no edge between them.
5. **No process-spawn helper is reachable.** `node-child-spawner.ts` exists only
   in `@skanl/panda-adapter-cli` — a sibling. Control: it is the sole
   `node:child_process` importer under `packages/*/src`.
6. **The five error codes this provider needs already exist**:
   `PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID`, `…_INVALID_HANDLE`,
   `…_DOUBLE_RELEASE`, `…_UNAVAILABLE`, `PANDA_CONTRACT_PROVIDER_DISPOSED`.

## Boundaries & Constraints

- **AD-1** — the kernel keeps zero runtime dependencies. Untouched here.
- **AD-2** — `workspace-*` imports `@skanl/panda-contracts` (and `@skanl/panda-kernel` for
  the plugin) and **nothing else**. No `@skanl/panda-registry`, no
  `@skanl/panda-projection`, no `@skanl/panda-adapter-cli`.
- **AD-5** — typed absence over silence. A worktree panda cannot classify is
  reported, never guessed at.
- **AD-6** — identity: a name identifies exactly one tree, forever.
- **AD-7** — every refusal is a coded `PandaError`. **No new codes**: the five
  measured above cover every refusal this provider can raise.
- Relative imports carry the `.ts` extension. All artifacts in English.

### D1 — `atomic-write.ts` is NOT moved down, and is NOT imported

`packages/projection/src/atomic-write.ts` (83 lines) resolves symlinks and
copies file modes because it writes into **vendor-owned dotfiles** that users
symlink into a dotfiles repo, and it raises
`PANDA_PROJECTION_NATIVE_UNCLAIMABLE` when it cannot. A record written inside a
directory panda itself created has neither hazard, and importing it would leak
`PANDA_PROJECTION_*` codes out of a workspace API — the exact leak
`deferred-work.md` records Story 2.8 as having removed.

This package writes its own ~10-line temp-then-rename, with a comment naming
the other one and why it is not shared.

### D2 — the Registry mirror does not ship in this story

Story 4.1's acceptance says the on-disk record and the Registry mirror "commit
in one serialized transaction". AD-2 forbids the edge in either direction
(measurement 4). FR-18's own wording settles the split: the on-disk record is
the **creation-of-record**; the Registry entry is a **mirror**, i.e. derived
state, which AD-4 assigns to its owning component — a consumer-tier caller that
holds both. Recorded in `deferred-work.md` with its upgrade path.

### D3 — permanent retirement is one monotonic ordinal

A counter that only ever increases **is** permanent retirement. A separate list
of retired names is a second copy of the same fact.

**Ordering is the invariant, not the counter.** The ordinal is reserved and
durably persisted **before** `git worktree add` runs. A crash between the two
leaks an ordinal — harmless, since the entire point is that ordinals are never
reused — whereas persisting after creation would reissue one. This is the same
discipline as the discard-race fix at `71db335`: force the ordering, never bet
on it.

## I/O & Edge-Case Matrix

| # | Input / state | Expected behaviour |
|---|---|---|
| 1 | `create()` on a healthy repo | new worktree at `<root>/trees/w-<n>`, record written, handle valid against `WORKSPACE_HANDLE_SCHEMA` |
| 2 | `create()` twice | two distinct ids, two distinct paths, ordinals strictly increasing |
| 3 | `create()`, `remove`, `create()` | the removed ordinal is **never** reissued |
| 4 | ordinal persisted, process dies before `git worktree add` | next `create()` uses a HIGHER ordinal; the leaked one is never issued |
| 5 | `acquire(id)` for a record panda holds | handle with the same `rootPath` as `create()` returned |
| 6 | `acquire(id)` where the directory exists but **no record** | `PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID`; the directory is **not** touched |
| 7 | `acquire(id)` for an id never issued | `PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID` |
| 8 | `acquire(id)` with a traversal / absolute / reserved-device id | `PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID`, no filesystem read outside the root |
| 9 | `release(handle)` twice, same handle | second raises `PANDA_CONTRACT_WORKSPACE_DOUBLE_RELEASE` |
| 10 | `release(forged)` | `PANDA_CONTRACT_WORKSPACE_INVALID_HANDLE` |
| 11 | any operation after `dispose()` | `PANDA_CONTRACT_PROVIDER_DISPOSED` |
| 12 | `dispose()` twice | idempotent; every worktree and record left on disk |
| 13 | state written into a worktree, released, re-acquired | the bytes are still there |
| 14 | `git` missing / not a repo / `git worktree add` fails | `PANDA_CONTRACT_WORKSPACE_UNAVAILABLE` naming the git stderr |
| 15 | ledger file unreadable or malformed | `PANDA_CONTRACT_WORKSPACE_UNAVAILABLE`; **never** silently restart at ordinal 0 |
| 16 | two concurrent `create()` calls on one provider | two distinct ordinals; no interleaved read-modify-write |

Row 15 is the one that would be silent: restarting the counter after a bad read
reissues every name the repo ever used. It refuses instead.

## Code Map

```
packages/workspace-git-worktree/
  package.json            deps: @skanl/panda-contracts, @skanl/panda-kernel  (AD-2)
  tsconfig.json  tsconfig.build.json  vitest.config.ts   copied from workspace-local
  src/
    index.ts                      public surface
    git.ts                        execFile('git', ...) runner -> coded failures
    ledger.ts                     nextOrdinal reservation + records, atomic + queued
    git-worktree-provider.ts      GitWorktreeWorkspaceProvider implements WorkspaceProvider
    plugin.ts                     kernel plugin, mirroring workspace-local/src/plugin.ts
  test/
    contract.test.ts              the 8 WORKSPACE_CLAUSES, aggregate + per clause
    provider.test.ts              the matrix rows above
```

## Tasks & Acceptance

- [x] T1 — package scaffold mirroring `workspace-local` (manifests, tsconfigs, vitest config)
- [x] T2 — `git.ts`: run git, map every non-zero exit to `PANDA_CONTRACT_WORKSPACE_UNAVAILABLE` carrying stderr
- [x] T3 — `ledger.ts`: atomic temp-then-rename; `reserveOrdinal()` serialized through one promise queue; record read/write; malformed → coded refusal (row 15)
- [x] T4 — `git-worktree-provider.ts`: the port, reserve-then-create ordering (D3), lease model identical to `workspace-local`
- [x] T5 — `contract.test.ts`: all 8 clauses green, aggregate and individually
- [x] T6 — `provider.test.ts`: every matrix row, with rows 3, 4, 6, 15 and 16 as the load-bearing ones
- [x] ~~T7 — `plugin.ts` + its test~~ — **DROPPED during implementation.** `workspace-local`'s plugin provides the service `workspace`; a second one is `PANDA_KERNEL_SERVICE_CONFLICT`, so the two providers are alternatives and shipping a plugin means deciding how a user selects between them — which is Story 4.2's question, not this one's. Nothing mounts this provider today. Recorded in `deferred-work.md`.
- [x] T8 — `deferred-work.md` entries for D2, the cross-process lock, and anything else deliberately left
- [x] T9 — gate green on Node 24 **and** Node 26; `sprint-status.yaml` updated

**Done means:** `pnpm check` green on both Node versions, the 8 contract clauses
pass for the new provider, and rows 3/4/6/15/16 each have a test that fails when
its guard is removed.

## Ask First

Stop and ask rather than deciding:

- Any need for a **new** `PANDA_*` error code (measurement 6 says none is needed;
  if that turns out wrong, the code is a published-surface decision).
- Any import in this package beyond `@skanl/panda-contracts` + `@skanl/panda-kernel` (AD-2).
- Any change to `WORKSPACE_CLAUSES` or `packages/contracts/src/workspace.ts` —
  the port is published and shared with `workspace-local`.
- Any move of `atomic-write.ts` (D1 says no).
- Implementing the Registry mirror (D2 says not here).

## Spec Change Log

- 2026-08-27 — frozen at `d66d59c`.
- 2026-08-27 — **T7 dropped.** See the task list. The frozen clause said "mirroring
  `workspace-local/src/plugin.ts`"; mirroring it exactly would register a second
  provider of the service `workspace`, which the kernel rejects. Filed rather
  than implemented past, per the repo's renegotiation rule.

## Verification

Everything below was executed on 2026-08-27, not inferred.

### The gate

- `pnpm check` — **exit 0**, all ten packages. `@skanl/panda-workspace-git-worktree`
  13 passed (2 files); nothing else moved.
- Node 26.8.1 canary — the new package, **13 passed**.
- `eslint packages/workspace-git-worktree` — clean. `tsc --noEmit` — clean.

### The contract suite

All **8** `WORKSPACE_CLAUSES` pass for `GitWorktreeWorkspaceProvider`, both in
the aggregate run and clause-by-clause against a fresh provider each.

### Falsification — five mutations, five killed

Each guard was removed and the suite re-run. A test that does not fail when its
guard is gone is not testing anything.

| # | Mutation | Killed by |
|---|---|---|
| 1 | malformed ledger shape returns `nextOrdinal: 0` instead of raising | `refuses a ledger whose counter is not a usable ordinal` |
| 2 | `reserveOrdinal` stops persisting the advance | **6 tests**, incl. both retirement tests and the contract suite |
| 3 | `acquire` trusts the directory instead of the record | `refuses a directory in the trees folder that carries no record` |
| 4 | ledger queue made per-instance instead of per-directory | `gives concurrent creates on separate instances distinct names` |
| 5 | unparseable JSON treated as an empty ledger | `refuses a malformed ledger instead of restarting the counter` |

Mutation 1 was **survived** by the "not json at all" test, which is why mutation
5 exists: the two malformed-ledger tests hit different branches (`JSON.parse`
throwing versus the shape check), so neither is redundant. This is the
representativeness rule from the session ledger applied on purpose — one plant
landing in one accepted shape proves only that shape.

### Environment findings, both real and both fixed

- **`EBUSY: rmdir` on Windows.** A worktree git has just written can still hold
  an open handle at teardown; the bare `rm` failed the whole file. Fixed with
  `maxRetries`/`retryDelay`, the stdlib option that exists for this. Surfaced
  ONLY under `pnpm check`, where packages run concurrently — never when the
  package ran alone.
- **The 5s default timeout.** Every test here drives the real `git` binary; the
  clause-by-clause run spawns a couple of dozen processes. Moved to the package's
  `vitest.config.ts` with the measurement, rather than sprinkled per test.

### What is NOT verified here

The Registry mirror (AD-2 — see `deferred-work.md`), the kernel plugin (T7,
same), and cross-process ordinal reservation. Stories 4.2 and 4.3 own the rest
of Epic 4.
