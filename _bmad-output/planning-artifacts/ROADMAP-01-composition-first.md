---
name: 'Roadmap 01 — Composition first'
type: roadmap
status: adopted
created: '2026-08-25'
supersedes_sequencing_of: [epic-2, epic-3, epic-4]
evidence: 'measured against the repo at a76d865 with codegraph, gitnexus and the graphify knowledge graph'
---

# Roadmap 01 — Composition first

## What the measurements say

Three tools, three independent methods, one picture.

**codegraph** — `panda run <prompt>` is the entire product surface. It creates a local workspace, constructs the Claude Code adapter with `new`, runs the prompt, prints the envelope. It touches no registry, no projection, no ledger, no liveness, and neither Codex nor OpenCode. The only caller of the kernel's `mount` anywhere in the repo is a test.

**gitnexus** — `runPanda` has a downstream blast radius of 5 symbols, all in the Test module, `processes_affected: 0`. `ProjectionLedger` — the component authorised to delete entries from a user's configuration file — likewise participates in zero execution flows.

**Line count of production source reachable from the binary:**

| Package | Lines | Reachable from `panda run` |
|---|---:|---|
| contracts | 1343 | yes |
| adapter-cli | 966 | yes |
| workspace-local | 137 | yes |
| cli | 116 | yes |
| **kernel** | **1265** | **no** |
| **registry** | **1070** | **no** |
| **projection** | **1502** | **no** |

**3,837 of 6,399 lines — 60% of production source — has no production caller.**

**graphify**, over the 40 BMAD artifacts: every FR has a story and every capability F1–F8 is covered. Six requirements have no story at all, and all six are NFRs: NFR-1 (handoff budget), NFR-2 (interception waterfall), NFR-3 (workers constraints), NFR-4 (observability log), NFR-8 (contract stability), NFR-10 (memory provenance). The structural reason is visible in the graph: **the epic breakdown is organised by capability, and a cross-cutting NFR belongs to no capability**, so nothing in the decomposition had a slot for them.

## Diagnosis

Panda has built seven ports with rigorous contract suites and does not yet have a product.

This session's headline defect — a whole projection subsystem shipped green and inert, writing a vocabulary no executor reads — was not bad luck. It is what happens when code has no consumer: nothing exercises it end to end, so nothing notices it is wrong. The vendor-conformance suite added in Story 2.8 is a real improvement, but the durable detector is a composed path from the registry to a config file that a real CLI loads.

**So the next milestone is composition, not more ports.**

## The sequencing decision, and why it inverts the obvious order

The instinct is to finish Epic 2 — skills materialisation, unprojectable reporting, liveness — then compose. That is wrong, for one reason that is cheap to state and expensive to ignore.

AD-4 requires the observability log to be *"a kernel-owned core service initialised before any plugin loads"*. AD-10 requires that *"every executor-action invocation"* flow through the interception waterfall, and that budgets be enforced *"exclusively"* there. Both are ordering guarantees about a container that other things mount into.

**Right now the kernel has zero production callers. That makes this the cheapest moment these two seams will ever cost.** Adding an around-pipeline to a container nobody mounts is a contained change. Adding it after the CLI, registry, projection and adapters all compose through it is the breaking kernel API change that NFR-8's joint-semver rule turns into a major bump of all seven contracts.

The window is open precisely because we have not composed yet. Composing first closes it.

## Milestones

### M1 — Foundations, while they are still free

Kernel-internal, zero production callers today, each a breaking change once composition lands.

- **Story 1.6 — kernel-owned observability log (NFR-4).** Append-only, initialised before any plugin loads, fixed failure policy (typed degraded mode, never silent loss). Every model-visible interaction reconstructable from it.
- **Story 1.7 — tool-call interception waterfall (NFR-2, AD-10).** `pre → guard → around → post` through which every executor-action invocation flows; token budgets, loop caps and fan-out limits enforced there as declarative policy, never by prompt instruction. This is the only sanctioned home for the token-efficiency goal.

### M2 — The first vertical slice: the product exists

Story 2.7 is currently one four-criterion story that `deferred-work.md` names as the home for four separate deferred items. It cannot absorb that load. Split it:

- **Story 2.7a — `panda init` and `panda project init`.** Registry to projection to a real config file, composed **through the kernel**, not by direct construction. Gives projection, the registry and the provider ports their first production caller.
- **Story 2.7b — `panda doctor`.** Drift reporting from the ownership ledger, plus unprojectable entries surfaced as a product fact (correction-01 C5, which Story 2.10 currently carries in the abstract).
- **Story 2.7c — executor selection for `panda run`.** Codex and OpenCode ship today as library surface only; the headline promise "swap the agent, keep the workflow" is not reachable from the binary.

M2 is also the acceptance test that would have caught this session's inert-projection defect on day one.

### M3 — Finish Epic 2's surface

- **2.9** skills as filesystem materialisation, **2.6** liveness re-spec onto native hook locations (its vocabulary, sequencer and clause suite are stashed and reusable), **2.11** correction C6 remediation of blocks a previous build wrote.
- 2.10 folds into 2.7b rather than standing alone.

### M4 — Distribution

Packages export raw TypeScript with no compile or consumption story. "Usable in any project" is a vision bullet, and today `npm install @skanl/panda-...` cannot work. This also gates the open-source posture, which no artifact currently states.

## Do early, independent of the milestones

**The model as a first-class swappable axis.** The owner names it FIRST — *"the AI model, tools, plugins, MCPs, skills"* — and the artifacts carry it only inside a glossary parenthetical. The project's own reconciliation flagged it HIGH and never closed it. AD-4 enumerates the canonical entry kinds as tool/skill/mcp-server/profile; adding a kind later is a major bump of all seven contracts under NFR-8. One envelope addition now, one major version later.

## What this roadmap deliberately does not do

- It does not add capability before the existing capability is reachable. Nothing new gets built in Epic 3, 4 or 5 until `panda` composes what it already has.
- It does not treat the six orphan NFRs as a backlog sweep. Two of them (NFR-2, NFR-4) are sequencing-critical and are in M1; the rest are tracked but not urgent.
- It does not reorder Epic 4 ahead of Epic 3 yet. Worktrees-from-day-one is a real vision bullet and the planning audit is right that it is sequenced late — but pulling it forward before the composition path exists would repeat the exact mistake this roadmap corrects.

---

## Correction A (2026-08-25) — M2 is SDK-first, and the CLI is a thin binding

Raised by the product owner: *"I thought we were building a kernel or something like an SDK/framework — exactly what are we building?"* The question was right, and the roadmap above was part of the problem.

**What the artifacts say.** PRD §0: *"a headless TypeScript SDK and CLI"*. PRD §2: *"Panda ships as an SDK first: a headless kernel usable from any project… The terminal shell, Workers & Workflows orchestration, and methodology plugins are future consumers of the same contracts."* F8 describes the CLI as *"the only face of v1"* — a face, not the product.

**The drift, measured.** `runPanda` is 114 lines that mix argv parsing, exit codes and stdout formatting with the actual composition — create a workspace, obtain an adapter, run a prompt with a cancellation signal, release and dispose. A repo-wide search finds no SDK-level equivalent: the only composition panda has lives inside its CLI. A third party who installs the packages to run a prompt in an isolated workspace must reimplement it, which contradicts the PRD's own *"TypeScript SDK usable from any Node project"*.

M2 as written above made it worse: its criteria were phrased *"when `panda project init` runs"* — CLI-first, for the surface the owner most wants reusable.

**Why it happened, and this is the part worth keeping.** The knowledge graph over the artifacts shows F8's entire neighbourhood is CLI requirements — FR-24 through FR-28 — and **there is no requirement node anywhere for the SDK promise**. It lives in PRD prose and was never turned into an FR. This is the same structural failure as the six orphan NFRs: the epic breakdown decomposes by capability, F8 is named "CLI", and a promise with no requirement gets no story, no acceptance criterion, and therefore no defence against drift.

### The rule from here

**The capability lives in a package. The CLI is a thin binding: parse argv, call the function, map the result to an exit code.**

The test that keeps it honest is one sentence, and it is checkable: *anything the CLI can do, a third party must be able to do by importing packages, without `@skanl/panda-cli`.* If that fails, the functionality is in the wrong place.

### Sequencing change

A new story heads M2, before init/doctor/executor-selection, because those three build on the pattern and would otherwise be written wrong and corrected afterwards — the same argument that put the kernel seams first in M1, which held.

- **Story 2.0 — session composition through the kernel.** Extract the composition out of `runPanda` into an SDK surface, and route the executor run through the Story 1.7 interception pipeline. Behaviour-neutral for `panda run`.

That second half matters beyond hygiene. Story 1.7's spec admits its no-bypass guarantee is kernel-scoped *"because today `panda run` constructs adapters directly"*. This story is what makes it end-to-end.

### Also to close

FR-24..FR-28 cover the CLI surface; nothing covers the SDK surface. The PRD needs a requirement for it, phrased so it is testable — the sentence above is already the shape of one. Until it exists, the promise the owner cares most about has no acceptance criterion anywhere in the plan.
