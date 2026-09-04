# Spec M14.A — memory is a contract with two proofs

**Status:** FROZEN
**Story:** implements **Epic 3 whole** — 3-1 (`MemoryProvider` port, FR-15,
RD-1) and 3-2 (filesystem + SQLite providers, FR-16), together, so scenario
**S2** passes.
**Base commit:** `0e7f9a6`

---

## Intent

Panda has no memory surface at all. Every `memory` occurrence under
`packages/*/src` is the kernel's in-memory log sink or prose about heap.
FR-15 specifies the port, FR-16 the two shipped providers, and S2 is the proof
that an identical consumer sequence runs unchanged on both.

**A CORRECTION THIS SPEC RESTS ON, because the coordinator got it wrong first
and it changed the recommendation.** The coordinator previously read story 3.2's
"one consumer test-sequence" as a defect — an acceptance criterion blessing a
test-only consumer, which is this project's most expensive defect class. It is
not a defect. The PRD SPECIFIES it: FR-15's own testable consequence is "One
consumer **test-suite** passes unchanged against both shipped providers", S2 is
"an identical consumer **sequence** runs unchanged on both shipped
MemoryProviders", and SM-3 — an external developer implementing a MemoryProvider
— is marked "long-term directional signal, **not a release gate**". The consumer
of this epic is the conformance suite, by design, and `private: true` therefore
does not block it either.

## The measurement this rests on

Executed 2026-09-03 at `0e7f9a6`, every zero with a control.

| # | Claim | Evidence |
|---|---|---|
| M1 | Panda has no memory surface | `memory` under `packages/*/src` occurs only as `createMemoryLogSink`, `in-memory`, and prose. **Control:** `createMemoryLogSink` in `kernel/src/log.ts` returns 1, so the search sees. |
| M2 | `MemoryProvider` does not exist as a symbol | gitnexus `context` reports it not found, while resolving `WorkspaceProvider` with both its implementations in the same index. |
| M3 | The conformance-suite idiom already ships, twice | `packages/contracts/src/contract-suite/` holds `clause.ts`, `executor-clauses.ts`, `workspace-clauses.ts`, each a `Clause<T>[]` behind a `*_SUITE` name. This is the third application of a shipped pattern, not a new one. |
| M4 | SQLite needs NO new dependency | `node:sqlite`'s `DatabaseSync` opens, executes and queries on **Node 24.14.1 and Node 26.8.1**, the exact two versions CI runs. It prints an `ExperimentalWarning` on 24. |
| M5 | Panda's dependency posture is one dependency, total | Across all ten packages, exactly ONE non-`@panda/*` runtime dependency exists: `jsonc-parser` in `@panda/projection`. |
| M6 | Every port panda ships has a production caller — memory would be the first without one | `ExecutorAdapter` (adapter-cli plugin), `WorkspaceProvider` (M10.A), `SkillSource` (M9.A), `ToolProvider` (M11.A), `MethodPlugin` (M5.D). Named here so nobody later "discovers" memory as the defect class: the PRD designs it that way (M-correction above). |

---

## Boundaries & Constraints

### D1 — the port and BOTH providers ship together, in one story

Shipping 3-1 alone would publish a port with zero implementations, which is
precisely what this project has now paid for three times: `ingest.ts` at 375
lines with no caller, `@panda/workspace-git-worktree` finished and unreachable
for two milestones, and `ToolProvider` published in story 2.4 and unimplemented
until M11.A. Shipping ONE provider would prove the port and leave the SWAP —
which is FR-16 and S2's entire content — unproven, and panda's own history says
the second implementation then waits: `workspace-git-worktree` is that story.

### D2 — SQLite is `node:sqlite`, and no dependency is added

Measured on both CI Node versions. Panda ships one non-panda runtime dependency
in total; adding a native module for a v1 proof would cost more than the proof is
worth, and `node:sqlite` is the platform feature that removes the question.

Node 24 prints `ExperimentalWarning: SQLite is an experimental feature`. That
reaches stderr, which `panda run` treats as a contract surface. The provider must
not let that warning become panda's output: either the warning is confined, or —
and this is the ponytail answer if confinement is not cheap — the provider is
constructed lazily so nothing prints until a consumer actually opens a store,
and the ceiling is written down.

### D3 — the conformance suite uses the EXISTING `Clause<T>` idiom

`MEMORY_SUITE` and `MEMORY_CLAUSES` in `packages/contracts/src/contract-suite/`,
shaped exactly like `workspace-clauses.ts`. A second suite idiom would be a
second spelling of "how panda proves a port", and this repository has a rule
about that.

### D4 — RD-1 is binding, and it is not negotiable by this story

- Writes are **append-only** with **mandatory provenance**: writer agent id,
  workspace id, timestamp. All three, always.
- **Supersession is by append with temporal marking**, never deletion.
- **Destructive overwrite is not representable**, and an overwrite-style
  operation through the contract surfaces a **typed unsupported error** — a
  coded `PandaError`, per AD-7, never a thrown string.
- **No conflict-resolution policy** beyond temporal supersession. Semantic
  merging is explicitly deferred by RD-1 to a later phase and must not appear
  here in any form.

### D5 — provenance integrity is a CLAUSE, not a comment

FR-15's second testable consequence: "a write from workspace A is never visible
as originating from workspace B." That is the one property a provider could
plausibly get wrong while passing everything else, so it is asserted directly,
with writes from two distinct workspace ids in the same store.

### D6 — take DSH's restart clause, because it is the failure that matters

The DeepSeek Harness note records that its storage conformance harness takes a
`reopen()` — "open a NEW backend instance over the SAME medium, as after a
process restart" — and that two of its clauses exist only to exercise it. A
memory store that passes every clause in one process and loses everything on
reopen has passed nothing. The suite takes a reopen seam and at least one clause
uses it.

Also from that note, and cheap: **version by reject, never migrate.** Both
providers stamp a format version and refuse a divergent one with a coded error.
Panda reached the same decision independently for `STORE_VERSION`; this follows
it rather than inventing a migration path v1 does not need.

### D7 — the port stays as dumb as FR-15 permits

FR-15 mandates save, search, timeline listing and lifecycle metadata, so this is
not a bare key-value port. Everything FR-15 does NOT mandate stays out: no
transactions, no query language, no indexes as contract surface, no streaming, no
migration. Entry payloads are opaque to the port.

### D8 — not in this story

- **A production caller inside panda's own binary.** The PRD's consumer is the
  conformance suite (see Intent). Adding a `panda memory` verb would be
  inventing a requirement, which is the mistake 5-6 and the Profiles item were
  closed on.
- Semantic merge, conflict resolution, LLM-judged consolidation — RD-1 defers
  all of it by name.
- Any new runtime dependency.
- Any change to `REGISTRY_ENTRY_TYPES`. Memory is not a registry entry.

---

## I/O & Edge-Case Matrix

| # | Input / state | Expected |
|---|---|---|
| E1 | Save with all three provenance fields | Stored and queryable, all three preserved verbatim. |
| E2 | Save missing any provenance field | Refused, coded, naming the missing field. |
| E3 | Two writes, workspace A and workspace B | Each reads back with its OWN workspace id; neither is visible as the other's. |
| E4 | An overwrite-style operation | Coded typed-unsupported error. Not silently ignored, not partially applied. |
| E5 | Supersession | The superseding entry is APPENDED with temporal marking; the superseded entry still exists and is still readable. |
| E6 | Search with no match | Typed empty result, never an error and never `undefined`. |
| E7 | Timeline ordering | Deterministic, and any ordering that is NOT deterministic is explicitly marked as such by the suite (FR-16's own escape clause). |
| E8 | **Reopen** — a new provider instance over the same medium | Every entry written before the reopen is present, with provenance intact. |
| E9 | A store written under a different format version | Coded refusal naming the versions. Never migrated, never partially read. |
| E10 | Two providers, one identical operation sequence | Equivalent results, modulo orderings the suite marks non-deterministic. |
| E11 | A store path that cannot be created or opened | Coded error naming the path. Absence of a store is not the same as a store that cannot be opened (AD-5). |
| E12 | Empty store, then timeline | Typed empty, not an error. |

---

## Code Map

- `packages/contracts/src/memory.ts` — NEW. The port, its result types, its
  provenance type, and the coded errors it names.
- `packages/contracts/src/contract-suite/memory-clauses.ts` — NEW.
  `MEMORY_SUITE` + `MEMORY_CLAUSES`, in the existing idiom, with the reopen seam.
- `packages/memory-filesystem/` — NEW package. Tier 1 in AD-2's order, so
  `packages/contracts/test/topology.test.ts` MUST be updated to declare it or
  the topology gate fails — which is that gate working as designed.
- `packages/memory-sqlite/` — NEW package, same tier, same requirement.
- `packages/contracts/test/topology.test.ts` — the two new packages declared.
- `packages/session/test/consumer-install.proof.ts` — the packed-package list
  gains both, if the proof enumerates workspace packages.

---

## Tasks & Acceptance

- [ ] The `MemoryProvider` port, FR-15's four operations, RD-1's three rules
- [ ] `MEMORY_CLAUSES` in the existing suite idiom, with a reopen seam
- [ ] The filesystem provider
- [ ] The SQLite provider on `node:sqlite`, no new dependency
- [ ] Both packages declared in the topology gate

**Acceptance Criteria:**

1. **S2 passes: ONE clause array runs against BOTH providers** and every clause
   passes for each, with the provider named in the failure message so a red
   clause says which one broke.
2. **Provenance integrity is proven, not assumed**: writes from two distinct
   workspace ids in one store, each read back with its own id, and a clause that
   FAILS if a provider returns the wrong one — proven by planting exactly that.
3. **The reopen clause fails when persistence is broken.** Falsify it: make one
   provider's write in-memory only and show that clause, and only that clause,
   go red.
4. **An overwrite-style operation is refused with a CODED error** from both
   providers, matched on the code and never on the message (AD-7).
5. **The topology gate accepts the two new packages only because they were
   declared** — proven by adding the packages first and watching the gate name
   them, exactly as M12.A's acceptance did.
6. **No new runtime dependency**: every `package.json` still declares only
   `@panda/*` plus the one pre-existing `jsonc-parser`.

---

## Ask First

- Any `panda memory` verb, or any production caller inside panda's binary.
- Any runtime dependency, including a SQLite driver.
- Any deviation from RD-1's append-only / provenance / no-overwrite rules.
- Any second conformance-suite idiom.

---

## Spec Change Log

0. Frozen at `0e7f9a6`. Written after correcting the coordinator's earlier
   reading that story 3.2's "one consumer test-sequence" was a defect; the PRD
   specifies it, and the correction is what unblocked this epic.

---

## Verification

Executed 2026-09-03 on Node 24.14.1 (win32). Every acceptance criterion below
was proved by RUNNING something, and every asserted absence carries a control.

### AC1 — one clause array, both providers

`MEMORY_CLAUSES` (12 clauses) runs against BOTH providers, twice each: once as
an aggregate through `runMemoryContractSuite`, once clause-by-clause against a
fresh harness. `packages/memory-filesystem` 7 passed, `packages/memory-sqlite`
10 passed. `runMemoryContractSuite` folds the harness's `providerName` into
every violation detail, and that path is DRIVEN rather than described: each
package has a test that deliberately reddens the first clause and asserts the
provider name appears in every violation.

### AC2 — provenance integrity, proven by planting

Three plants, each reverted, each verified green before and after.

| Plant | Provider | Result |
|---|---|---|
| `matches()` compares the workspaceId query against `provenance.agentId` | filesystem | `provenance-never-crosses-workspaces` ONLY, aggregate report held exactly one violation |
| `save()` stamps every entry with the FIRST stored entry's workspaceId | filesystem | `provenance-never-crosses-workspaces` in independent mode; that clause plus `supersession-appends-and-preserves-the-superseded` and `state-survives-reopen` in the aggregate, all three detecting the same planted write |
| the `workspace_id = ?` filter queries `agent_id` instead | sqlite | `provenance-never-crosses-workspaces` ONLY |

The clause asserts BOTH halves of "a write from workspace A is never visible as
originating from workspace B": each entry's own provenance read back from the
store, and the filtered reads, since a correct row reachable through the wrong
filter is the same leak seen from the other side. Writes are INTERLEAVED (A, B,
A, B) so a provider stamping every row with the first or last writer it saw
cannot pass an A-then-B ordering by luck.

### AC3 — the reopen clause fails when persistence is broken

`@panda/memory-filesystem`'s `save()` had its `appendFile` removed, leaving the
in-memory array intact. The aggregate report held EXACTLY ONE violation:

```
state-survives-reopen: [@panda/memory-filesystem] a new provider instance over
the same medium sees 0 entries, 16 were written
```

Every other clause stayed green, which is the point: correctness in one process
and durability across processes are separate properties, and the suite can tell
them apart. The package's own medium-level tests (`provider.test.ts`) also went
red on the same plant, by design — they read the file rather than the provider.

### AC4 — overwrite refused with a CODED error, matched on the code

Both providers refuse through `memoryOverwriteUnsupported()` in
`@panda/contracts`, so the two cannot drift. Falsified: the filesystem provider
was made to throw a plain `Error` whose MESSAGE still said the right thing, and
`overwrite-refused-and-store-unchanged` went red alone with
`rejected with non-coded error: ..., expected
PANDA_CONTRACT_MEMORY_OVERWRITE_UNSUPPORTED`. The clause also asserts the
refusal is categorical (an unknown id refuses the same way) and that nothing was
partially applied — an absence that carries its own control, since it first
proves the search CAN find the original payload.

E9 was falsified the same way: with SQLite's version check disabled,
`divergent-format-version-refused` went red alone —
`a store stamped with another format version opened instead of being refused`.

### AC5 — the topology gate named the packages BEFORE they were declared

Both packages were created with sources and the gate run against them
undeclared. It failed in both directions, naming them:

```
AD-2 violations:
@panda/memory-filesystem has no declared tier
@panda/memory-sqlite has no declared tier
```

and `declares a tier for every package, and names no package that is gone`
failed alongside it. They were then declared at tier 1 and the gate went green.
`packages/session/test/consumer-install.proof.ts` DOES enumerate workspace
packages, so `PACKAGE_DIRS` gained both; `pnpm build && pnpm proof:consumer-install`
is 10 passed, 1 skipped.

### AC6 — no new runtime dependency

Every `package.json` under `packages/` parsed and its `dependencies` printed —
the full listing IS the control, since it shows the scan sees real dependencies
in eleven of twelve packages. Exactly one non-`@panda/*` runtime dependency
exists across the workspace: `projection -> jsonc-parser`, which predates this
story. `@panda/memory-sqlite` declares `@panda/contracts` and nothing else;
`node:sqlite` is the platform.

### Gate

- `node scripts/check-source-bytes.mjs` — OK
- `pnpm typecheck` — 12 of 12 packages Done
- tests, per package, excluding the two known-red live suites (`**/*live.test.ts`):
  kernel 264, contracts 147, adapter-cli 132, memory-filesystem 7, memory-sqlite 10,
  projection 307, registry 161, workspace-git-worktree 13, workspace-local 23,
  environment 126, session 103, cli 169 — all passing
- `pnpm lint` — clean
- `pnpm build && pnpm proof:consumer-install` — 10 passed, 1 skipped

`pnpm check` itself aborts in `@panda/projection` on
`test/skills-discovery.live.test.ts`, a live suite driving real vendor binaries;
it is one of the two suites AGENTS.md names as excluded from the development
loop and was not chased.

### The experimental warning, measured rather than assumed

Node 24 emits `ExperimentalWarning: SQLite is an experimental feature` when
`node:sqlite` LOADS, not when a database opens — so a static import would put it
on stderr for a consumer that never touches a store. D2's two answers were both
applied, because confinement turned out to be cheap: the module is imported
lazily on first `open()`, and `process.emitWarning` is patched for the duration
of that ONE memoised import. `packages/memory-sqlite/test/load-sqlite.test.ts`
proves it in child processes with two controls — a plain `import('node:sqlite')`
that MUST show the warning, and an unrelated `ExperimentalWarning` that MUST
survive the confinement — plus a third child asserting from
`process.moduleLoadList` (Node's own record, not an inference from silence) that
importing the provider loads no SQLite at all. The residual ceiling is written
down as `ponytail:` in the source and in `deferred-work.md`.

---

### Coordinator verification, on top of the implementer's

**A RED ON NODE 26 THAT THE NODE-24 RUN COULD NOT SEE, and it was in a CONTROL.**
`memory-sqlite` passed 10/10 on Node 24 and failed 1/10 on Node 26.8.1. The
failing clause was the negative control — "a plain import of node:sqlite does
print the warning" — because `node:sqlite` warns on Node 24 and does NOT on Node
26.8.1: the feature graduated between the exact two versions CI runs.

The control was well designed and its assertion was wrong. It encoded ONE
platform's behaviour as a law, so it went red on the platform that improved,
while the property it was controlling for stayed correct on both. Fixed by the
coordinator: the control now MEASURES whether this build warns and prints which
regime it is in — "warns, so the confinement clause is live" or "does NOT warn
(the feature graduated), so the confinement clause has nothing to confine and
proves only that the loader adds no warning of its own". Both Node versions green
afterwards, and the run says out loud which case it is rather than skipping
silently, because a `skipIf` nobody wrote down becomes a clause everyone believes
still runs.

**A PLANT THE IMPLEMENTER DID NOT TRY, and it is RD-1's exact violation.** The
implementer planted six shapes across provenance, reopen, overwrite and version.
The coordinator planted the one rule RD-1 states most strongly and none of those
six touched: supersession by DELETION rather than by append — `save()` splicing
the superseded entry out of the log before appending its successor. Caught by
`supersession-appends-and-preserves-the-superseded`, naming the provider and the
real numbers: "supersession must APPEND: entry count went 8 -> 8, expected +1".
Reverted; suite green and the tree verified unmodified.

**No new dependency, verified independently.** The `pnpm-lock.yaml` diff is +32
lines and contains ZERO external packages — only the two new workspace entries.
Across all twelve manifests the single non-`@panda/*` runtime dependency is still
`jsonc-parser` in `@panda/projection`, printed in full as its own control.

**The gate**: bytes 0, typecheck 12/12, lint 0, **1,462 tests green on Node 24
AND Node 26.8.1** across twelve packages, build 12/12, and
`proof:consumer-install` 10 passed / 1 skipped.

