---
stepsCompleted: [step-01, step-02, step-03, step-04]
inputDocuments:
  - prds/prd-panda-2026-08-23/prd.md
  - architecture/architecture-panda-2026-08-24/ARCHITECTURE-SPINE.md
---

# Panda - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Panda, decomposing the requirements from the PRD (prd-panda-2026-08-23, status: final) and the Architecture Spine (architecture-panda-2026-08-24, status: final) into implementable stories. UX design contract intentionally absent — v1 is SDK/headless; user-facing CLI behavior is specified as FRs in feature F8.

## Requirements Inventory

### Functional Requirements

FR-1: Declarative plugin manifest — plugins declare provided/consumed services (hard|soft) + config schema, validated eagerly before any I/O; cycles rejected with both sides named.
FR-2: Reversible registration lifecycle — every registration paired with a disposer; teardown unwinds reverse order; double-dispose no-op; post-dispose ops raise typed inactive error.
FR-3: Atomic validate-and-commit swaps — replacement validates fully before commit; invalid swap leaves previous implementation serving with typed error.
FR-4: Scoped event bus — scope-filtered subscription (global|project|agent); agent-scoped listener receives only its agent's events.
FR-5: Layered config resolution — defaults→global→project→agent→invocation overlay; diagnostic dump shows composed tree with originating layer per key.
FR-6: Normalized execution contract — ExecutorAdapter spawns Executor inside a Workspace, delivers prompt, streams progress, returns typed result envelope {status, data, summary, changedPaths?, errors?}; cancellation terminates process tree with typed cancelled result.
FR-7: Shipped adapters — Claude Code, Codex, OpenCode adapters pass the shared contract suite.
FR-8: Declarative executor traits — per-executor differences (prompt delivery mode, readiness signals, flags, env patches) are data in a trait table, not code branches; trait-only executors possible.
FR-9: Public contract-test suite — published suite validates any ExecutorAdapter; violations name the clause; all first-party adapters run it in CI.
FR-10: Liveness detection hierarchy — hooks injected via projection-owned merge path where supported, passive PTY/OSC fallback, screen scraping prohibited; same event names either way.
FR-11: Scoped registry entries — register Tool/Skill/MCP server once at global scope or override per project/agent scope; deleting override restores inherited value on next projection.
FR-12: Idempotent ownership-marked projection — merge only panda-owned sections using sentinel grammar; foreign content preserved byte-for-byte; projecting twice yields byte-identical output.
FR-13: Per-target strategy isolation — ProjectionTarget implements format-specific merge behind target interface; malformed native config fails that target only.
FR-13b: ToolProvider contract — register tool definition (identity, schema, transport) at declared scope; schema-invalid definitions rejected at registration, never projected.
FR-13c: SkillSource contract — supplies Skills from an origin with content hashing; changed sources re-project; empty valid source yields typed warning not silent success.
FR-14: Drift detection — doctor compares projections vs native configs, reports drift with diverging keys and suspected cause; re-projection converges state.
FR-15: MemoryProvider contract — save/search/timeline/lifecycle, typed results; writes append-only with mandatory provenance (writer agent id + workspace id + timestamp); supersession by append; overwrite-style ops surface typed unsupported error.
FR-16: Shipped memory providers — filesystem + embedded SQLite with identical behavior envelopes under one consumer test-suite.
FR-17: WorkspaceProvider contract — create/acquire/release/dispose of workspace handle exposing root path + capabilities; workspace state persists across executor sessions.
FR-18: Managed git worktrees — creation writes durable on-disk ownership record (creation-of-record) + Registry mirror in same serialized transaction; collision-free names retired permanently; unowned dirs classified external, never auto-modified; crash-recovery sweep reconciles.
FR-19: Concurrent isolated sessions — two executor sessions run concurrently on distinct workspaces without panda-state contention; registry writes serialized machine-wide.
FR-20: Safe disposal — trash-rename then async delete; startup sweeps crash leftovers by name pattern.
FR-21: Export Bundle — portable artifact with Registry+Profiles+SkillSources, paths normalized, secrets omitted; secret-detector scan passes over artifact; deterministic bytes for unchanged input.
FR-22: Import and re-project — installs Bundle on fresh machine, re-projects to detected Executors; secret entries listed pending manual action; doctor clean except pendings.
FR-23: Published MethodPlugin contract — manifest schema + command definitions + onActivate/onDeactivate hooks + validation kit, semver-versioned; minimal third-party sample passes validation.
FR-24: Project lifecycle commands — `panda init` binds project; `panda project init` projects Registry into detected Executors' configs; no detected Executors exits non-zero listing misses.
FR-25: Portability commands — export/import implement FR-21/22; empty-Registry export succeeds with explicitly-empty Bundle; newer-schema-major import exits non-zero naming incompatibility.
FR-26: Diagnostics — `panda doctor` reports drift (FR-14), adapter availability, executor detection, pending secrets; every problem includes suggested remediation command.
FR-27: Environment status — `panda status` lists active Executors, Workspaces, providers, quota state (official surfaces only, async probes cached ≥60s, never blocking).
FR-28: Method hot-swap — `panda swap method <id> [--for <id>]`; outgoing onDeactivate before incoming onActivate; persists across processes; invalid id exits non-zero listing available ids.

### NonFunctional Requirements

NFR-1: Token efficiency — handoffs carry artifact references, not pasted content; handoff size budget ≤4KB typical.
NFR-2: Budget governance location — token budgets, loop caps, fan-out limits enforced exclusively at kernel tool-call interception waterfall (AD-10), never prompts.
NFR-3: Architecture-binding constraints — single-writer execution default, deterministic-workflows-by-default, environment-as-state, durability four-primitive contract bind bmad-architecture outputs and v-next design; no v1 surface may preclude them.
NFR-4: Observability — every model-visible interaction reconstructable from kernel-owned append-only log initialized before any plugin; fixed failure policy (typed degraded mode).
NFR-5: Security — secret-bearing values never in logs/Bundles/errors (CI secret-detector scan); unsafe credential modes refused at config-resolution with typed error naming mode + opt-in flag.
NFR-6: Portability — no machine-specific absolute paths persist anywhere in Registry (normalized at write time).
NFR-7: Reliability — projection operations atomic (temp-file+rename), crash-safe; recovery sweeps defined for worktree/bundle flows.
NFR-8: API stability — Contracts semver together; deprecation warned ≥2 minor releases before major removal; public contract-test suite per Contract.
NFR-9: Performance budgets — CLI cold start ≤300ms; projection of 50-entry Registry ≤2s; adapter spawn overhead ≤150ms above raw CLI startup.
NFR-10: Provenance & auditability — memory entries carry writer/workspace/timestamp provenance (integrity testable); identity = content-hash derivation everywhere.

### Additional Requirements

From ARCHITECTURE-SPINE.md (implementation-shaping requirements):
- Monorepo pnpm 11 layout packages/* exactly as Structural Seed (kernel, contracts, adapter-claude/codex/opencode, memory-fs/sqlite, workspace-local/git, projection, cli).
- @panda/kernel: zero runtime dependencies; generic container; never imports @panda/contracts or implementations (AD-1/AD-2).
- Runtime consumption mirrors package topology: derived-state generators consume only canonical-state inputs (AD-2 tightened).
- Registry write serialization machine-scoped advisory lock keyed to store path; typed contention error (AD-4).
- Observability log = kernel-owned core service started before any plugin (AD-4).
- All persistent mutations of panda-owned state flow through owning component's serialized API; plugin direct-writes prohibited and detected by doctor (AD-4).
- Canonical Registry entry envelopes (tool/skill/mcp-server/profile) owned by @panda/contracts, enforced by Registry service; provider payloads only under reserved `extensions` namespace (AD-4).
- On-disk record = creation-of-record for materialized entities; Registry mirror same transaction; recovery sweep after crash (AD-6).
- Content-hash identity derivation; permanent name retirement (AD-6).
- Typed error hierarchy with stable PANDA_<DOMAIN>_<REASON> codes in @panda/contracts (AD-7).
- Event bus: synchronous ordered fan-out; lifecycle-transition events join handler continuations; no synchronous re-emit during fan-out; shutdown drains handlers before unwinding (AD-8).
- Config deep-merge with versioned namespaced sentinel grammar owned by @panda/contracts; unknown/legacy sentinels classify as Drift (AD-9).
- Kernel tool-call interception pipeline (pre→guard→around→post); declarative policy enforcement only (AD-10).
- Liveness hooks injected ONLY via projection engine merge path (conventions row).
- Credential-mode safety policy validated at config-resolution time (conventions row).
- Stack: TypeScript 7.0.x compiler + @typescript/typescript6 alias for lint tooling; Node >=24 LTS; pnpm 11 (supply-chain defaults ON); Standard Schema v1 contract-facing (Zod 4 impl/tests only); Vitest 4; ESLint 10; @changesets/cli ^3 joint-major releases.
- Deployment envelope: local-first SDK + globally installable CLI, npm distribution; CI runs contract suites Node 24 (+26 canary).

### UX Design Requirements

None — v1 is SDK/headless by decision (documented in PRD §0 and brief). CLI interaction behaviors are captured as FR-24..FR-28.

### FR Coverage Map

FR-1: Epic 1 - plugin manifest & eager validation
FR-2: Epic 1 - reversible registration lifecycle
FR-3: Epic 1 - atomic validate-and-commit swaps
FR-4: Epic 1 - scoped event bus
FR-5: Epic 1 - layered config resolution
FR-6: Epic 1 - normalized ExecutorAdapter contract + typed result envelope
FR-7: Epic 2 - Codex + OpenCode adapters complete the shipped set
FR-8: Epic 2 - declarative executor trait table
FR-9: Epic 1 - contract-test suite infra; Epic 2 - completed for all three adapters
FR-10: Epic 2 - liveness detection hierarchy
FR-11: Epic 2 - scoped registry entries
FR-12: Epic 2 - idempotent ownership-marked projection
FR-13: Epic 2 - per-target strategy isolation
FR-13b: Epic 2 - ToolProvider contract
FR-13c: Epic 2 - SkillSource contract
FR-14: Epic 2 - drift detection (doctor)
FR-15: Epic 3 - MemoryProvider contract (append-only provenance)
FR-16: Epic 3 - filesystem + SQLite providers
FR-17: Epic 1 - WorkspaceProvider contract + local-dir implementation
FR-18: Epic 4 - managed git worktrees
FR-19: Epic 4 - concurrent isolated sessions
FR-20: Epic 4 - safe disposal (trash-rename + sweep)
FR-21: Epic 5 - export Bundle
FR-22: Epic 5 - import and re-project
FR-23: Epic 5 - published MethodPlugin contract
FR-24: Epic 2 - project lifecycle commands (init / project init)
FR-25: Epic 5 - portability commands
FR-26: Epic 5 - doctor diagnostics
FR-27: Epic 5 - environment status
FR-28: Epic 5 - method hot-swap

## Epic List

### Epic 1: Run coding tasks through panda
Developers execute headless coding tasks via Claude Code from any Node script, with typed result envelopes, cancellation, and a working monorepo bootstrap.
**FRs covered:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-9 (infra), FR-17 (local-dir impl)

### Epic 2: One setup, every agent
The canonical Registry projects shared tools/skills/MCPs into Claude Code, Codex, and OpenCode native configs; `panda init`/`project init` bind projects; `doctor` detects drift. Completes S3, enables S1.
**FRs covered:** FR-7, FR-8, FR-9 (complete), FR-10, FR-11, FR-12, FR-13, FR-13b, FR-13c, FR-14, FR-24

### Epic 3: Memory that follows the consumer
Persistent memory as a swappable Contract: identical consumer code runs on filesystem and SQLite providers. Completes S2.
**FRs covered:** FR-15, FR-16

### Epic 4: Parallel work in isolated workspaces
Concurrent executor sessions on managed git worktrees with durable ownership metadata, permanent name retirement, and crash-safe disposal.
**FRs covered:** FR-18, FR-19, FR-20

### Epic 5: Own your environment — portability and methods
Export/import Bundles across devices with secret-safe defaults; full diagnostics; quota-aware status; methodology hot-swap. Completes S4 and the v1 thesis.
**FRs covered:** FR-21, FR-22, FR-23, FR-25, FR-26, FR-27, FR-28

## Epic 1: Run coding tasks through panda

Developers execute headless coding tasks via Claude Code from any Node script, with typed result envelopes, cancellation, and a working monorepo bootstrap. Realizes UJ-1 groundwork; enables every later epic.

### Story 1.1: Plugin manifest foundation

As a plugin developer,
I want my plugin to declare provided/consumed services and config schema in a manifest validated eagerly,
So that integration failures surface at load time, not mid-run.

**Acceptance Criteria:**

**Given** a plugin manifest declaring one provided service and one hard-consumed service
**When** the kernel loads it with the consumed service available
**Then** the plugin reaches ready state
**And** a manifest missing required fields fails load with a named error before any I/O
**And** a dependency cycle between two plugins is rejected naming both sides (FR-1)

### Story 1.2: Injection, disposal, and atomic swaps

As a plugin developer,
I want reliable dependency injection with clean teardown and safe replacement,
So that services never observe half-initialized or half-destroyed state.

**Acceptance Criteria:**

**Given** three plugins with chained dependencies
**When** the kernel stops
**Then** disposers run in exact reverse start order (ordering log verified)
**And** double-dispose is a no-op and post-dispose calls raise the typed inactive error
**And** an invalid plugin swap leaves the previous implementation serving and returns a typed swap error naming the validation failure (FR-2, FR-3, AD-5)

### Story 1.3: Scoped event bus and layered configuration

As a plugin developer,
I want scope-filtered events and layered configuration with inspectable composition,
So that concurrent sessions stay isolated and overrides are traceable.

**Acceptance Criteria:**

**Given** two concurrent agent sessions emitting interleaved events
**When** each session holds an agent-scoped listener
**Then** each listener observes exactly its own subset
**And** the config dump prints composed values with originating layer per key
**And** an agent-scope override never mutates global/project files (FR-4, FR-5, AD-8, AD-9)

### Story 1.4: ExecutorAdapter port with contract-test harness

As a platform developer,
I want the ExecutorAdapter port, typed result envelope, and a runnable contract-test suite,
So that any adapter implementation can be validated against the same clauses.

**Acceptance Criteria:**

**Given** the ExecutorAdapter port defined in @panda/contracts with Standard Schema interfaces
**When** a stub adapter implements it partially
**Then** the contract suite fails naming each violated clause
**And** the workspace-local provider passes the workspace contract clauses (create/acquire/release/dispose, persistent state across sessions)
**And** @panda/kernel remains zero-dependency and imports neither contracts nor implementations (FR-6 partial, FR-9 infra, FR-17, AD-1, AD-2)

### Story 1.5: First execution — Claude Code driven headlessly

As a developer using panda,
I want to run a coding task through Claude Code from a script and get a typed result,
So that panda proves its first real executor end-to-end.

**Acceptance Criteria:**

**Given** Claude Code installed and authenticated
**When** I run a task through the adapter in a local workspace
**Then** I receive a result envelope {status, data, summary, changedPaths?} conforming to the schema
**And** cancelling mid-run terminates the process tree and yields a typed cancelled result
**And** spawn overhead stays ≤150ms above raw CLI startup (NFR-9)
**And** a minimal `panda run` command exposes this flow (FR-6, NFR-9)

## Epic 2: One setup, every agent

The canonical Registry projects shared tools/skills/MCPs into Claude Code, Codex, and OpenCode native configs; `panda init`/`project init` bind projects; `doctor` detects drift. Completes S3, enables S1.

### Story 2.1: Registry core with machine-scoped serialization

As a developer using panda,
I want a canonical Registry storing tools/skills/MCP servers/profiles at global|project|agent scopes,
So that there is exactly one source of truth for my environment.

**Acceptance Criteria:**

**Given** entry envelope schemas owned by @panda/contracts
**When** any entry is registered
**Then** the Registry service validates against the canonical envelope and rejects invalid payloads with coded errors
**And** provider-specific payloads are accepted only under the reserved `extensions` namespace
**And** two concurrent panda processes writing the Registry produce a typed contention error naming the holder, never lost updates (FR-11, AD-4, AD-7)

### Story 2.2: Projection engine with sentinel grammar — Claude target

As a developer using panda,
I want the Registry projected into Claude Code's native config without touching foreign content,
So that sharing tools requires zero manual config editing.

**Acceptance Criteria:**

**Given** a native Claude settings file containing non-panda content
**When** projection runs twice
**Then** outputs are byte-identical and foreign content is preserved byte-for-byte
**And** panda-owned sections carry versioned namespaced sentinels from @panda/contracts
**And** a malformed native file fails only the Claude target with a per-target error (FR-12, FR-13, AD-9)

### Story 2.3: Codex and OpenCode targets via trait data

As a developer using panda,
I want projections targeting codex config.toml and opencode.json,
So that all three of my CLIs see the same tools.

**Acceptance Criteria:**

**Given** the trait table modeling format differences as data
**When** new targets are added
**Then** no existing target code changes (strategy isolation verified)
**And** both targets satisfy the same idempotence and foreign-content-preservation clauses as Story 2.2 (FR-8, FR-12, FR-13)

### Story 2.4: ToolProvider and SkillSource ports

As a plugin developer,
I want standard ports for supplying tools and skills into the Registry,
So that third parties extend panda's tool catalog without touching the engine.

**Acceptance Criteria:**

**Given** a ToolProvider registering a schema-invalid tool definition
**When** registration is attempted
**Then** it is rejected with a coded error and nothing is projected
**And** a modified source skill re-projects while unchanged sources remain byte-identical
**And** an empty-but-valid SkillSource yields a typed warning, not silent success (FR-13b, FR-13c)

### Story 2.5: Shipped adapters complete the set

As a developer using panda,
I want Codex and OpenCode adapters passing the same contract suite as Claude,
So that swapping executors is a supported operation, not a hack.

**Acceptance Criteria:**

**Given** the contract-test suite from Story 1.4
**When** all three adapters run through it in CI
**Then** all pass on Node 24
**And** per-executor differences live exclusively in the trait table, demonstrated by a test adding a trait-only stub executor without code changes (FR-7, FR-8, FR-9, FR-10)

### Story 2.6: Liveness detection hierarchy

As a developer using panda,
I want reliable executor state events (started/working/idle/exited),
So that automation can react to agents without screen scraping.

**Acceptance Criteria:**

**Given** an executor supporting native-config hooks
**When** it runs
**Then** completion arrives via injected hooks (written only through the projection merge path) without output polling
**And** with hooks unavailable, PTY/OSC fallback emits the identical event names
**And** screen scraping appears nowhere in either path (FR-10)

### Story 2.7: Project binding, projection commands, and drift doctor

As a developer using panda,
I want `panda init`, `panda project init`, and `panda doctor`,
So that setting up a project is one command and drift is detected automatically.

**Acceptance Criteria:**

**Given** a fresh project with three detected executors
**When** `panda project init` runs
**Then** all three native configs contain the projected tools (S3 scenario passes)
**And** hand-editing a panda-owned section is reported by `panda doctor` as Drift with diverging keys and suspected cause
**And** re-projection converges state and a second doctor run reports clean
**And** running with no detected executors exits non-zero listing misses (FR-14, FR-24)

## Epic 3: Memory that follows the consumer

Persistent memory as a swappable Contract: identical consumer code runs on filesystem and SQLite providers. Completes S2.

### Story 3.1: MemoryProvider port with append-only provenance

As a developer using panda,
I want a memory Contract where writes are append-only with mandatory provenance,
So that agent context survives sessions without corruption risk.

**Acceptance Criteria:**

**Given** the MemoryProvider port in @panda/contracts
**When** entries are written from two different workspace ids
**Then** provenance (writer id, workspace id, timestamp) is preserved and queryable
**And** overwrite-style operations raise a typed unsupported error
**And** supersession is represented by temporal marking, never deletion (FR-15, RD-1)

### Story 3.2: Filesystem and SQLite providers prove the swap

As a developer using panda,
I want two interchangeable memory providers passing one consumer suite,
So that choosing a storage backend is configuration, not code.

**Acceptance Criteria:**

**Given** one consumer test-sequence
**When** run against both providers
**Then** results are equivalent modulo explicitly-marked ordering nondeterminism (S2 scenario passes)
**And** neither provider requires consumer code changes beyond configuration (FR-16)

## Epic 4: Parallel work in isolated workspaces

Concurrent executor sessions on managed git worktrees with durable ownership metadata, permanent name retirement, and crash-safe disposal.

### Story 4.1: Managed git worktrees with durable ownership

As a developer using panda,
I want worktrees created with on-disk ownership records and retired names,
So that panda-managed worktrees are provably distinguishable forever.

**Acceptance Criteria:**

**Given** the git-worktree WorkspaceProvider
**When** two worktrees are created sequentially
**Then** names and paths never collide and used names are never reissued
**And** the on-disk ownership record and Registry mirror commit in one serialized transaction
**And** a directory lacking the record classifies external and is never auto-modified (FR-18, AD-6)

### Story 4.2: Concurrent sessions across worktrees

As a developer using panda,
I want two executor sessions running simultaneously on separate worktrees,
So that parallel work is first-class infrastructure.

**Acceptance Criteria:**

**Given** two tasks dispatched concurrently to distinct worktrees
**When** both complete
**Then** no panda-state contention errors occur and Registry writes remain consistent
**And** mixed CLI+SDK processes contending on the Registry surface the typed contention error (FR-19, NFR-7)

### Story 4.3: Crash-safe disposal

As a developer using panda,
I want worktree disposal that cannot corrupt state even when interrupted,
So that failures during cleanup are recoverable, not destructive.

**Acceptance Criteria:**

**Given** a disposal killed mid-operation
**When** the next startup sweep runs
**Then** the trash-pattern leftover is reconciled and removed
**And** merged branches may be deleted while unmerged branches are preserved (FR-20)

## Epic 5: Own your environment — portability and methods

Export/import Bundles across devices with secret-safe defaults; full diagnostics; quota-aware status; methodology hot-swap. Completes S4 and the v1 thesis.

### Story 5.1: Export Bundle with secrets excluded

As a developer moving devices,
I want `panda export` producing a portable Bundle without secrets,
So that my environment travels safely.

**Acceptance Criteria:**

**Given** a populated Registry including secret-bearing entries
**When** export runs
**Then** the artifact contains no secret-detector matches (CI-scanned)
**And** machine-specific paths are normalized at write time
**And** exporting twice unchanged yields byte-identical Bundles (FR-21, NFR-5, NFR-6)

### Story 5.2: Import and re-project elsewhere

As a developer on a new device,
I want `panda import` restoring my environment and re-projecting,
So that setup takes minutes, not days.

**Acceptance Criteria:**

**Given** a Bundle exported on machine A
**When** import + project-init run on a clean machine B
**Then** doctor reports zero drift except pending-secret entries listed explicitly
**And** importing a newer-schema-major Bundle exits non-zero naming the incompatibility
**And** empty-Registry export succeeds with an explicitly-empty Bundle (FR-22, FR-25; S4 passes)

### Story 5.3: MethodPlugin contract published

As a methodology author,
I want a published, versioned MethodPlugin contract with a validation kit,
So that I can package a development method without touching panda internals.

**Acceptance Criteria:**

**Given** only the published kit and docs
**When** a minimal sample MethodPlugin is written
**Then** it passes validation
**And** the manifest covers identity, phases, artifacts, commands, and the activate/deactivate hook pair (FR-23, RD-3)

### Story 5.4: Methodology hot-swap

As a developer using panda,
I want `panda swap method <id> [--for <id>]`,
So that I change methodology without losing project context.

**Acceptance Criteria:**

**Given** two installed methods
**When** swap executes
**Then** outgoing onDeactivate runs fully before incoming onActivate (ordered, verified)
**And** the selection persists across processes
**And** an invalid id exits non-zero listing available methods (FR-28, RD-3)

### Story 5.5: Full diagnostics

As a developer debugging panda,
I want `panda doctor` covering drift, adapters, executors, and pending secrets,
So that every problem tells me how to fix it.

**Acceptance Criteria:**

**Given** an environment with one drifted target, one missing adapter, and one pending secret
**When** doctor runs
**Then** all three are reported with suggested remediation commands
**And** direct plugin writes to panda-owned files are detected and reported (FR-26, AD-4)

### Story 5.6: Environment status with read-only quota surfacing

As a developer juggling subscriptions,
I want `panda status` showing active executors, workspaces, providers, and quota state,
So that I know my environment at a glance.

**Acceptance Criteria:**

**Given** an executor exposing an official usage surface
**When** status runs
**Then** quota data comes from official surfaces with async probes cached ≥60s
**And** probes never block spawns and unsupported executors show no quota row rather than erroring (FR-27, RD-4)

---

## Epic 2 addendum — corrected projection stories (2026-08-25)

> Added by `architecture/architecture-panda-2026-08-24/correction-01-native-projection.md`.
> Stories 2.2 and 2.3 shipped correct machinery that wrote a vocabulary no executor
> reads — verified empirically against Claude Code, Codex CLI 0.149.1 and OpenCode.
> They are marked `superseded`; the machinery is retained, the rendering and the
> delivery location are replaced here.
>
> **Every acceptance criterion below is phrased in the EXTERNAL tool's terms and is
> verifiable against that tool's published schema or its own source.** That is the
> discipline whose absence let 2.2–2.5 pass while delivering nothing.

### Story 2.8: Native config projection with a durable ownership ledger

As a developer using panda,
I want my registry's MCP servers to arrive in each executor's own configuration vocabulary,
So that the executors actually load them instead of ignoring a namespace panda invented.

**Acceptance Criteria:**

**Given** a Registry holding an MCP server entry
**When** projection runs for Claude Code
**Then** the entry appears as `mcpServers.<id> = {type:"stdio", command, args, env}` in the file Claude Code reads for MCP servers — NOT in `settings.json`, which has no such key
**And** for Codex the entry appears as `[mcp_servers.<id>]` in `config.toml` — snake_case, the key `ConfigToml` actually declares
**And** for OpenCode the entry appears as `mcp.<id> = {type:"local", command:[…]}` matching `ConfigV1.Info`, whose `command` is argv and which has no `args` field
**And** `codex --strict-config` loads the resulting `config.toml` without error — panda writes no field the vendor does not define, in any vendor-owned structure
**And** foreign content is preserved byte-for-byte and projecting twice is byte-identical
**And** panda's ownership of each written entry is recorded in a durable panda-side ledger (AD-6), never inferred from the file and never marked by a key inside a vendor structure
**And** a user edit to a panda-written entry is reported as Drift naming the entry, and is never silently overwritten (FR-12, FR-13, AD-4, AD-6, AD-9)

### Story 2.9: Filesystem materialisation targets

As a developer using panda,
I want my registry's skills to land where the executors discover skills,
So that a skill registered once is available in every agent that supports skills.

**Acceptance Criteria:**

**Given** a Registry holding a skill entry
**When** projection runs
**Then** the skill is materialised as the directory tree each executor discovers — `~/.claude/skills/<id>/SKILL.md` for Claude Code, `~/.codex/skills/<id>/SKILL.md` for Codex, and a directory plus its `skills.paths[]` entry for OpenCode
**And** the ProjectionTarget port expresses this as a materialisation kind alongside config merging, with the same guarantees: atomic writes, idempotence, foreign files in the skills root untouched, per-target failure isolation
**And** removal of a skill from the Registry removes exactly what panda's ledger says panda wrote, and nothing else
**And** a skill directory a user created by hand is never touched, because it is not in the ledger (FR-12, FR-13, AD-4, AD-6)

### Story 2.10: Unprojectable entries are reported, never faked

As a developer using panda,
I want to be told when a tool cannot exist in an executor,
So that I find out from panda instead of from an agent that silently lacks it.

**Acceptance Criteria:**

**Given** a Registry entry whose concept a target has no native representation for — a shell-command Tool, which none of the three executors can express (Claude has no such settings concept, OpenCode's `tools` is a boolean map, Codex's `[tools]` is a fixed struct)
**When** projection runs
**Then** the target reports the entry as unprojectable, naming the entry and the reason, and writes nothing for it
**And** the report is a product-visible fact surfaced by `panda doctor`, not an internal detail
**And** no best-effort approximation is written into any namespace (FR-13, correction-01 C5)

---

## Epic 1 addendum — the two kernel seams (2026-08-25, ROADMAP-01 M1)

> Both are mandated by the architecture and have no story anywhere. Measured: the
> kernel has ZERO production callers today, which makes this the cheapest moment
> these seams will ever cost — after composition they are a breaking kernel API
> change, and NFR-8's joint-semver rule turns that into a major bump of all seven
> contracts.

### Story 1.6: Kernel-owned observability log

As a developer building on panda,
I want every model-visible interaction reconstructable from one append-only log,
So that I can audit what an agent actually did instead of trusting a summary.

**Acceptance Criteria:**

**Given** a kernel starting with any set of plugins
**When** the first plugin loads
**Then** the observability log is already initialised — no plugin can register before it exists
**And** every model-visible interaction is reconstructable from the log alone
**And** a log write that cannot land degrades to a typed degraded mode, never silent loss
**And** the log is append-only and secrets never enter it (NFR-4, AD-4)

### Story 1.7: Tool-call interception waterfall

As a developer building on panda,
I want budgets and limits enforced at a seam every executor action passes through,
So that a budget is a property of the system rather than a sentence in a prompt.

**Acceptance Criteria:**

**Given** the kernel's interception pipeline
**When** any executor-action invocation runs
**Then** it flows through `pre → guard → around → post`, with no path around the seam
**And** token budgets, loop caps and fan-out limits are enforced there as declarative policy, never by prompt instruction
**And** a policy violation raises a coded error from the AD-7 hierarchy
**And** a test proves an invocation cannot reach an executor without traversing the pipeline (NFR-2, AD-10)

## Epic 2 addendum — Story 2.7 split (2026-08-25, ROADMAP-01 M2)

> `deferred-work.md` names Story 2.7 as the resolution home for four separate
> deferred items. As a single four-criterion story it cannot absorb that load.

### Story 2.7a: `panda init` and `panda project init`

As a developer using panda,
I want one command to bind a project and push my registry into every detected executor,
So that setting up a machine or a repo is one command instead of a manual afternoon.

**Acceptance Criteria:**

**Given** a fresh project with detected executors
**When** `panda project init` runs
**Then** each detected executor's own configuration contains the projected entries, in that executor's vocabulary, at the location it reads
**And** the command composes through the KERNEL — plugins mount and services resolve — rather than constructing adapters and providers directly
**And** running with no detected executors exits non-zero listing what was looked for and not found
**And** projection, the Registry and the provider ports each gain their first production caller (FR-14, FR-24)

### Story 2.7b: `panda doctor`

As a developer using panda,
I want drift and unprojectable entries reported by one command,
So that I find out from panda rather than from an agent that silently lacks a tool.

**Acceptance Criteria:**

**Given** a hand-edited panda-owned entry
**When** `panda doctor` runs
**Then** it is reported as Drift naming the entry, the location and the suspected cause, and nothing is rewritten
**And** an entry no target can express natively is reported as unprojectable, naming the entry and the reason (correction-01 C5)
**And** re-projection converges state and a second doctor run reports clean
**And** the report distinguishes edited from removed-by-user from foreign-collision, as the ledger already does

### Story 2.7c: Executor selection for `panda run`

As a developer using panda,
I want to choose which executor runs my prompt,
So that "swap the agent, keep the workflow" is reachable from the binary and not only from a script.

**Acceptance Criteria:**

**Given** the three shipped adapters
**When** `panda run` is invoked selecting one of them
**Then** that executor runs the prompt and the result envelope is identical in shape across all three
**And** an unknown executor name exits non-zero listing the available ones
**And** the selection has a configured default resolved through the layered config, not a hardcoded constructor (FR-7, FR-9)

---

## Epic 2 addendum — M2 heads with an SDK surface (2026-08-25, ROADMAP-01 Correction A)

> The capability lives in a package; the CLI is a thin binding. Measured drift:
> `runPanda` mixes argv parsing, exit codes and stdout formatting with the only
> composition panda has, and no SDK-level equivalent exists anywhere. The
> knowledge graph shows why it went unnoticed — F8's whole neighbourhood is
> FR-24..FR-28, all CLI, and the SDK promise has no requirement node at all.

### Story 2.0: Session composition through the kernel

As a developer building on panda,
I want to run a prompt in an isolated workspace by importing packages,
So that the kernel is genuinely usable from my own project and not only through panda's binary.

**Acceptance Criteria:**

**Given** a third-party Node project that has installed panda's packages but NOT `@panda/cli`
**When** it composes a session — workspace, executor, prompt, cancellation
**Then** it obtains the same result envelope `panda run` produces, with no code copied from the CLI
**And** `@panda/cli` contains only argv parsing, output formatting and exit-code mapping — a test fails if composition logic returns to it
**And** the executor invocation flows through the Story 1.7 interception pipeline, so the no-bypass guarantee stops being kernel-scoped and holds end to end
**And** `panda run` behaves identically: same envelope, same exit codes, same cancellation on interrupt, same workspace cleanup (FR-7, FR-17, NFR-2)
