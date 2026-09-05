# Spec M9.A — the registry can fill itself

**Status:** FROZEN
**Story:** gives `ingestProviders` its first production caller (FR-13c ingest half;
re-homes the `deferred-work.md` entry that has been moved twice and never landed)
**Base commit:** `100ed99`

---

## Intent

`panda ingest` puts the skills already on this machine into the registry, so the
registry can hold something without a user typing one command per skill.

Today it cannot. `packages/registry/src/ingest.ts` is 375 lines of finished,
two-phase, coded-error ingestion with **zero production callers**, and the
`SkillSource` port it serves has **zero implementations**. Meanwhile this machine
carries 38 skills in `~/.claude/skills` and 27 in `~/.agents/skills`, and
`panda list` returns `"entries": []`.

That gap is panda's own defect class one level up: not a guarantee stated in
prose, but a **capability stated in code that no product surface reaches**. Every
diagnostic story after this one — 5.5's remainder, 5.6 — reports over a registry
that is structurally empty, so this comes first.

---

## The measurement this rests on

Every line below was executed on the base commit, not read.

| # | Measurement | Evidence |
|---|---|---|
| M1 | `ingestProviders` has zero production call sites | `codegraph callers ingestProviders` → 3 hits: `registry/src/index.ts:5` (a re-export, not a call), `registry/test/ingest.test.ts`, `projection/test/ingest-projection.test.ts`. **Control:** `diagnose(` in `packages/*/src/` → 3 real call sites (`cli/src/run.ts:233,255`, `environment/src/remediate.ts:127`). |
| M2 | `SkillSource` and `ToolProvider` have zero implementations in any `src` | `packages/contracts/src/providers.ts:69,80` declare them; no `implements`/factory anywhere in `packages/*/src`. **Control:** `ProjectionTarget` → 3 shipped targets wired at `environment/src/executors.ts:145`. |
| M3 | The registry is empty on a machine full of skills | `panda list` → `"entries": []`; `ls ~/.claude/skills` → 38, `ls ~/.agents/skills` → 27. |
| M4 | One `--entry-path` is ONE entry; a directory does not fan out | `packages/projection/src/targets/skills.ts:129-137` — `filesFor` returns one file for a file, and `collectFiles(source, id)` for a directory, i.e. the whole tree copied under a SINGLE id. Registering 38 skills today is 38 commands. |
| M5 | The roots panda writes skills into are already VERIFIED by running the real binary | `packages/environment/src/executors.ts:143,168,189` — `machineSkills` is `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`. `:99-109` records that an unverified location reports `undefined` rather than inventing one. |
| M6 | Ingestion's documented semantics are ADDITIVE | `packages/contracts/src/providers.ts:73-77` — "entries an origin stops listing are left in the registry untouched. Reconciliation/pruning is a separate decision". |
| M7 | `contentHash` is opaque to panda by contract | `packages/contracts/src/providers.ts:44-49` — "panda never computes or interprets it, it only compares it against the token recorded on the stored entry". |
| M8 | An origin's `entrySchema` is consulted for ISSUES ONLY | `packages/contracts/src/providers.ts:59-63` — "a returned `value` is DELIBERATELY discarded". |
| M9 | The ownership ledger records exactly what panda wrote, by path and hash | `packages/contracts/src/projection.ts:43-61,77` — `ProjectionOwnedPath` / `ProjectionLedgerRecord`; "panda removes exactly these paths and only while each still hashes to what panda wrote". |

**The hazard M5 and M9 together expose, and the reason this spec exists in this
shape:** panda PROJECTS skills INTO `~/.claude/skills`. A source that reads that
directory reads panda's own output. Left alone, `ingest` would register panda's
projections as new source skills, and every run would grow the registry with a
copy of itself. The ledger is the discriminator, and D3 below is the rule.

---

## Boundaries & Constraints

### D1 — `panda ingest [--dry-run]` is the first production caller of `ingestProviders`

The command constructs the filesystem `SkillSource` (D2), hands it to
`ingestProviders`, and reports the `IngestOutcome`. It does not re-implement
collection, validation, or writing: that is what the 375 lines already do.

Exit code follows the existing product convention — a run that wrote nothing
because there was nothing to write is a RESULT, not a failure, and exits 0, the
same answer `panda list` gives for an empty registry.

### D2 — the source reads ONLY the roots panda has already verified

The three `machineSkills` roots at `environment/src/executors.ts:143,168,189`,
and an executor whose `machineSkills` is `undefined` contributes no root. This
invents no location: they are the same paths, derived from the same trait
records, that the projection half already writes to and that `test/skills.test.ts`
pins against the shipped traits.

`~/.agents/skills` is NOT read in this story, despite holding 27 skills here. No
panda-supported executor has been PROVEN to read it, and a user-named root is a
separate decision (D8).

### D3 — a path the ownership ledger owns is NOT ingested

Before contributing a candidate, the source excludes any path recorded in the
ledger. A skill panda materialised is panda's own output; re-ingesting it would
make the registry a copy of its own projection, and the second run would differ
from the first.

This is the whole reason the source cannot be a naive directory read. It is
enforced by a test that projects an entry, runs ingest, and asserts the entry
count did not grow — not by a comment.

### D4 — ingestion is ADDITIVE, exactly as the port documents

An entry already in the registry under the same `<type>:<id>` is left alone
unless its `contentHash` differs. Nothing is ever removed. Pruning is Ask First
(see below), and stays out.

### D5 — `contentHash` is mtime + size, and panda never interprets it

The filesystem's cheapest honest change token. It is compared, never parsed.
A source whose token is unchanged produces no store write and therefore a
byte-identical projection (M7).

### D6 — one skill is one directory holding the entry file, and its id is the directory name

The exact inverse of what `filesFor` writes (M4). A directory without
`SKILL_ENTRY_FILE` is not a skill and is skipped with a warning, not an error —
a `.git` or an `assets` folder next to real skills must not fail the run.

A directory name that is not a legal registry id is skipped with a warning
naming the directory and the rule it broke. It is never silently normalised into
a different id, because an id panda invents is an id the user cannot predict.

### D7 — `--dry-run` uses the SAME call, so the preview cannot drift

It reports the identical `IngestOutcome` and writes nothing. It must not be a
second computation over the same inputs: a preview produced by different code
than the write is a preview that can lie, which is the divergence this flag
exists to remove.

Implementation note, not a suggestion: pass the dry-run decision to the ONE
call, or run the same collection and skip only the store write. Two code paths
that both "list what would be ingested" is a spec violation.

### D8 — not in this story

- `ToolProvider` / `mcp-server` ingestion. The port is real; its medium is not
  the filesystem and its story is separate.
- Pruning, reconciliation, or removal of any kind (D4, M6).
- Remote sources: git, npm, marketplace.
- `~/.agents/skills` or any user-named root (D2).
- Ranked roots and shadow resolution between two roots offering the same id.
  With one root per executor and ids scoped by directory name, the collision is
  possible but not yet real; the FIRST run that produces one must report it
  rather than pick, so a collision is a reported warning here and a design
  decision later.

---

## I/O & Edge-Case Matrix

| # | Input / state | Expected |
|---|---|---|
| E1 | Root does not exist | No contribution, no error. An executor is allowed not to be installed. |
| E2 | Root exists and is empty | `empty-source` warning (`providers.ts:86-90`), exit 0. |
| E3 | Root path exists but is a FILE | Coded error naming the path. A file where a directory belongs is a misconfiguration, not an absence. |
| E4 | Directory holds `SKILL_ENTRY_FILE` | One `skill` entry, id = directory name, `entryPath` = the directory. |
| E5 | Directory holds no entry file | Skipped with a warning naming the directory. |
| E6 | Directory name is not a legal registry id | Skipped with a warning naming the directory AND the rule. Never renamed. |
| E7 | Entry already in the registry, `contentHash` unchanged | No store write. Reported as unchanged, not as written. |
| E8 | Entry already in the registry, `contentHash` changed | Replaced, and said out loud in the outcome. |
| E9 | Path is recorded in the ownership ledger | Excluded (D3). Never contributed. |
| E10 | Ledger cannot be read | Ingest REFUSES, coded, before any store write. Without the ledger D3 cannot be honoured, and ingesting panda's own output is worse than not ingesting. |
| E11 | Root unreadable (permissions) | Coded error naming the path; the store is untouched (`ingest.ts:310-314` already guarantees phase-1 failures leave it clean). |
| E12 | Two roots contribute the same id | Both reported; the collision is a warning naming both paths (D8). |
| E13 | `--dry-run` over any of the above | Identical outcome, zero bytes written. Verified by hashing the registry file before and after. |
| E14 | Same ingest run twice with no change on disk | Second run writes nothing and the registry file is BYTE-IDENTICAL. |

---

## Code Map

| File | Change |
|---|---|
| `packages/registry/src/skills-source.ts` | NEW. The filesystem `SkillSource`. Reads roots, applies D3/D6, returns `SourcedSkill[]`. |
| `packages/registry/src/index.ts` | Export the factory. |
| `packages/cli/src/registry-commands.ts` | NEW `ingest` command: build the source, call `ingestProviders`, render the outcome. |
| `packages/cli/src/run.ts` | Route `ingest`, and add it to `USAGE`. |
| `packages/registry/test/skills-source.test.ts` | NEW. E1–E12 behaviour. |
| `packages/cli/test/ingest.test.ts` | NEW. E13, E14, exit codes, and the rendered output. |

**Read before writing:** the guard test of every package you touch. A
`package.json` is not an architecture — `packages/registry/test/guard.test.ts`
and `packages/cli/test/guard.test.ts` encode import restrictions no manifest
expresses, and a previous story put code in the wrong package by trusting the
manifest.

The ledger is read through whatever `@skanl/panda-registry` is already permitted to
reach. If its guard test forbids reaching the ledger, that is the answer: the
exclusion moves to the caller and the source takes an injected predicate. **Do
not weaken a guard test to make this compile** — file a renegotiation.

---

## Tasks & Acceptance

1. Filesystem `SkillSource` over the verified roots, D2/D3/D5/D6 honoured.
2. `panda ingest [--dry-run]` calling `ingestProviders` — the single call of D7.
3. E1–E14 covered by tests, TDD, RED first.
4. `panda ingest` run against a real home registers the skills that are there,
   and running it twice leaves the registry file byte-identical (E14).
5. Projecting an entry and then ingesting does NOT grow the registry (D3).
6. `pnpm check` green, plus `pnpm build && pnpm proof:consumer-install` — this
   story adds import specifiers, and the local gate is NOT the CI gate.

**Acceptance is by EXECUTION, not by a green suite.** A harness that supplies
what the real caller does not is testing a caller that does not exist: `panda
project swap` exited 2 for every real user while its whole suite was green.
Drive the binary.

---

## Ask First

- **Pruning.** The moment a user deletes a skill from disk, the registry keeps
  it (M6). That is the port's documented semantics and it is deliberate here,
  but it is the first question a user will ask. Do not implement it; record it.
- **`~/.agents/skills`.** 27 skills sit there on the author's machine and no
  executor is proven to read it. Reading it as a SOURCE is defensible in a way
  writing it is not — but it is a decision, not an implementation detail.
- **Two roots, one id.** D8 says report. If the implementer finds a case where
  reporting is not enough to leave the state, that is a renegotiation.
- If a frozen clause above is wrong, FILE A RENEGOTIATION rather than
  implementing past it. Every implementer that did so caught a real defect.

---

## Spec Change Log

| When | Change | Why |
|---|---|---|
| Freeze | Initial | — |
| Amend 1 | **Code Map "Read before writing" named two files that do not exist.** `packages/registry/test/guard.test.ts` and `packages/cli/test/guard.test.ts` are not in the repo. Guard tests exist in FIVE packages only: `environment`, `kernel`, `projection`, `session`, and `adapter-cli` (under the different name `traits-guards.test.ts`). Control: both `test/` directories DO exist, so the query was live. | A spec error of mine, caught by the implementer filing a renegotiation instead of implementing past it. The clause's own fallback held: the placement was decided by `environment/test/guard.test.ts` and `eslint.config.js`, and no guard was weakened. **Recorded separately as a real gap: AD-2 is enforced by a guard test in 5 of 10 packages, and `registry` and `cli` — both touched here — are among the five with none.** |
| Amend 2 | **D8's "two roots, one id" refusal is upgraded: identical trees collapse to ONE entry; only divergent trees stay refused.** Measured independently, twice, on the author's real machine: 40 distinct ids across the three verified roots — 16 in exactly one root, **11 identical across roots**, **13 genuinely divergent** (`_shared`, `graphify`, `issue-creation`, `judgment-day`, `sdd-apply`…`sdd-verify`). As frozen, ingest delivers 16 of 40. | The Ask First clause named this trigger verbatim, and it fired. **22 of 40 ids sit in ALL THREE roots because the user has been hand-syncing three roots — that is not an edge case, it is panda's target user and its main case.** Refusing 60% of the main case is handing the problem back, which the owner's governing principle forbids. The refusal was still the right frozen call for the 13 that differ: picking one would silently choose between genuinely different skills. **Note for the implementer: D5's mtime+size token does NOT answer cross-root identity** — two identical trees copied at different times carry different tokens. This needs a real content comparison, computed ONLY on the collision path (24 ids here, never all 40). |
| Amend 3 | **BLOCKING defect, fix required in this story: a projection whose source path IS its destination path is `already satisfied`, not `foreign-collision`.** Verified by execution: ingest one skill from `~/.claude/skills`, run `init` → `drift (foreign-collision) at alpha: '…\.claude\skills\alpha' is not claimed by panda's ledger and it already exists`, and `doctor` then reports 2 problems for 1 ingested skill. | Ingest reads from the roots projection writes into, so every ingested skill arrives already at one of its destinations. Left as-is, **using the feature immediately reports a broken environment** — panda handing the problem back. The verdict is also factually wrong: the bytes that should be there ARE there, so there is nothing to write and nothing to claim. Measured alongside it, the rest of the promise already works: that same `init` correctly projected the ingested skill into `~/.codex/skills` and `~/.config/opencode/skills`. Do NOT fix this by adopting the path into the ledger — panda did not write it, and `remediate release` would then delete a user's own skill. |

---

## Verification

Every line below was executed by the spec author against the finished tree, in a
throwaway home and on the real machine. None of it is the implementer's report
repeated back.

### Amendment 3 — the blocking defect, before and after

Sandbox home with one skill in `~/.claude/skills/alpha` and all three executor
configs present so all three are detected.

BEFORE: `panda ingest` → `panda init` printed
`drift (foreign-collision) at alpha: '…\.claude\skills\alpha' is not claimed by
panda's ledger and it already exists`, and `panda doctor` reported **2**
`foreign-collision` findings, exit **1**.

AFTER, run by the author:

| check | result |
|---|---|
| `panda init` stderr | **empty** — no drift |
| `panda doctor` | `"findings": []`, exit **0** |
| the skill on disk | present in **all three** roots (`.claude`, `.codex`, `.config/opencode`) |
| the ownership ledger | claims `.codex\skills\alpha\SKILL.md` and `.config\opencode\skills\alpha\SKILL.md` **and nothing else** |

That last row is the constraint the fix could most easily have violated. The
source root is NOT in the ledger: panda still does not claim a file it did not
write, so `remediate release` cannot become an authority to delete a user's own
skill.

### Amendment 2 — the collision counts, measured three independent ways

The spec author measured the roots twice with code sharing nothing with the
implementation, before the fix round and again after:

```
distinct ids across the three verified roots: 40
  in exactly one root: 16
  identical across roots: 11
  divergent: 13  (_shared, graphify, issue-creation, judgment-day,
                  sdd-apply, sdd-archive, sdd-design, sdd-explore,
                  sdd-init, sdd-propose, sdd-spec, sdd-tasks, sdd-verify)
```

The binary now agrees on the real machine: `registered: 27 | skipped: 14 |
dryRun: true` — 16 + 11 = 27 ingested, 13 `id-collision`, 1 `not-a-skill`.
Before the amendment it was 16.

### E13 — dry-run writes nothing, with the strongest available control

`~/.panda` did not exist before the real-machine dry run and **did not exist
after it**. Not "the file was unchanged": the directory was never created.

### The gate

| stage | result |
|---|---|
| `check-source-bytes.mjs` | **BYTES OK** |
| `pnpm typecheck` | Done, 10/10 packages |
| `pnpm lint` | exit **0** |
| `pnpm build` | Done, 10/10 packages |
| `pnpm proof:consumer-install` | **8 passed, 1 skipped** — the FR-29 half `pnpm check` does not run |

Suites run individually with `**/*live.test.ts` excluded (no dot — the dotted
form silently misses one of this repo's two naming styles): kernel 264 ·
contracts 143 · adapter-cli 132 · workspace-local 23 · workspace-git-worktree 13
· registry 142 · projection 268 · session 98 · environment 107 · cli 156.
**1,346 passing, zero failing.**

`pnpm check` itself aborts in `packages/adapter-cli` on
`test/confinement-live.test.ts:537` — a LIVE suite driving the real opencode
binary, where neither concurrent session asked to write. `git status --porcelain
packages/adapter-cli` is **empty**, so nothing in this story touched it; it is
the §10 live-provider class, not a regression. `packages/projection`'s
`skills-discovery.live.test.ts` remains the other documented local-only red.

### What is NOT verified here

- The `machineSkills === undefined` branch of D2. All three shipped profiles
  declare a root, so no shipped profile drives it, and no fourth profile was
  fabricated to manufacture coverage.
- Everything under D8, which was not built.

### One consequence to record, not a defect

Once a colliding id is collapsed, the recorded `contentHash` is the CHOSEN
root's mtime+size. Editing only a non-chosen copy leaves that token unchanged,
so the registry row is not rewritten and the divergence surfaces as an
`id-collision` on the next ingest while the entry keeps pointing at the first
root. That follows from the port's documented additive semantics (M6), and
repointing is the Ask First item that stays out.

### A gap this story uncovered and did not close

**AD-2 is enforced by a guard test in 5 of 10 packages** — `environment`,
`kernel`, `projection`, `session`, and `adapter-cli` (under the different name
`traits-guards.test.ts`). `registry` and `cli`, both touched here, have none.
Placement was decided instead by `environment/test/guard.test.ts` and
`eslint.config.js`, and no guard or lint rule was weakened to make this compile.
