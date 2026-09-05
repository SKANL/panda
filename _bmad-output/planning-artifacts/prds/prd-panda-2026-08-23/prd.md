---
title: "PRD: Panda"
status: final
created: 2026-08-23
updated: 2026-08-23
---

# PRD: Panda

## 0. Document Purpose

This PRD specifies panda v1 — a headless TypeScript SDK and CLI that make AI coding agents, their tools, their memory, and their development methodology swappable and portable. It is written for Gaspar (product owner), downstream BMAD workflows (architecture, epics/stories), and future contributors. It builds on the product brief (`_bmad-output/planning-artifacts/briefs/brief-panda-2026-08-21/`), its addendum (design constraints), and the technical research run (`research/technical-workers-workflows-agent-orchestration-2026-08-23/research.md`) plus five source-level reference digests (`references/digest-*.md`). Implementation choices live in those documents; this PRD states capabilities and testable behavior. Glossary terms are used verbatim everywhere; assumptions are tagged inline `[ASSUMPTION]` and indexed in §9.

## 1. Vision

Rent the agents. Own the environment.

Developers running multiple AI coding-agent subscriptions live inside silos: every CLI owns its own MCP servers, skills, plugins, and configs; sharing is manual drift; switching an agent breaks the workflow; moving devices resets everything. Panda refuses that trade. A plugin-kernel layer above the CLIs owns one canonical registry; each agent receives its tools as disposable projections onto its native configuration. Agents become interchangeable parts. The setup becomes a durable, portable asset.

Panda ships as an SDK first: a headless kernel usable from any project, proven daily by its author's own multi-subscription workflow. The terminal shell, Workers & Workflows orchestration, and methodology plugins are future consumers of the same contracts — nothing in v1 precludes them.

## 2. Target User

### 2.1 Jobs To Be Done

- **Functional**: set up MCPs/skills/plugins once and have every installed agent CLI see them; run the same task through different executors without changing anything; restore a full setup on a new device in minutes.
- **Emotional**: confidence that no vendor's roadmap can hold my workflow hostage; pride in a setup that is mine, versioned and portable.
- **Social (teams)**: share one tooling standard across members who each prefer different agent CLIs.
- **Builder**: dogfood the platform until it replaces my hand-edited CLI configs entirely.

### 2.2 Non-Users (v1)

- Developers wanting a graphical IDE/fleet dashboard today (Orca exists).
- Users seeking a hosted/cloud service — panda v1 is local-first only.
- Teams needing policy/compliance governance of agent usage (later possibility, not v1).

### 2.3 Key User Journeys (light)

- **UJ-1. Gaspar projects his setup into a fresh project.** He runs `panda project init` in a repo; the canonical registry compiles MCP servers, skills, and settings into `.claude/settings.json`, codex `config.toml`, and `opencode.json`; he opens Claude Code and the shared tools are there.
- **UJ-2. Gaspar moves devices.** On the old laptop he runs `panda export`; on the new one `panda import` then `panda project init` — every CLI sees the same tools without touching a vendor config by hand. Edge case: a secret-scoped entry is skipped with an explicit warning listing what needs manual re-auth.
- **UJ-3. Gaspar swaps methodology mid-project.** `panda swap method sdd --for bmad`; the next session loads BMAD instructions and artifacts while code context stays untouched.

## 3. Glossary

- **Kernel** — the fixed core: plugin lifecycle, service registry/injection, event bus, config resolution. Not swappable.
- **Contract** — a versioned public interface (TypeScript types + runtime validation + contract-test suite) that Plugins implement. The seven v1 Contracts are named in §4.
- **Plugin** — any unit implementing a Contract, loaded and owned by the Kernel.
- **Executor** — an external coding-agent CLI process (Claude Code, Codex, OpenCode…). Never a Plugin; always adapted.
- **ExecutorAdapter** — the Contract adapting one Executor behind a normalized spawn/run/result interface.
- **Workspace** — where an Executor runs: a local directory or an isolated git worktree, represented by an opaque handle.
- **WorkspaceProvider** — the Contract creating/managing/disposing Workspaces.
- **Registry** — panda's canonical store of Tools, Skills, MCP servers, and Profiles with `global | project | agent` scopes. Source of truth; vendor configs are derived.
- **Projection** — compiled output of the Registry written into an Executor's native config format.
- **ProjectionTarget** — the Contract implementing Projection for one Executor's format.
- **Skill** — a packaged instruction unit (SKILL.md convention) publishable into each Executor's expected location.
- **SkillSource** — the Contract supplying Skills into the Registry.
- **Profile** — a named, versioned bundle of Registry selections (which Tools/Skills/MCP servers are active, for whom, and per-executor model/effort selections where targets support native selection) that can be exported, imported, and swapped as a unit. Bundles carry one or more Profiles.
- **MemoryProvider** — the Contract for persistent memory (save/search/lifecycle) backing agent context.
- **MethodPlugin** — the Contract packaging a development methodology (phases, prompts, artifacts) as a loadable Plugin.
- **Bundle** — the portable export artifact of the Registry (no secrets by default).
- **Drift** — divergence between a Projection and the native config it produced (caused by vendor format changes or external edits).

## 4. Features

### 4.1 F1 — Kernel & Plugin Lifecycle

**Description:** The Kernel loads Plugins, resolves declared dependencies, exposes a scoped event bus, and layers configuration across `global | project | agent` scopes. Realizes all other features; has no user-facing surface except diagnostics.

**Functional Requirements:**

#### FR-1: Declarative plugin manifest

A Plugin can declare provided services, consumed services (hard or soft), and a config schema in a static manifest evaluated before any I/O.

**Consequences (testable):**
- Loading fails fast with a named error when a manifest field is missing or malformed.
- Hard-consumed services block readiness until provided; soft-consumed missing services yield an explicit "not configured" error at use-site, never silent undefined propagation.
- A Plugin whose dependency graph contains a cycle is rejected at load with both sides named.

#### FR-2: Reversible registration lifecycle

Every service registration is paired with a disposer; teardown unwinds registrations in reverse order.

**Consequences (testable):**
- Stopping the Kernel disposes plugins in exact reverse start order (verified by ordering log in tests).
- Double-dispose is a no-op; any operation after dispose raises a typed inactive error.

#### FR-3: Atomic validate-and-commit swaps

Swapping a Plugin implementation commits only after the replacement validates fully; observers never observe a half-swapped state.

**Consequences (testable):**
- An invalid replacement leaves the previous implementation serving; the failure surfaces as a typed swap error naming the validation failure.

#### FR-4: Scoped event bus

The Kernel event bus supports scope-filtered subscription (`global | project | agent`) such that an agent-scoped listener receives only events for its agent.

**Consequences (testable):**
- Two concurrent agent sessions produce interleaved events; each session's listener observes exactly its own subset.

#### FR-5: Layered config resolution

Configuration resolves through explicit ordered layers (defaults → global → project → agent → invocation overlay), each layer inspectable.

**Consequences (testable):**
- A diagnostic dump prints the composed config with the originating layer per key.
- Overriding at a narrower scope never mutates wider-scope files.

### 4.2 F2 — Executor Adapters

**Description:** Each supported agent CLI is adapted behind one normalized ExecutorAdapter interface. Differences between CLIs are modeled as declarative data, not subclasses. Realizes UJ-1; enables S1.

**Functional Requirements:**

#### FR-6: Normalized execution contract

An ExecutorAdapter can spawn an Executor inside a Workspace, deliver a task prompt, stream progress events, and return a typed structured result (status, changed paths, summary, errors).

**Consequences (testable):**
- The same task definition executed through two different adapters produces results conforming to the identical result schema.
- Cancellation terminates the underlying process tree and yields a typed cancelled result.

#### FR-7: Shipped adapters

v1 ships Claude Code, Codex, and OpenCode adapters.

**Consequences (testable):**
- Each shipped adapter passes the shared contract-test suite (see FR-9).

#### FR-8: Declarative executor traits

Per-executor differences (prompt delivery mode, readiness signals, flags, env patches) are data in an executor trait table, not adapter code branches.

**Consequences (testable):**
- Adding a trait-only Executor (no code changes beyond a table entry) passes the contract suite for the subset of capabilities its traits declare.

#### FR-9: Public contract-test suite

A published test suite validates any ExecutorAdapter against the contract; every shipped adapter runs it in CI.

**Consequences (testable):**
- Running the suite against a stub adapter missing a required behavior fails with the violated clause named.

#### FR-10: Liveness detection hierarchy

Executor state (started/working/idle/exited) is detected via injected hooks into the Executor's native config where supported, falling back to passive PTY/OSC observation; screen scraping is prohibited.

**Consequences (testable):**
- With hooks available, completion events arrive without polling the output buffer.
- With hooks unavailable, fallback detection still emits the same event names.

### 4.3 F3 — Canonical Registry & Projection

**Description:** One Registry holds Tools/Skills/MCP servers/Profiles with scopes; the projection engine compiles them into each Executor's native config idempotently and detects Drift. Realizes UJ-1; enables S3.

**Functional Requirements:**

#### FR-11: Scoped registry entries

A user can register a Tool, Skill, or MCP server once at `global` scope or override per `project`/`agent` scope.

**Consequences (testable):**
- A project-scope override changes the Projection only within that project.
- Deleting the override restores the inherited value on next Projection without manual cleanup.

#### FR-12: Idempotent ownership-marked projection

Projections merge only panda-owned sections of native configs using ownership markers/sentinels; foreign content is preserved byte-for-byte.

**Consequences (testable):**
- Projecting twice yields byte-identical outputs (idempotence).
- A native config containing non-panda content keeps that content unchanged after projection.

#### FR-13: Per-target strategy isolation

Each ProjectionTarget implements format-specific merge logic isolated behind the target interface; adding a target requires no changes to existing ones.

**Consequences (testable):**
- A malformed native config for one target fails projection for that target only, with a typed per-target error.

#### FR-13b: ToolProvider contract

The Contract lets a Plugin register a Tool definition (identity, schema, transport) into the Registry at a declared scope; projection makes registered Tools available to Executors through their native mechanisms (MCP server config or equivalent).

**Consequences (testable):**
- A Tool registered at global scope appears in every Executor's projection; one registered at project scope appears only there.
- A Tool definition failing schema validation is rejected at registration with a named error, never projected.

#### FR-13c: SkillSource contract

The Contract supplies Skills into the Registry from an origin (directory, embedded package), including content hashing for change detection; projected Skills land in each Executor's expected skills location per its traits data.

**Consequences (testable):**
- Modifying a source skill changes the projected copy on next projection; unchanged sources produce byte-identical projections (idempotence).
- A SkillSource with zero valid skills yields a typed empty-source warning during projection, not a silent success.

#### FR-14: Drift detection

`doctor` compares current Projections against the native configs and reports Drift with the diverging keys and suspected cause (external edit vs vendor format change).

**Consequences (testable):**
- Hand-editing a panda-owned section after projection is reported as Drift on the next doctor run.
- Re-projection after detected Drift converges state (verified by second doctor run reporting clean).

### 4.4 F4 — Memory Providers

**Description:** Persistent agent memory is just another Contract. v1 ships two implementations proving consumer-code transparency. Enables S2.

**Functional Requirements:**

#### FR-15: MemoryProvider contract

The contract covers save, search, timeline listing, and lifecycle metadata, with typed results. Writes are **append-only with mandatory provenance** (writer agent id, workspace id, timestamp); supersession is by append with temporal marking; destructive overwrite is not representable (RD-1).

**Consequences (testable):**
- One consumer test-suite passes unchanged against both shipped providers.
- A write from workspace A is never visible as originating from workspace B (provenance integrity).
- Attempting an overwrite-style operation through the contract surfaces a typed unsupported error.

#### FR-16: Shipped providers

v1 ships a filesystem provider and an embedded SQLite provider with identical behavior envelopes.

**Consequences (testable):**
- Identical operation sequences against both providers return equivalent results (modulo ordering explicitly marked non-deterministic).

### 4.5 F5 — Workspaces

**Description:** Executors run inside Workspaces created via the WorkspaceProvider Contract: a plain directory or an isolated git worktree. Concurrent sessions on separate worktrees are first-class. Feeds S1/S3; groundwork for Workers/Workflows (v-next).

**Functional Requirements:**

#### FR-17: WorkspaceProvider contract

The Contract covers create/acquire/release/dispose of a Workspace handle exposing root path and capabilities. Workspace state persists across executor sessions; the executor process itself is ephemeral per task (RD-2).

**Consequences (testable):**
- Both implementations satisfy the shared workspace contract suite.
- A second task acquiring the same Workspace observes prior filesystem state without rebuild steps performed by panda.

#### FR-18: Managed git worktrees

The worktree implementation creates worktrees with durable panda-ownership metadata, collision-free naming (used names retired permanently), and registers them in the Registry.

**Consequences (testable):**
- Creating two worktrees sequentially never reuses a name or path.
- A directory lacking panda ownership metadata is classified external and never auto-modified.

#### FR-19: Concurrent isolated sessions

Two Executor sessions can run concurrently on two different Workspaces without filesystem contention on panda-managed state.

**Consequences (testable):**
- Parallel smoke tasks on distinct worktrees complete without lock contention errors; Registry writes remain serialized and consistent.

#### FR-20: Safe disposal

Worktree disposal renames to a trash location and deletes asynchronously; startup sweeps crash leftovers matching the pattern.

**Consequences (testable):**
- Killing the process mid-disposal leaves a recoverable trash entry removed by the next startup sweep.

### 4.6 F6 — Portability

**Description:** Export the environment as a Bundle; import and re-project elsewhere. Secrets excluded by default. Realizes UJ-2; enables S4.

**Functional Requirements:**

#### FR-21: Export Bundle

`export` produces a portable Bundle containing the Registry, Profiles, and Skill sources, with machine-specific paths normalized and secret-bearing entries omitted.

**Consequences (testable):**
- The Bundle contains no values matched by the secret detector (keys/tokens patterns) — verified by scanning the artifact.
- Exporting twice without changes yields byte-identical Bundles.

#### FR-22: Import and re-project

`import` installs a Bundle into a fresh machine home and re-projects into every detected Executor; entries requiring secrets are listed as pending manual action.

**Consequences (testable):**
- After import + project-init on a clean environment, doctor reports zero Drift except explicitly pending-secret entries.

### 4.7 F7 — Method Contract

**Description:** Define and publish the MethodPlugin Contract (manifest shape, phases/artifact conventions, lifecycle hooks) so methodologies are installable Plugins. Official methodology plugins land immediately post-v1.

**Functional Requirements:**

#### FR-23: Published MethodPlugin contract

The Contract (manifest schema, command definitions, `onActivate`/`onDeactivate` hooks, docs, validation kit) is published and versioned under the same semver/deprecation policy as all Contracts (RD-3).

**Consequences (testable):**
- A sample minimal MethodPlugin written only against the published kit passes validation.
- Swapping methods (FR-28) invokes the outgoing plugin's `onDeactivate` before the incoming `onActivate`, in that order.

### 4.8 F8 — panda CLI

**Description:** Headless binary surfacing everything above. The only face of v1.

**Functional Requirements:**

#### FR-24: Project lifecycle commands

`panda init` binds a project; `panda project init` projects the Registry into detected Executors' configs.

**Consequences (testable):**
- Running against a project with no detected Executors exits non-zero listing what was not found.

#### FR-25: Portability commands

`panda export` / `panda import` implement FR-21/FR-22.

**Consequences (testable):**
- `export` on an empty Registry succeeds with an explicitly-empty Bundle (valid artifact), not an error.
- `import` of a Bundle produced by a newer schema major exits non-zero with the incompatibility named.
- After import, `panda doctor` output equals the source machine's modulo machine-specific entries reported as pending.

#### FR-26: Diagnostics

`panda doctor` reports Drift (FR-14), adapter availability, Executor detection, and pending secrets in one report.

**Consequences (testable):**
- Every reported problem includes a suggested remediation command.

#### FR-27: Environment status

`panda status` lists active Executors, current Workspaces, configured providers, and — when an Executor exposes an official usage surface — quota state read asynchronously with a ≥60s cache, never blocking spawns; panda never automates around vendor limits in v1 (RD-4).

#### FR-28: Method hot-swap

`panda swap method <id> [--for <id>]` swaps the active MethodPlugin for subsequent sessions without touching project code.

**Consequences (testable):**
- Swap persists across processes; invalid method id exits non-zero with available ids listed.

## 5. Non-Goals (Explicit)

- Panda is **not** an agent: no own model loop, no prompt engineering of its own intelligence.
- No GUI/shell in v1 (terminal shell is a future consumer Plugin).
- No multi-worker orchestration/routing policies in v1 (Workers & Workflows is v-next, design informed by research).
- No custom sandboxing technology; Workspaces delegate to git/local FS.
- No cloud sync service; portability is file-based Bundles.
- No kanban/task board of any kind.
- No modification of vendor CLIs themselves; adaptation only.

## 6. MVP Scope

### 6.1 In Scope

Kernel + seven Contracts (ExecutorAdapter, MemoryProvider, ToolProvider, ProjectionTarget, SkillSource, WorkspaceProvider, MethodPlugin definition), three Executor adapters, two MemoryProviders, two WorkspaceProviders (local, git-worktree), projection engine with three targets, Bundle export/import, `panda` CLI (init/project/export/import/doctor/status/swap), contract-test suites, TypeScript SDK usable from any Node project.

### 6.2 Out of Scope for MVP

Terminal shell (future Plugin consumer) · Workers & Workflows orchestration · SSH workspaces (contract designed wide enough per reference study) · official methodology plugins (immediately post-v1) · quota-aware routing policies · secret vault integrations beyond opt-in passthrough.

## 7. Success Metrics

**Proof scenarios** (defined here; inherited from the product brief):

- **S1 — Executor swap**: the same task definition runs through the Claude adapter and the Codex adapter with the same tool profile; both produce results conforming to one result schema.
- **S2 — Memory swap**: an identical consumer sequence runs unchanged on both shipped MemoryProviders with equivalent outcomes.
- **S3 — Projection**: one canonical global profile projects into native Claude Code, Codex, and OpenCode configs in a fresh project; each Executor observes the shared tools.
- **S4 — Portability**: `export` on machine A → `import` + project-init on machine B → doctor clean except pending secrets.

**Primary**
- **SM-1**: S1–S4 pass end-to-end on a clean environment (validates FR-6..FR-22 collectively).
- **SM-2**: Author's daily workflow runs entirely on panda for 30 consecutive days with zero hand-edited vendor configs (validates FR-11..FR-14, FR-24).

**Secondary**
- **SM-3**: An external developer implements a passing adapter or MemoryProvider using only contracts + docs (long-term directional signal, not a release gate).

**Counter-metrics (do not optimize)**
- **SM-C1**: Number of supported Executors — never grow adapter count at the cost of contract stability or contract-suite coverage.
- **SM-C2**: Projection cleverness — never add merge behaviors that reduce idempotence or foreign-content safety.

## 8. Resolved Decisions (formerly Open Questions)

All four open questions were resolved with source-level reference study, 2026 web research, and panda-first reasoning. Full evidence trails live in `addendum-prd.md`.

#### RD-1: Memory across concurrent workspaces — append-only with provenance; semantic merge deferred

The MemoryProvider Contract mandates **append-only writes with mandatory provenance metadata** (writer identity: agent id + workspace id + timestamp) and supersession-by-append; destructive overwrite is prohibited in v1. No conflict-resolution policy ships in v1 beyond temporal supersession marking. Semantic merging (LLM-judged consolidation) is explicitly deferred to the Workers & Workflows phase, where it belongs to the manager-synthesis role, not the store.

*Rationale*: 2026 research established that agent-memory contradiction resolution is write-time concurrency control — every surveyed production heuristic admits anomalies without declared isolation and provenance, and "a write is not a commit" [see addendum-prd.md R1]. Panda's single-writer doctrine (parallel intelligence, not parallel writers) means v1 never needs concurrent semantic merge; when it does (v-next), the manager synthesizes — the store must merely preserve provenance so synthesis is auditable.

*Consequences:* FR-15 strengthened accordingly; no silent interleaving between workspace sessions is possible by construction.

#### RD-2: Ephemeral executor processes over persistent Workspace state

v1 standard model: **the Executor process is ephemeral per task; the Workspace persists** (files, installed dependencies). Process pooling/warm workers are out of scope; the Workspace handle remains re-acquirable so sessions resume from disk state without rebuild.

*Rationale*: All surveyed harnesses converge on ephemeral instances; the 2026 runtime debate converged on hybrid — durable filesystem state + disposable compute [R2]. Local-first panda has no fleet-scale cold-start economics justifying pools; the ≤150ms spawn-overhead budget covers interactive use. Revisit condition: dogfooding shows spawn cost dominating real workflows.

#### RD-3: MethodPlugin surface = manifest + commands + activation pair

The Contract comprises: declarative manifest (identity, phases, artifact conventions), command definitions, and exactly **two lifecycle hooks — `onActivate` / `onDeactivate`** — required by FR-28's swap semantics (clean mount/unmount between sessions, mirroring the kernel's register-with-disposer rule). No further hooks until a second real methodology implementation demands them.

*Rationale*: Spec Kit's manifest+templates extension shape sustains 40+ community extensions; BMAD's config-persistence alternative is heavier without enforcement gains; dsh demonstrates that registration/disposal pairing is sufficient lifecycle machinery [R3].

#### RD-4: Quota state = read-only, official surfaces, off critical path

v1 surfaces quota state in `panda status` only when an Executor exposes an official usage surface (e.g., OAuth usage endpoints, app-server RPC), with PTY-parse fallback; probes are async, cached ≥60s, never blocking spawns, and **panda never automates around or rotates accounts against vendor limits in v1** (ToS gray zones documented in brief addendum).

*Rationale*: Orca's production pattern (official endpoint first, PTY fallback, per-account env isolation) proves feasibility; routing on quota is a v-next routing-policy concern, not a v1 concern [R4].

## 9. Assumptions Index

- `[ASSUMPTION]` §4.2: Claude Code/Codex/OpenCode hook/config injection surfaces remain stable enough per release to sustain adapters (mitigated by FR-8 data-driven traits + FR-9 contract suite detecting drift early).
- `[ASSUMPTION]` §4.3: Ownership sentinels survive vendors' own config rewrites (same mitigation).
- `[ASSUMPTION]` §4.5: git worktree isolation is sufficient for v1 concurrency; container-level isolation deferred without architecture prejudice (workspace handle kept opaque).

## 10. Cross-Cutting NFRs

- **Token efficiency**: inter-agent/kernel-to-executor handoffs carry references to artifacts, not pasted content; handoff size budget ≤ 4KB typical [ASSUMPTION: threshold validated during dogfooding].
- **Budget governance location**: token budgets, loop caps, and fan-out limits are enforced at the Kernel tool-call layer (hooks), never by prompt instruction — "a budget rule in a prompt is a preference".
- **Architecture-binding constraints**: the eight Research-Grounded Design Constraints in the brief addendum bind the `bmad-architecture` workflow as first-class inputs. Explicitly normative for architecture even though their features land post-v1: single-writer execution default; deterministic workflows by default; state canonical in the environment; durability contract = four converged primitives over a TypeScript-native bring-your-own-store engine.
- **Observability**: every model-visible interaction is reconstructable from append-only logs (adopted invariant from dsh study).
- **Security**: secret-bearing values never appear in logs, Bundles, or error messages (testable: secret-detector scan over logs/bundle artifacts in CI); credential-reuse modes deemed unsafe for the detected environment are refused at config time unless explicitly opted in via flag (testable: refusal path returns typed error naming the mode and the opt-in flag).
- **Portability**: no machine-specific absolute paths persist anywhere in the Registry.
- **Reliability**: projection operations are atomic (temp-file + rename) and crash-safe.

## 11. API Contracts / Versioning (Developer Product Section)

- All Contracts semver-major-versioned together; breaking change ⇒ major bump.
- Deprecation: deprecated surface warned ≥2 minor releases before removal; removal only in majors.
- Every Contract ships a public contract-test suite; CI runs it against all first-party implementations.
- Config/projection formats carry schema versions enabling forward migration.

## 12. Language / Runtime Targets & Performance Budgets

- TypeScript on Node.js LTS (>=24, Krypton), ESM, pnpm 11 monorepo; zero runtime deps in `@skanl/panda-kernel`.
- Budgets (initial, revisited at dogfooding): CLI cold start ≤ 300ms; projection of 50-entry registry ≤ 2s; adapter spawn overhead ≤ 150ms above raw CLI startup.

## 13. Why Now

The coding-agent market renews quarterly (new CLIs monthly — Orca tracks ~39); subscriptions multiply; vendor configs keep fragmenting. Every month without an environment-centric layer increases the migration debt panda eliminates. Reference study shows taxonomy convergence (window open for the portable worker-class standard nobody has claimed).
