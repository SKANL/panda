---
title: "Panda Brief Addendum"
status: draft
created: 2026-08-21
updated: 2026-08-21
---

# Panda Brief Addendum

Depth captured during the conversation that produced the brief; belongs to downstream documents (PRD, architecture). Not part of the executive brief.

## The Two Kinds of Swappability (architecture-critical)

Mixing these is the classic failure mode of this product category:

1. **In-process plugins** (Cordis-style): memory providers, orchestration policies, tool projection, UI panels — run inside panda's process, implement kernel contracts, are hot-swappable by design.
2. **Out-of-process adapters** (the CLIs): Claude Code, Codex, Kiro are external processes with their own worlds. They can never be "plugins" — they are adapted through an execution contract, and shared tools reach them via config projection onto their native formats.

Consequence for the kernel: contracts must make the boundary explicit from day one.

## Technical Constraints & Early Decisions

**Decisions (firm):**

- **Abstract workspace handle**: adapters receive a workspace abstraction, never a bare `cwd`. This is cheap now and expensive later — it reserves room for parallel worktrees, SSH worktrees (`WorkspaceProvider`, v-next), and sandboxing without refactors.
- **Portability caveats**: secrets (API keys, OAuth tokens) never travel in the export bundle by default — separate opt-in channel required. Machine-specific paths must be normalized in the canonical registry at write time.

**Risks (monitored):**

- **Projection drift**: each vendor changes its config format every few months. Without contract tests per adapter, projections break silently. Adapter maintenance cost is the project's real recurring liability.
- **Quota awareness**: subscriptions have hard limits (e.g., weekly Claude caps). Routing policy eventually needs quota/health awareness per subscription. Orca's account switcher + usage tracking is the reference UX. Some vendors' terms sit in gray zones around heavy programmatic use of interactive subscriptions — flag, don't assume.

**Design consequences:**

- **Context non-portability**: vendor session formats are private and incompatible. Panda externalizes all durable state to files/artifacts it owns; agents are treated as stateless workers receiving compressed handoffs — which is also the token-efficiency mechanism.

## Prior Art Notes

| Project | What it contributes | What it lacks (panda's opening) |
| --- | --- | --- |
| DeepSeek Harness (`dsh`) | Cordis kernel, everything-is-a-plugin at scale (MIT) | Not a layer above heterogeneous CLIs; single-harness worldview |
| Terax | Terminal-first ADE shell (Tauri/Rust, Apache-2.0); spawns Claude Code with approval-gated follow-ups | No swappable-executor abstraction, no canonical registry |
| gentle-ai stack | Partial shared MCPs/skills across CLIs; multi-model orchestration per CLI | Sharing is partial and manual; no ownership inversion |
| runcell | SDK-quality primitives (agent/sandbox/thread), typed results | Talks to providers directly; bypasses CLIs rather than unifying them |
| Orca | Parallel/SSH worktrees, usage tracking, fleet UX (MIT) | Orchestration-level only; configs remain per-vendor silos |
| agtx / sweteam / orch | CLI spawning, task routing, cross-agent review | Coordination without interchangeability; no unified config projection |
| Vibe Kanban (cline) | Executors-as-swappable-CLIs via `profiles.json` (model, env, auto_approve, append_prompt) | Roles are prompt-append emulation, not first-class definitions |
| The Engineer | `AgentAdapter` contract: audit trail, retries, cost tracking over any backing CLI plugin | Abstracts lifecycle phases, not role semantics |

## Research-Grounded Design Constraints (2026-08-23)

Derived from the technical research run at `_bmad-output/planning-artifacts/research/technical-workers-workflows-agent-orchestration-2026-08-23/research.md` (35 sources). These bind the PRD and architecture:

1. **Single-writer enforced default.** Multi-agent works when writes stay single-threaded and extra agents contribute intelligence only (clean-context reviewer, advisor, manager). Parallel writers are the documented failure mode; workflow primitives must make parallel intelligence native and parallel writes opt-in per node.
2. **Deterministic workflows by default.** Code edges burn zero tokens per handover; LLM-driven routing burns them on every decision. Judgment lives in specific nodes.
3. **State lives in the environment.** Files/git as canonical state (Anthropic long-running harness pattern); framework state objects are projections — mirrors panda's registry-as-source-of-truth philosophy.
4. **Durability contract = four converged primitives**: step journal, durable step results, durable timers/wait-for-event, replay determinism with idempotency. Implement over a TypeScript-native headless engine (bring-your-own-store style fits panda's ethos).
5. **Budget governance in hooks, not prompts.** Token budgets, loop caps, fan-out limits enforced at the kernel tool-call layer ("a budget rule in a prompt is a preference").
6. **Worker-class shape = converged taxonomy**: declarative file-based type (description-for-routing, tool allowlist, model tier, executor binding, workspace policy) + ephemeral instances per task in isolated worktrees. The portable worker-class card (A2A-style surface + harness frontmatter fields) is unclaimed ground — nothing to copy, design deliberately.
7. **MethodPlugin follows Spec Kit's extension shape** (manifest + commands + templates), not BMAD's config-persistence approach; add enforcement hooks OpenSpec lacks.
8. **Own the kernel, keep it thin, fail loudly on missing services.** Cordis critique checklist: single-maintainer risk, RC API churn, silently-PENDING plugins, vendored-fork pressure.

Staleness: harness version claims re-check from September 2026; see research.md staleness map for the Refresh work order.

## Naming Collision Note

A repo named `SiluPanda/sweteam` exists but is unrelated (an orchestrator itself). "panda" as a name showed no direct collision in the researched space at the time of writing; verify before public launch.
