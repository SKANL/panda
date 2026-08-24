---
title: "Product Brief: Panda"
status: complete
created: 2026-08-21
updated: 2026-08-23
---

# Product Brief: Panda

## Executive Summary

Developers running multiple AI coding-agent subscriptions — Claude Code, Codex, OpenCode, and the growing long tail — live inside silos. Each CLI owns its own configuration universe: global and per-project MCP servers, skills, plugins, and settings that don't interoperate. Sharing a tool between agents is manual and fragile. Switching one agent for another breaks the workflow. Moving an entire setup to a new device means re-doing everything by hand.

Panda is a control layer **above** those CLIs where everything is swappable: executors, models, tools, MCPs, skills, plugins — even memory and the development methodology itself. A plugin-kernel core owns one canonical registry of tools and configuration; each agent receives its tools as disposable *projections* onto its native config format. Because the canonical registry — not any vendor's config — is the source of truth, agents become interchangeable parts and setups become portable by design.

Panda ships as an SDK first: a headless TypeScript kernel usable in any project, with a terminal-first shell as a future consumer, not the product. It is open source for everyone and dogfooded daily by its author.

## The Problem

Three pains, inseparable in practice:

1. **Tool fragmentation.** MCPs, skills, plugins, and configs live scattered across per-vendor stores (global + per-project), with no shared registry. Cross-agent sharing is hand-synced drift waiting to happen.
2. **Agent lock-in.** Swapping claude→grok→kiro means rebuilding workflows, because every vendor's harness treats its own config as primary state. Workflows die with the agent.
3. **Device non-portability.** No existing tool (Orca, runcell, gentle-ai, DeepSeek Harness included) can carry a full setup to a new device, because there is nothing canonical to carry.

The cost of the status quo compounds: more subscriptions mean more silos; every new agent launch widens the gap; every device change resets it all.

## The Solution

A plugin-kernel layer above the CLIs:

- **Everything is a plugin** on a custom TypeScript kernel (inspired by the Cordis model behind DeepSeek Harness but built from scratch to own the contract).
- **One canonical registry** holds tools, skills, MCPs, plugins, and memory config with `global` / `project` / `agent` scopes.
- **Projection engine** compiles the registry into each agent's native config format; per-agent tooling stays possible alongside shared global tooling.
- **Swappable memory**: an engram-style persistent memory exists as just another provider contract.
- **Swappable methodology**: the development process itself (SDD/TDD/RDD, BMAD, spec-kit) is a plugin axis — users build with whichever method they choose.
- **Concurrent workspaces from day one**: agents run on isolated git worktrees via a workspace contract, so parallel work is native infrastructure, not a bolt-on.
- **Workers & Workflows** (v-next): agent classes (e.g. "backend") instantiated as workers over any swappable executor, orchestrated by deterministic workflows — grounded in 2026 production evidence (single-writer execution, intelligence-only side agents).
- **Portable by construction**: sync the registry, re-project on the new machine — setup restored.

## What Makes This Different

Existing projects solve slices: gentle-ai shares some MCPs/skills across CLIs; Orca orchestrates parallel agents in worktrees; runcell offers clean SDK primitives over raw providers; DeepSeek Harness proves the everything-is-a-plugin kernel at scale; agtx/sweteam/orch coordinate tasks across spawned CLIs. None make the underlying agents *interchangeable* while unifying their configuration as projections of one canonical store.

2026 technical research confirmed the sharpest opening: every major harness converged on the same worker taxonomy (declarative file-based types + ephemeral per-task instances), yet **no project defines portable role definitions decoupled from the backing CLI** — roles over swappable executors is unclaimed ground.

The honest moat: not technology alone — adapter contracts are copyable — but contract ownership plus dogfooding. The architecture is contract-driven; the roadmap is pain-driven; the author's daily multi-subscription workflow is the continuous integration test.

## Who This Serves

**Primary:** any developer who wants what the author has — a multi-agent setup where tools, memory, and agents are swappable and portable. The kernel is a platform: others build whatever they imagine on top of panda; the author's terminal is merely its first consumer.

**Segments, in order of fit:**

- **Teams standardizing AI tooling** — one shared registry of MCPs/skills/plugins projected to every member's agent of choice.
- **Harness builders** — using the kernel as a platform instead of rebuilding lifecycle, config resolution, and adapters.
- **Startups & indie hackers** — building products on the SDK without betting on any single vendor's harness.

## Success Criteria

**v1 exit threshold** (all required, near-term):

The thesis proven end-to-end with four scenarios:

- **S1 — Executor swap**: same task definition runs through Claude and Codex adapters with the same tool profile; typed results both times.
- **S2 — Memory swap**: identical consumer code runs on two different memory providers unchanged.
- **S3 — Projection**: one canonical global profile projects into native Claude/Codex/OpenCode configs in a fresh project.
- **S4 — Portability**: export on machine A, import on machine B, re-project — S1–S3 pass untouched.

Plus full dogfooding: the author's daily workflow runs entirely on panda — zero hand-edited CLI configs for 30 consecutive days.

**Long-term platform signals** (directional, measured not promised — these may take years or never fully land; they indicate platform health, they do not gate releases):

- The contracts are implementable by outsiders: at least one adapter or memory provider written by someone external using only contracts + docs, without reading kernel source. *The* validation that this is a real plugin platform.
- At least one product built on the kernel by someone else, for something other than panda itself.
- Community adoption as lagging indicators: third-party issues, first external contributors.

## Scope

**In v1** (SDK/headless): plugin kernel (lifecycle, event bus, config resolution with scopes) + seven swappable contracts: `ExecutorAdapter`, `MemoryProvider`, `ToolProvider`, `ProjectionTarget`, `SkillSource`, `WorkspaceProvider` (local + git-worktree implementations), and the `MethodPlugin` contract definition. Adapters receive an abstract workspace handle from day one (not a bare cwd). Official methodology plugins (SDD/TDD/RDD ports) land immediately after v1 on that contract.

**Explicitly out of v1**: terminal UI, Workers/Workflows orchestration layer (v-next — design informed by the 2026-08 research run), fleet routing policies, custom sandboxing, SSH worktrees, kanban anything.

## Vision

The agent ecosystem renews itself every quarter. New CLIs, new models, new harnesses — each demanding you move in: bring your tools, rebuild your context, arrange your work around them. All of them temporary.

Panda refuses the trade.

Your environment is the asset. Agents are interchangeable parts that plug into it. Your setup exists once. It is yours. It travels with you and outlives every vendor beneath it. Anything can wear it — your terminal today, someone else's product tomorrow.

Others build homes for agents. Panda builds the estate the agents visit.

**Rent the agents. Own the environment.**

If it succeeds, panda becomes the layer where worker classes outlive their executors: a "backend" worker backed by any harness, orchestrated by deterministic workflows over swappable memory, tools, and methodology — while the agent ecosystem keeps churning underneath without touching anyone's setup.
