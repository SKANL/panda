---
name: 'Roadmap 02 — The container and the promise'
type: roadmap
status: adopted
created: '2026-08-26'
supersedes_sequencing_of: [ROADMAP-01 M3, ROADMAP-01 M4]
evidence: 'measured against the repo at c4398a7 with codegraph, gitnexus and a rebuilt graphify knowledge graph over all 47 BMAD artifacts'
---

# Roadmap 02 — The container and the promise

ROADMAP-01 asked one question — *what production code has no consumer?* — and the
answer reordered the whole plan. M1 and M2 shipped against it. This roadmap asks
the same question again, because it is the only question that has ever found
anything here, and the answer has changed.

## What the measurements say now

### The dead-code picture inverted, and the old measure stopped working

ROADMAP-01 measured **3,837 of 6,399 production lines with no production caller —
60%**. Re-running that measure today returns ~0, and that number is worthless:
every package's `index.ts` re-exports its whole surface, so importing
`@panda/registry` pulls in `ingest.ts` transitively whether or not anything ever
calls `ingestProviders`. File-level reachability was the right measure when whole
packages were unreferenced. It is the wrong one now.

The honest measure is symbol-level. **14 of 87 exported functions and classes are
never called from any other production file.** Most are false positives — passed
as values, or used only inside their own module. Two clusters are real, and both
were confirmed by a second tool that does not share the first one's method.

### The kernel is a microkernel that nothing plugs into

`createKernel`, `loadPlugins` and `mount` have **no caller anywhere in `src/` or
`bin/`** — only tests. The session constructs its adapter and its workspace
provider directly.

AD-4 requires the observability log to be *"a kernel-owned core service
initialized before any plugin loads"*. That ordering guarantee is unexercised,
because nothing loads plugins. AD-3 — the plugin trust model, *"installing one is
executing it"* — describes a surface that does not exist.

The knowledge graph reached the same conclusion from the artifacts alone, with no
access to the code: **AD-3 is the only one of the ten architecture decisions with
zero adjacent story nodes.** Every other AD has between one and six, most of them
built. The `plugin` concept node itself has degree 1.

### One shipped story's ports have never run in production

`gitnexus impact --upstream ingestProviders`: `impactedCount: 0`,
`processes_affected: 0`. Story 2.4's ToolProvider and SkillSource ports are in
exactly the condition the projection subsystem was in before 2.7a — the condition
this project has already paid four stories to learn about.

### The SDK promise is verified in the one place it cannot fail

Every package is `"private": true`, version `0.0.0`, `"exports": {".":
"./src/index.ts"}`, and **no package has a build script**. `npm install
@panda/session` cannot work.

FR-29's own checkable sentence is *"anything the CLI can do, a third party must be
able to do by importing packages, without `@panda/cli`."* The consumer test that
proves it runs **inside the workspace**, where pnpm resolves `workspace:*`. Outside
it, the package cannot be installed at all. The promise the owner names first is
currently unfalsifiable.

### Three requirements have no story, and two of them are load-bearing

The rebuilt graph — 343 nodes, 921 edges over all 47 artifacts, with the two
extraction halves sharing 98 node ids so they actually join — finds exactly three:

- **NFR-1, handoff budget / token efficiency.** ROADMAP-01 named Story 1.7's
  interception waterfall *"the only sanctioned home for the token-efficiency
  goal"*. 1.7 shipped, and its own review found the collapse: with one action of
  cost 1 per pipeline, `maxInvocations`, `maxTotalCost` and `maxConcurrent` are a
  single boolean. So the goal has no implementation **and** its designated home is
  degenerate.
- **NFR-8, contract stability under joint semver.** Unimplementable while every
  package is private and unversioned. It is the same finding as distribution,
  wearing a different number.
- **NFR-3, workers constraints.** A constraint on what v1 may not preclude, not a
  feature. Correctly storyless; keep tracking it, do not write a story for it.

ROADMAP-01 reported six orphan NFRs. Two (NFR-2, NFR-4) were closed by M1. NFR-10
now has a story. The remaining three are the list above.

### Traceability drifts by convention, not by omission

The graph initially reported FR-14 (drift detection) as having no story. FR-14 is
implemented — `panda doctor`, Story 2.7b. The spec simply never cites the number.
That is worth fixing as a habit rather than as a story: **a spec that does not
name the requirements it satisfies makes every future coverage audit lie.**

### The ledger is 50 entries deep

56 deferred items, 6 resolved. Not a crisis — most are honest small print. But it
is now large enough that "it is in the ledger" has stopped being a decision and
started being a place things go.

## Diagnosis

M2 gave panda a product: a binary that composes the registry, the projection
engine, the ownership ledger and three executors, and swaps the agent under a
layered configuration. That was the right milestone and it worked.

What M2 did **not** do is make the kernel a container. Panda today is a microkernel
architecture whose microkernel is bypassed — and the owner's two highest-value
stated goals both run straight through it. *"Everything is a plugin."*
*"SDD/TDD/RDD as a swappable plugin replaceable by BMAD — creo que eso le da
valor."* Neither is reachable while plugin mounting is a test-only path.

Two more consumers are queued behind it: Epic 3's memory provider and Epic 5's
methodology plugin are each, literally, a new plugin kind. If they land as more
direct construction, *"everything is a plugin"* becomes a slogan the code
contradicts in four places instead of two.

**So M3 is honesty about the container and the promise, before anything else
mounts into either.**

## Milestones

### M3 — The container and the promise

**3.A — Distribution, and an FR-29 proof that can fail.** Build outputs, real
`exports`, package versions, and a consumer test that installs a packed tarball
into a temp project **outside the workspace** and runs a session. Small, and it
goes first for one reason: three more milestones are about to assert the SDK
promise, and right now the assertion cannot be checked. It also gives NFR-8 its
home and unblocks the open-source posture, which no artifact currently states.

**3.B — Plugins mount for real.** The executor adapter, the workspace provider and
the registry become kernel plugins with manifests; the observability log is
initialised before them, so AD-4's ordering is exercised rather than described;
one pipeline per kernel instead of one per session. Closes AD-3's orphan status
and roughly six ledger entries (the no-bypass gaps, the per-session pipeline, the
sink with no product consumer, and "the session constructs the adapter directly").

This is the story that makes the methodology plugin possible, which is the piece
the owner says gives panda its value.

**3.C — The token budget stops being a boolean (NFR-2, corrected below).** An
adapter-reported usage figure settled after the run, so a cost cap means
something. Today `SESSION_ACTION_COST` is a flat 1, which makes `maxTotalCost`
indistinguishable from `maxInvocations`: the token budget AD-10 names cannot be
expressed at all.

**Correction to this roadmap, made while specifying 3.C.** The paragraph above
originally cited **NFR-1**. That is wrong, and the error is worth keeping rather
than quietly fixing, because it would have shaped the story. NFR-1 is *"handoffs
carry artifact references, not pasted content; handoff size budget ≤4KB
typical"* — it is about **handoffs between agents**, which panda v1 does not
have; they arrive with Workers & Workflows. The requirement 3.C actually serves
is **NFR-2**: *"token budgets, loop caps, fan-out limits enforced exclusively at
the kernel tool-call interception waterfall, never prompts."* NFR-2 has a story
(1.7) and that story built the waterfall — but its **token-budget** clause is
vacuous, because no token figure exists anywhere in the stack.

So the honest statement of the gap is narrower and sharper than the original:
NFR-2's mechanism shipped and one of its three named budgets is unimplementable.
NFR-1 stays orphaned, and correctly so — it cannot get a story until there is a
handoff to budget.

### M4 — Finish Epic 2 on the machinery that now works

2.9 skills as filesystem materialisation, 2.6 liveness re-spec onto native hook
locations (its vocabulary and clause suite are stashed and reusable), 2.11 the
correction C6 remediation, and **the `profile` entry kind** — declared in the
canonical union since AD-4 and implemented by nothing, which is where per-executor
model selection actually lives (PRD §: *"per-executor model/effort selections
where targets support native selection"*).

2.9 goes first in this milestone: you cannot export what you cannot materialise.

### M5 — Portability, the differentiator

Epic 5.1 and 5.2 — export a bundle with secrets excluded, import and re-project
elsewhere. This is the owner's own framing of what nothing else does well: *"no
hay nada que haga que sea fácil llevar todo al nuevo dispositivo."* It is reachable
now, because the registry and the projection engine compose and are exercised end
to end — which was not true two milestones ago.

## The correction this roadmap makes to its own reasoning

An earlier draft of this plan opened with *"implement the model axis first,
because adding a registry entry kind later is a major bump of all seven contracts
under NFR-8."* That argument is **false** and is recorded here so it is not made
again. The PRD places per-executor model selection inside a **Profile**, and
`profile` has been in the canonical entry-kind union since AD-4. The slot already
exists; no contract break is pending. The real finding is smaller and duller: a
declared entry kind that nothing implements. It belongs in M4, not at the front.

## What this roadmap deliberately does not do

- It does not open Epic 3 (memory providers) yet. *"The memory layer is
  swappable"* is a real vision commitment, and it is a plugin — it should land
  after 3.B, not before, or it becomes the third thing constructed directly.
- It does not write a story for NFR-3. It is a constraint on v1's surface, and the
  right treatment is a check at design time, not a deliverable.
- It does not sweep the ledger. Fifty entries is a signal to re-read it once per
  milestone, not a backlog to burn down.
