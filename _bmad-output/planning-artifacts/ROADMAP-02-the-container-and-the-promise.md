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

---

## Amendment (2026-08-26) — M3 closed, and one finding reorders M4

M3 shipped: 3.A distribution and a falsifiable SDK proof, 3.B plugins mounting
for real, 3.C a token budget that is no longer a boolean. Re-measuring the
question this roadmap is built on:

**12 of 94 exported symbols have no production caller** (it was 14 of 87). After
discounting the false positives — adapter factories held as values in the
catalogue, SDK entry points a consumer calls, the test harness — two real ones
remain, and they are the same two: Story 2.4's provider ports (`ingestProviders`,
`IngestWriteFailure`), and **`createRegistryPlugin` — a complete plugin that
nothing mounts.** M3.B put its Ask-First on "making the registry, projection or
doctor paths mount plugins", so this is a scoped deferral rather than a miss; but
it means "everything is a plugin" is true of the run path and false of the
environment path, and Epic 5's diagnostics build on the environment path.

The ledger is 76 entries, 62 open — up from 56/50 before M3, roughly six per
story. Still a signal to re-read once per milestone rather than a backlog.

### The finding that reorders M4

M3.C surfaced something incidental to token accounting and load-bearing for
Epic 4. Quoting the ledger, because the wording is exact:

> `WorkspaceHandle.rootPath` is delivered to an executor as the child's cwd and
> nothing else, so for opencode the workspace is a suggestion rather than a
> boundary.

It was found by accident: a live check asked opencode to create two files and
they appeared in `packages/adapter-cli` — the directory the test process was
launched from — twice, reproducibly, while the child had been spawned with `cwd`
set to a fresh temp directory outside the repository. Ruled out as a panda bug by
a control child through the same spawner, which reported the temp directory
exactly. The mechanism is unproven; an inherited `INIT_CWD` is the named suspect.

**Epic 4 is built entirely on that premise.** FR-19 is *"concurrent isolated
sessions"*; 4.1 is managed worktrees with durable ownership; 4.2 is concurrency
across them. If one of three shipped executors does not confine its file
operations to the workspace it was handed, then two concurrent sessions in two
worktrees are not isolated, and the isolation panda would be advertising is a
property of the executor rather than of panda.

This is the shape that made M1 and M3.B right, twice: a premise that is cheap to
retire now and expensive to discover after three stories are built on it. So it
goes first.

### M4 — the workspace is a boundary, or panda says it is not

- **4.A — Executor confinement, measured per executor.** Whatever each of the
  three actually does with the cwd it is given, established by execution against
  the real binaries and turned into a known quantity. An executor that does not
  confine must be reported as not confining; panda must not advertise an
  isolation it cannot demonstrate. The named suspect — an inherited environment
  hint — is panda's to control, since panda builds the child's environment.
- **4.B — 2.9, skills as filesystem materialisation.** Unchanged from the
  original M4, and still first among the Epic 2 leftovers: you cannot export what
  you cannot materialise.
- **4.C — the rest of Epic 2** — 2.6 liveness re-spec, 2.11 remediation, and the
  `profile` entry kind that carries per-executor model selection.

### M5 — Portability, unchanged

Epic 5.1 and 5.2. Still the differentiator, still reachable, now with a verified
statement about what isolation a bundle's target actually has.

### Also unblocked, and worth stating

The **MethodPlugin contract (5.3/5.4)** — the piece the owner says gives panda
its value — was blocked on plugin mounting and is not any more. It is a CONTRACT
addition, which NFR-8's joint-semver rule makes cheapest before more consumers
exist. It does not go first only because Epic 4's premise is currently unknown
and a wrong answer there invalidates work; it should be the first thing after
this milestone unless portability displaces it.

### Recorded from M3, not built

`panda run` cannot set a budget — no flag, no config key, `actionPolicy` has no
production caller outside `run-session.ts`. M3.C is true for an SDK host and
vacuous for the shipped binary. A user-facing budget surface deserves its own
frozen block; the layered configuration already has the shape for it.

## Amendment 3 — the measure that reorders M5 (2026-08-26)

M4.C's review round closed the four terminal states. Verifying one of them
end-to-end through the CLI is what produced this amendment, because the fixture
could not be built.

**Measured, by execution, not by reading:** the shipped binary accepts `run`,
`init`, `project init`, `doctor`, `project doctor`, `remediate`,
`project remediate` and `--help`. Grep across all of `packages/cli/src/` finds no
`RegistryStore` and no `.register(`. **No panda command writes to the registry.**

So M4.A through M4.C built projection, materialisation, diagnosis and remediation
over a store that, from the binary, is permanently empty. The machinery is real —
its four stories are individually sound and their tests exercise it through the
library. What none of them noticed is that the library is the only door.

Two consequences make this the next story rather than a backlog note:

1. **FR-11 is unbuilt at the surface.** It reads *"register Tool/Skill/MCP server
   once at global scope or override per project/agent scope"*. Story 2.1 claims
   FR-11 and its three acceptance criteria are about envelope validation and lock
   contention — correct, and none of them a verb. This is the same shape as the
   ROADMAP-01 measurement failure: a criterion that is true of the code and
   silent about whether anyone can reach it.

2. **Two of `doctor`'s own exits name an operation the binary cannot perform.**
   `removed-by-user` and `unprojectable` both route the user to "the entry has to
   leave the registry", and both then admit *"panda ships no command for that yet,
   only `RegistryStore.remove` in `@panda/environment`"*. M4.C reported the gap
   rather than papering over it (correction-01 C5), which is why it is visible at
   all — but a remediation catalogue whose exits terminate in a library call is
   not an exit for a user of the binary.

**Reordering:** M4.D takes the slot M5 held. Portability (5.1/5.2) exports a
bundle of registry entries; exporting a store a user cannot populate would repeat
this mistake one layer up. MethodPlugin (5.3/5.4) keeps its position after it.

**What M4.D generalises, and the reason it is not merely "add three commands":**
89 backtick-quoted `panda …` strings ship inside panda's output text. Each is a
promise the binary must keep, and today all of them are kept by review attention.
That is the defect class this whole milestone kept surfacing — a guarantee stated
in prose instead of enforced by something that fails when violated. M4.D pins it:
every command panda's output names is a command panda dispatches, checked by a
test, over the shipped source.
