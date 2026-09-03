# M10.A — a session can run in a worktree

**Implements:** Story 4.2 (Epic 4) · FR-19 · NFR-7
**Status:** frozen 2026-09-02 · base commit `2daa657`

## Intent

`packages/workspace-git-worktree/` is a finished, contract-conformant package
the product cannot reach. M10.A mounts it: `panda run` and an SDK caller can
select it, two sessions run concurrently in distinct worktrees, and the
selection is decided by the same layered mechanism the executor selection
already uses.

This story ships a MOUNT, not a feature. Every rung is reuse.

## The measurement it rests on

Every claim below was executed on 2026-09-02 at `2daa657`, with a control
wherever a zero is involved.

1. **The package is unreachable.** `@panda/workspace-git-worktree` occurs
   exactly ONCE in `packages/` — the `name` field of its own manifest. Control:
   `@panda/workspace-local` occurs in nine files, including
   `packages/session/src/run-session.ts:22`. `run-session.ts:381` hardcodes
   `const workspace = createWorkspacePlugin()`.
2. **The package ships no plugin.** `packages/workspace-git-worktree/src/index.ts`
   exports `GitWorktreeWorkspaceProvider` and `WorktreeLedger` and no
   `manifest`/`factory`. Contrast `packages/workspace-local/src/plugin.ts:122-128`.
   Two plugins providing the service `workspace` would be
   `PANDA_KERNEL_SERVICE_CONFLICT` (`packages/kernel/src/loader.ts:58`), so the
   mount must CHOOSE.
3. **The selection idiom already exists.** `selectExecutor`
   (`packages/session/src/executors.ts:394-412`) reads `config.dump()`, finds the
   entry at its key path, and takes **value and layer from one dump entry** —
   "so the two cannot disagree" (`:396`). `run-session.ts:371` calls it and
   reports through `onSelection`, whose throw is contained.
4. **`workspace` is ALREADY a layered subtree.** `run-session.ts:352-357` seeds
   `{ workspace: { rootDir } }` as a LAYER, with the reason written above it: so
   "a `workspace.rootDir` in the project document decides in exactly the case a
   layered configuration says it should." The selection therefore belongs at
   `workspace.provider` — path length 2 — not at a second root key that would
   split one plugin's configuration across two places.
5. **The selection cannot be persisted by a verb, and must not try.**
   `WRITABLE_CONFIG_KEYS` is `['executor', 'method']`
   (`packages/projection/src/config-write.ts:42`) and the writer emits FLAT
   top-level keys: `{ ...existing, [key]: value }` (`:154`). Persisting a nested
   key means changing the repository's only symlink-resolving writer. Precedent
   that a hand-authored nested key is acceptable: `workspace.rootDir` ships
   today, is read, and is not writable.
6. **The AC's second clause is already shipped.** `PANDA_REGISTRY_CONTENTION`
   (`packages/contracts/src/errors.ts:49`) is raised from
   `packages/registry/src/lock.ts:131-144` in both shapes, proved cross-process
   at `packages/registry/test/contention.test.ts:49-82` (the loser wrote nothing
   — `ENOENT` on the store) and at the binary at
   `packages/cli/test/registry-commands.test.ts:147-165`.
7. **The AC's "Registry writes remain consistent" is VACUOUS on the run path.**
   `RegistryStore` occurs in zero files under `packages/cli/src`. Control: it
   occurs in eight files under `packages/*/src`. `panda run` never opens the
   Registry. This story records that rather than writing a test that pretends to
   prove it.
8. **Cross-process concurrency on ONE state directory is a known, coded
   failure.** `LEDGER_QUEUES` (`packages/workspace-git-worktree/src/ledger.ts:55`)
   is module-level and in-process. Two processes over one `stateDir` read the
   same `nextOrdinal`, compute the same path, and the second `git worktree add`
   fails with `PANDA_CONTRACT_WORKSPACE_UNAVAILABLE` (`deferred-work.md:427-428`).
   That IS a panda-state contention error, so clause 1 of the AC is proved
   **in one process**; the cross-process lock is a named boundary, not a gap this
   story closes.
9. **The two providers diverge, and the divergence is an AD-7 violation.**
   `git-worktree-provider.ts:126` guards `typeof id !== 'string'`;
   `local-workspace-provider.ts:67` does not, so `join(this.#rootDir, id)` at
   `:68` throws an **uncoded** `TypeError [ERR_INVALID_ARG_TYPE]` out of a port
   whose entire contract is coded refusals. Measured: this repo's
   `WORKSPACE_ID_PATTERN.test(null)` returns `true`.
10. **The SDK seam exists but is refused on the concurrency composition.**
    `SessionOptions.createProvider` (`run-session.ts:126`) works for a
    session-owned kernel and is listed in `KERNEL_OWNED_OPTIONS` (`:207-216`),
    so it is REFUSED beside a supplied `kernel` (`:487-497`) — and a shared
    kernel is how several sessions share one budget. `SessionKernelOptions`
    (`:264-300`) has nine fields and no provider field. The selection must
    therefore be read where the plugin is registered, inside
    `createSessionKernel`, which fixes both paths at once.

## Boundaries & Constraints

**In scope**

- A plugin in `@panda/workspace-git-worktree`, mirroring `workspace-local/src/plugin.ts`.
- `selectWorkspaceProvider(config)` in `@panda/session`, mirroring `selectExecutor`.
- The mount decision at `run-session.ts:381`, inside `createSessionKernel`.
- The `@panda/session` dependency edge on `@panda/workspace-git-worktree`.
- One new shared contract clause closing the `acquire()` id divergence.
- A README for `packages/workspace-git-worktree/` — the only workspace package without one.
- Two ledger entries (see Tasks T7).

**Out of scope, each with the measurement that puts it there**

- **The Registry mirror, and a `worktree` entry type.** AD-6
  (`ARCHITECTURE-SPINE.md:89`, `[ADOPTED + tightened H2]`) requires the mirror
  "within the same serialized transaction as record creation"; AD-2 forbids
  `@panda/workspace-*` importing `@panda/registry`. Three blockers, not one:
  (a) `RegistryEntryType` is `'skill' | 'mcp-server'` and its comment is a rule —
  "every word here reaches an executor … Both, and only both"
  (`contracts/src/registry.ts:7-9`); a `worktree` word reaches no executor and
  renders through no target, which is precisely why M4.E retired `tool`.
  (b) There is no cross-package serializer: the Registry's is `acquireLock` over
  `<store>.lock` (`registry/src/store.ts:362`), the ledger's is `LEDGER_QUEUES`;
  two locks are not one transaction, and the shared leaf lock package is
  recorded unbuilt twice (`deferred-work.md:143`, `:428`).
  (c) **There is no transaction to join today.** `#queued` wraps only
  `reserveOrdinal` (`ledger.ts:76-83`); `writeRecord` (`:85-87`) calls
  `#writeJson` directly, outside the queue. AD-6's clause is currently
  unsatisfiable by either party.
  The ledger's precondition ("do NOT add the port before a consumer exists") is
  **necessary, not sufficient**: 4.2 supplies the consumer and the sink is still
  missing.
- **`panda swap workspace` and any nested config writer** — blocked on
  measurement 5.
- **A `--workspace` CLI flag** — the AC does not ask for it, and the project
  document is the right layer for a per-project worktree choice. `--executor`
  exists because M5.C measured a hand-edit hole in FR-7/FR-9; no equivalent hole
  is measured here.
- **A new `SessionOptions` field.** `createProvider` already is the library seam,
  and `packages/session/src/index.ts:67-78` records five re-exports withdrawn on
  review for adding a second door to one room.
- **The cross-process ordinal lock** — measurement 8.
- **Branch lifecycle, tree removal, the recovery sweep** — Story 4.3. `dispose()`
  removes nothing deliberately (`git-worktree-provider.ts:167-177`) and
  `--detach` names 4.3 (`:100-103`).

**Non-negotiable**

- AD-1, AD-2, AD-5, AD-7, correction-01 C5. Read
  `packages/session/test/guard.test.ts` before touching that package's manifest.
- Relative imports carry `.ts`. All artifacts in English.
- The selection must NOT read the filesystem. `executors.ts` states the rule: "A
  session primitive whose behaviour depends on files under the running user's
  home is not usable from a host that already knows what it wants." The caller
  seeds layers; the selection reads the composed view.

## I/O & Edge-Case Matrix

| # | Input | Expected | Why this row exists |
|---|---|---|---|
| 1 | no `workspace.provider` anywhere | `local` selected, layer `defaults` | the default must not change for any existing user |
| 2 | `workspace.provider: "git-worktree"` in the project document, inside a git repo | a real `git worktree list --porcelain` entry for the session's path | the reachability claim; nothing else proves it |
| 3 | `workspace.provider: "git-worktree"` in a directory that is NOT a git repository | coded failure at plugin activation naming the real cause, never a `TypeError` | `git.ts` maps git failures; the message must not blame the config |
| 4 | `workspace.provider: "nonsense"` | coded refusal naming the closed catalogue | mirrors `unknownExecutor` |
| 5 | `workspace.provider: 42` | coded refusal, not a coercion | `selectExecutor` type-checks its dump entry; this must too |
| 6 | two concurrent `runSession` calls, one process, one `stateDir` | two distinct ids, two distinct `git worktree list` entries, no contention error | AC clause 1, in the only shape the in-process queue makes deterministic |
| 7 | `provider.acquire(null)` on the LOCAL provider | coded `PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID` | today an uncoded `TypeError`; measurement 9 |
| 8 | `createProvider` supplied on a session-owned kernel | unchanged — the injected provider wins | the existing SDK seam must not regress |
| 9 | `createProvider` supplied beside a `kernel` | unchanged refusal | `KERNEL_OWNED_OPTIONS` is deliberate; this story does not relax it |
| 10 | an unknown key under `workspace.` | the existing warning, unchanged | both plugins must know `provider` or they warn about panda's own vocabulary |

## Code Map

| Path | Change |
|---|---|
| `packages/workspace-git-worktree/src/plugin.ts` | NEW — mirrors `workspace-local/src/plugin.ts`: manifest, factory, `configSchema`, `KNOWN_CONFIG_KEYS` |
| `packages/workspace-git-worktree/src/index.ts` | export the plugin |
| `packages/workspace-git-worktree/README.md` | NEW — the shape of `workspace-local/README.md` |
| `packages/workspace-local/src/plugin.ts` | add `provider` to `KNOWN_CONFIG_KEYS` |
| `packages/workspace-local/src/local-workspace-provider.ts` | add the `typeof id !== 'string'` guard at the existing refusal |
| `packages/contracts/src/contract-suite/workspace-clauses.ts` | NEW clause: a non-string id is refused coded |
| `packages/session/src/workspaces.ts` | NEW — `selectWorkspaceProvider(config)`, exported |
| `packages/session/src/run-session.ts` | register the SELECTED plugin at `:381` |
| `packages/session/src/index.ts` | export `selectWorkspaceProvider` |
| `packages/session/package.json` | declare `@panda/workspace-git-worktree` |
| `packages/session/test/guard.test.ts` | add the name to the exact-equality array |
| `packages/session/test/consumer-install.proof.ts` | add to `SESSION_DEPENDENCIES` |
| `_bmad-output/implementation-artifacts/deferred-work.md` | two entries (T7) |

## Tasks & Acceptance

- **T1** — the plugin. Same service, own `configSchema`. Activation in a
  non-git directory fails coded (row 3).
- **T2** — `selectWorkspaceProvider(config)`: one `dump()` entry at path
  `['workspace','provider']`, value AND layer together, closed catalogue,
  coded refusal for rows 4 and 5. Default `local` at layer `defaults` (row 1).
- **T3** — mount the selected plugin at `run-session.ts:381`. `createProvider`
  behaviour unchanged (rows 8, 9).
- **T4** — the dependency edge, the guard array, `SESSION_DEPENDENCIES`.
  **Both guard clauses must be red before the import exists and green after.**
- **T5** — the shared clause + the local guard (rows 7). The clause goes red for
  `@panda/workspace-local` FIRST; record that it did.
- **T6** — the two tests: the binary drive (row 2) and the one-process
  concurrency test (row 6). Force the ordering; never bet on it. The idiom is
  `contention.test.ts:36-43` — a ready file polled against a deadline, never a
  sleep.
- **T7** — two ledger entries: the AD-6/AD-2 adopted-vs-adopted conflict with its
  three blockers and an amendment owner; and "Registry writes remain consistent"
  being vacuous on the run path (measurement 7).
- **T8** — the README.

**Acceptance — the anti-theatre criterion.** This story is done when:

1. `packages/session/test/guard.test.ts` passes with
   `@panda/workspace-git-worktree` in its exact-equality array — which it cannot
   until `packages/session/src/*.ts` genuinely imports the package, because the
   second clause asserts both directions.
2. A test drives the binary in a temporary git repository whose config selects
   `git-worktree`, and asserts the session's workspace path appears in
   `git worktree list --porcelain` for that repository. A UUID directory under
   `.panda/workspaces` is not a worktree entry, so a regression to local fails it.
3. Row 6 passes with the ordering forced, not raced.
4. `pnpm proof:consumer-install` green with five direct dependencies.

None of the four can be met by a finished-but-unreached implementation. That is
the point: this is the second such package this project has shipped.

## Ask First

Stop and file a renegotiation rather than implementing past any of these:

- Any need to add a Registry entry type, a mirror port, or an import from
  `@panda/workspace-*` to `@panda/registry`.
- Any need to change `WRITABLE_CONFIG_KEYS` or `setConfigValue`.
- Any need to add a field to `SessionOptions` or `SessionKernelOptions`.
- Any need to relax `KERNEL_OWNED_OPTIONS`.
- The concurrency test (row 6) failing in ONE process — that would contradict
  measurement 8 and means the shape is wrong, not the test.

## Spec Change Log

1. **`Object.assign` → `deepMerge` for the invocation layer** (`run-session.ts`),
   found by the implementer inside the spec's scope. The assign is SHALLOW, so
   naming a `cwd` replaced the caller's whole `workspace` subtree with
   `{ rootDir }`. Invisible while the subtree had one key; a silently dropped
   `workspace.provider` the moment it had two — a host naming both a `cwd` and a
   provider in the narrowest layer would have run in a workspace it did not ask
   for. `rootDir` still wins, because a named `cwd` is that invocation's answer.
2. **Rows 4 and 5 use `PANDA_CONFIGURATION_UNUSABLE`, not a new code.** There is
   no workspace twin of `PANDA_EXECUTOR_NOT_FOUND`, and
   `packages/contracts/src/errors.ts` is not in the Code Map. The existing code's
   own note covers this case; the message carries the closed catalogue, which is
   what "mirrors `unknownExecutor`" buys the user.
3. **Two guards outside the Code Map were widened by exactly one entry each**,
   both with the reason written in place: `kernel-composition.test.ts`'s
   export-surface pin (`selectWorkspaceProvider` added;
   `createSelectedWorkspacePlugin` deliberately NOT, being precisely the kind of
   factory the five withdrawn re-exports were withdrawn for) and
   `printed-commands.test.ts`'s `NOT_A_COMMAND` (the twin of the existing
   executor entry).
4. **`consumer-install.proof.ts` spells the dependency set TWICE.** The Code Map
   named `SESSION_DEPENDENCIES` and not the packed-manifest assertion at `:565`,
   which went red first. Recorded because a Code Map that names one of two homes
   is the same defect class this spec exists to close.
5. **Row 3's label was wrong, its Expected was right.** The refusal does not
   arrive "at plugin activation": `PluginFactory` is synchronous
   (`packages/kernel/src/lifecycle.ts:81`) and asking git is not, so it arrives
   from `git.ts` on the first `create()`. Coded, naming the real cause, not
   blaming the config — all three hold. No synchronous `.git` probe was added: it
   would reimplement repository discovery and blame the configuration for an
   environment fact.

## Verification

Executed by the coordinator on 2026-09-03 at base `2daa657`, independently of
the implementer's own run. Every row below was driven, not read.

**The binary, through `.scratch/verify-m10a.mjs`** — written as a script rather
than a shell line because quoting has eaten two measurements in this repo.

| row | result |
|---|---|
| 1 — no config | `local`, UUID directory, **1** worktree entry (the repo itself) |
| 2 — `provider: git-worktree` in a git repo | **2** entries; `…/.panda/workspaces/trees/w-0` present and `detached` in `git worktree list --porcelain`; the run completed end to end, `"status": "ok"`, exit 0 |
| 3 — same config, not a repository | `PANDA_CONTRACT_WORKSPACE_UNAVAILABLE`, exit 2, message names `fatal: not a git repository`, does not mention `config.json` |
| 4 — `provider: "nonsense"` | `PANDA_CONFIGURATION_UNUSABLE`, exit 2, message carries `local, git-worktree` |
| 5 — `provider: 42` | exit 2, `must be a string naming one of…`, no coercion to `'42'` |

Row 2 is the strongest of these: `claude` was on PATH, so the session ran a real
model turn **inside a real git worktree**. Row 1 is its control — the same driver,
no config, and no worktree entry appears.

**A harness failure worth recording, because it cost two false reds.** The first
run of that script scrubbed `PATH` down to `System32`, which removed `git` from
the child — so rows 2 and 3 failed for a reason that had nothing to do with the
code. It is the mirror of the defect already in the ledger ("a harness that
supplies what the real caller does not"): **a harness that REMOVES what the real
caller has tests a caller that does not exist just as surely.** Worse, the `sed`
that was supposed to fix it did not apply, and the identical second run read as a
confirmation. Two instrument failures, one measurement.

**Falsification, by the coordinator, of both acceptance clauses that carry weight:**

- `git stash push -- packages/session/src/run-session.ts` (mount reverted):
  `packages/cli/test/worktree-run.test.ts` → `× runs the session inside a real
  git worktree of that repository`, **1 failed | 1 passed** — its control test
  stayed green, which is the discrimination the acceptance asks for. Restored.
- The same stash ALSO left `guard.test.ts` green, because `workspaces.ts` still
  imported the package. So the guard proves the IMPORT edge, not the MOUNT — a
  nuance this spec's prose overstated. Falsified properly by moving
  `workspaces.ts` aside as well: `× imports nothing it has not declared, and
  declares nothing it does not import`, **1 failed | 3 passed**. Restored, 4
  passed. **The two clauses are load-bearing for different claims and both are
  needed; neither alone is the acceptance.**

**Gate.** `check-source-bytes` exit 0 · `pnpm typecheck` exit 0 · `pnpm lint`
exit 0 · all ten packages green excluding the live suites — contracts 143,
kernel 264, session 99, registry 142, environment 107, projection 268 (+3
skipped), cli 158, adapter-cli 132 (+6 skipped), workspace-local 23,
workspace-git-worktree 13 = **1,349 passing** · `pnpm build` exit 0 ·
`pnpm proof:consumer-install` 9 passed / 1 skipped with five direct
dependencies.

`pnpm check` as one command still cannot complete on this machine: it aborts in
`packages/projection` on the known Windows-only
`test/skills-discovery.live.test.ts`, so `lint` never runs from it. Both live
suites are the two already in the ledger and neither is this story's.

**Not verified, and stated rather than implied:** cross-process concurrency on one
state directory (out of scope by measurement 8, and nothing here exercised it);
the two live suites; and whether a worktree cut inside the repository's own
working tree — which shows as an untracked `.panda/` in the parent — is the right
long-term layout. That is the same directory the local provider already writes
into, and no story has judged it.
