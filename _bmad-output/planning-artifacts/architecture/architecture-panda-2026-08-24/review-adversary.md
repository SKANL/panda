# Adversarial Architecture Review — Panda v1 Spine

- **Target:** `ARCHITECTURE-SPINE.md` (draft, 2026-08-24)
- **Method:** one level below the spine — construct pairs of units (plugins, packages, kernel services) that each satisfy every adopted AD literally, yet cannot coexist in one system. Every genuine construction pair = a missing or insufficiently tight Architecture Decision.
- **Context read:** `prd-panda-2026-08-23/prd.md`

---

## Verdict

The spine is sound at its altitude (paradigm, topology, trust model are well-chosen and honestly bounded), but **at least eight seams are underspecified**: each admits two fully-AD-compliant implementations that build incompatibly. These are exactly the seams where first-party packages will quietly make private choices that third-party plugin authors then violate. Fixable with targeted clause tightening; no paradigm-level rework needed.

**Holes found: 8** (H1–H8 below). Each lists the compliant-but-incompatible pair and a one-sentence proposed AD.

---

## H1 — Registry entry envelope ownership is undefined (shared-data shape clash)

**ADs implicated:** AD-1, AD-4, AD-2 · **Also touches:** FR-13b, FR-13c

**Construction A:** `@panda/contracts` defines the canonical `ToolDefinition`/`SkillEntry` schema interfaces; the Registry *service* validates every incoming entry against those schemas at registration time. Providers submit data; the store enforces shape.

**Construction B:** Because AD-1 forbids the Kernel from importing `@panda/contracts`, the Registry is a *generic* container: validation is delegated to the providing plugin (via its manifest config schema). A third-party `ToolProvider` therefore registers entries whose payload is `{ kind: "tool", mcp: { url, headers } }` while a first-party one registers `{ kind: "tool", transport: { type: "stdio", command } }`. Both registrations succeed; neither violated any AD.

**Why they're incompatible:** The projection engine and `doctor` consume "Registry entries" generically. Built against A's assumption, they crash or silently drop B's entries; built against B, they cannot render A's. Contract-test suites (AD-7) assert codes per contract but there is no contract that says *who validates the shared stored shape*.

**Proposed AD:** The canonical envelope for every Registry entry kind (tool/skill/mcp-server/profile), its schema, and the validation point (contracts-owned schemas enforced by the Registry service, never by the contributing provider) are defined in `@panda/contracts`, with provider-specific payloads permitted only under a reserved `extensions` namespace.

---

## H2 — Dual authority over worktrees: durable metadata record vs Registry entry

**ADs implicated:** AD-4, AD-6 · **Also touches:** FR-17, FR-18

**Construction A:** `workspace-git` writes the on-disk ownership record (`.panda/worktree.json`) inside the worktree at creation, then registers in the Registry as a secondary mirror. External-vs-managed classification (FR-18 consequence) reads the disk file, because that is what survives when the Registry is elsewhere.

**Construction B:** Same package registers in the Registry first and treats the Registry entry as the record of truth; the disk file is a convenience marker refreshed lazily. Equally consistent with AD-6 ("durable metadata records written at creation — never inferred from paths") and AD-4 (serialized Registry writes).

**Why they're incompatible:** A crash between the two writes (creation and registration are two separate side effects; no AD makes them one transaction) leaves the two implementations classifying the *same directory* oppositely: A calls it managed, B calls it external and "never auto-modifies" it. Disposal sweeps, trash recovery (FR-20), and drift reporting all fork on this answer. AD-6 proves ownership but never ranks the two proofs.

**Proposed AD:** For entities materialized outside the Registry (workspaces/worktrees), the durable on-disk record is the creation-of-record, Registry mirroring occurs within the same serialized transaction as record creation, and a defined recovery sweep reconciles the two after a crash.

---

## H3 — The observability log has no owner

**ADs implicated:** AD-4, AD-5 · **Also touches:** PRD §10 Observability

**Construction A:** The Kernel ships a generic, contract-agnostic `LogService` (legal: it knows nothing about any Contract) started before all plugins; plugins receive it via DI and append.

**Construction B:** Observability is itself a plugin (or the CLI wires a file sink post-startup) — arguably cleaner under the microkernel paradigm ("everything else mounts as plugins"). But AD-5 guarantees a failing plugin is *contained* while others keep running, and plugins start in dependency order: interactions occurring before the log plugin starts, or during its lifetime, are model-visible yet permanently unlogged.

**Why they're incompatible:** "Every model-visible interaction must be reconstructable from it" (AD-4) is satisfiable by A and unsatisfiable-by-construction in B, yet B obeys every stated AD — the invariant binds an artifact without binding its owner, start order, or failure policy.

**Proposed AD:** The append-only observability log is a kernel-owned core service initialized before any plugin loads, and its write-failure policy (halt vs. typed degraded mode) is fixed in the AD so reconstruction never depends on optional plugin availability.

---

## H4 — Side-channel mutation of panda-owned state files by trusted plugins

**ADs implicated:** AD-3, AD-4, AD-9 · **Also touches:** FR-28

**Construction A:** `panda swap method` persists the active-method selection through the owning component's serialized API (a Registry/Profile write), so drift detection, undo, and re-projection see one coherent history.

**Construction B:** A `MethodPlugin`'s `onActivate` hook writes the agent-layer panda config file directly with `fs.writeFile` — it is trusted in-process code (AD-3 documents that installing a plugin *is* executing it), AD-4 reserves *vendor configs* exclusively for ProjectionTargets but says nothing about *panda's own* config/state files, and AD-9 only forbids narrower scopes mutating wider-scope files. Perfectly legal.

**Why they're incompatible:** Under B, the next `doctor` run reports the plugin's own write as external-edit Drift; swap persistence (FR-28) races the Registry's view of the same key; and no audit trail connects the mutation to the plugin. AD-4's "two writers" prevention was scoped to vendor configs and misses the panda-owned surface entirely.

**Proposed AD:** All persistent mutations of panda-owned state — Registry entries, layered-config panda-owned keys, and projections — flow exclusively through their owning component's serialized API, and direct filesystem writes to panda-owned files by any plugin are prohibited and detected.

---

## H5 — Runtime service-graph direction unconstrained (projection reading memory)

**ADs implicated:** AD-2 (as written), AD-4 · **Also touches:** F3/F4 boundary

**Construction A:** The projection plugin consumes only the Registry read-port and resolved config; outputs are a pure function of canonical state, so FR-12 idempotence holds globally.

**Construction B:** The projection plugin *soft*-consumes `MemoryProvider` (AD-5 explicitly supports soft reads) and injects memory-derived context keys into each Executor's projection — e.g., stamping recent-workspace summaries into agent settings. Package topology is untouched: `projection` imports only `@panda/contracts` (AD-2 governs package imports, not the runtime service graph). Vendor config is still written via a ProjectionTarget merge (AD-4 honored letter-for-letter).

**Why they're incompatible:** Projections are no longer a function of Registry state alone: re-projection after a memory append produces different bytes, breaking the byte-idempotence guarantee FR-12 tests encode, and Bundle export/import (F6) cannot reproduce projections on a machine whose memory differs. AD-2's strictly-downward *imports* do not stop this; only a runtime consumption rule would.

**Proposed AD:** Runtime service consumption must mirror the role topology — derived-state generators (projection, bundles) may consume only canonical-state inputs (Registry, resolved config), and memory is reachable solely through explicit consumer-facing surfaces, never as an implicit input to derived artifacts.

---

## H6 — Event-ordering ambiguity between AD-8 synchronous fan-out and AD-3 async handlers

**ADs implicated:** AD-8, AD-3 · **Also touches:** FR-2 teardown, FR-19

**Construction A:** "Dispatch is synchronous" is implemented as *synchronous invocation, fire-and-forget*: the kernel emits `executor.exited`, listener 1 starts an async Registry cleanup (unawaited), and the CLI immediately proceeds to emit `workspace.released` and re-project — reading a Registry whose cleanup hasn't landed.

**Construction B:** Same sentence implemented as *ordered await*: lifecycle events join all handler promises before the initiating transition completes, so re-projection observes settled state. Both readings fit AD-8's exact words; the AD never states whether async handler completion is joined, nor whether handlers may emit events during fan-out ("no cross-event reentrancy guarantee" describes the absence of a promise, not a prohibition).

**Why they're incompatible:** Downstream units (CLI commands, disposal flows, shutdown sequencing) must *choose* an assumption; an adapter written for B corrupts under A (mutations racing dispose → typed inactive errors from FR-2 surfacing as user-visible failures). Shutdown amplifies it: kernel disposes plugins while their handlers are still pending.

**Proposed AD:** Lifecycle-transition events (dispose/release/shutdown/swap) join all handler continuations before the transition completes, handlers are prohibited from emitting events synchronously during fan-out, and shutdown drains pending handler mutations before unwinding registrations.

---

## H7 — Sentinel vocabulary has no owner and no namespace (config-layer × package-boundary hole)

**ADs implicated:** AD-9, AD-2, AD-4 · **Also touches:** FR-12, FR-14, PRD §9 assumption on sentinel survival

**Construction A:** One versioned sentinel grammar lives in `@panda/contracts` (e.g., `PANDA:<v>:BEGIN … PANDA:<v>:END`), with each ProjectionTarget supplying only a format encoding (JSONC vs TOML comment syntax); drift detection compares against known versions.

**Construction B:** Each ProjectionTarget invents its own marker syntax appropriate to its format — the natural reading of FR-13's "format-specific merge logic isolated behind the target interface." Two third-party targets independently choose colliding marker strings; a native config carries sentinels written by an older panda major that nobody current recognizes. Meanwhile AD-4 speaks of "ownership markers/sentinels" for *vendor configs* and AD-9 of "ownership sentinels" for *layered config keys* — two distinct vocabularies, and no AD assigns an owner to either.

**Why they're incompatible:** Doctor (FR-14) must classify every section of every native config as panda-owned or foreign; under B it cannot — unrecognized sentinels are indistinguishable from vendor content, so foreign content gets overwritten (violating byte-for-byte preservation *by accident*) or panda content is reported as permanent Drift. AD-2 makes this worse: a third-party target installs with only `@panda/contracts`, so its private vocabulary is invisible to everything else by design.

**Proposed AD:** `@panda/contracts` owns a single versioned, namespaced sentinel grammar whose per-format encodings are the only thing ProjectionTargets may implement, sentinels from unknown/legacy versions classify as Drift requiring explicit migration, and the layered-config and vendor-config sentinel systems are explicitly distinguished in the AD text.

---

## H8 — Registry write serialization is unscoped (in-process mutex vs machine-wide lock)

**ADs implicated:** AD-4 · **Also touches:** FR-19, PRD §10 Reliability

**Construction A:** Serialization is an in-process mutex around an atomic temp-file+rename store write — trivially correct for one kernel instance, zero dependencies.

**Construction B:** Serialization is an OS advisory file lock keyed to the store path, because the deployment envelope explicitly includes both a globally installable CLI and an embeddable SDK: two `panda` processes (or a CLI plus a user's SDK script) legitimately run concurrently against the same global Registry.

**Why they're incompatible:** In mixed operation, A loses updates silently (last-rename-wins) while each implementation individually satisfies every stated AD — "its writes are serialized" never says serialized *among what*. FR-19's test (two sessions, one process) cannot catch this; only concurrent-process testing can.

**Proposed AD:** Registry write serialization is machine-scoped — an advisory lock keyed to the physical store path binding every writer, including concurrent CLI invocations and embedded SDK kernels — with a typed contention error naming the holder.

---

## Summary Table

| # | Hole | Missing/tightened constraint | Suggested vehicle |
|---|------|------------------------------|-------------------|
| H1 | Registry envelope shape/validation owner | Contracts own entry envelopes + validation point | New clause under AD-4 |
| H2 | Worktree disk record vs Registry dual authority | Rank proofs; single transaction; recovery sweep | Tighten AD-6 |
| H3 | Observability log owner/start/failure policy | Kernel-owned, first-started, fixed failure policy | New clause under AD-4 |
| H4 | Plugins writing panda-owned files directly | All panda-state mutations through owning API | Tighten AD-4 |
| H5 | Runtime service graph ignores package topology | Derived-state gens consume canonical inputs only | Extend AD-2 |
| H6 | Async handler joins / reentrancy / shutdown drain | Join-on-transition, no sync re-emit, drain on shutdown | Tighten AD-8 |
| H7 | Sentinel grammar owner/version/namespace | Contracts own one versioned grammar | Tighten AD-9 (+AD-4 wording split) |
| H8 | Serialization scope: process vs machine | Machine-scoped advisory lock, typed contention error | Tighten AD-4 |

## Recommendation

None of these require re-opening an adopted decision — each is a one-to-two-sentence tightening or addition at the seam the pair exposes. Highest priority before epics/stories: **H1, H7, H4** (they gate contract-test-suite authorship and the projection engine's very shape); **H6** second (every downstream unit bakes in an ordering assumption).
