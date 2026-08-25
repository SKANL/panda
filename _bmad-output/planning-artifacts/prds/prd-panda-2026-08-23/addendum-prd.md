---
title: "PRD Addendum: Panda — Resolved Decision Evidence"
status: final
created: 2026-08-23
updated: 2026-08-23
---

# PRD Addendum — Evidence for Resolved Decisions

Companion to `prd.md` §8. Each resolved decision's full evidence trail. Web sources accessed 2026-08-23.

## RD-1 Evidence — Memory consistency is write-time concurrency control

- **TOKI** (arXiv:2606.06240): contradiction resolution in LLM-agent persistent memory typed as bitemporal operators; production heuristics (last-writer-wins, evidence-weighted merge, await-confirmation, per-rule policy) each carry isolation preconditions and admitted anomalies (lost update, write skew); provenance/audit rows are the baseline defense — "adversarial writes corrupt later retrievals once the store keeps no defensible record of what it overwrote." Audit of 8 systems (mem0 v2/v3, Graphiti, Letta, Zep, MIRIX, WorldDB): every baseline admits at least one of three anomalies (replay inconsistency, belief-drift skew, audit erasure).
- **Multi-agent memory architecture position paper** (arXiv:2603.10062): names multi-agent memory consistency "the most pressing open challenge"; shared-memory agents overwrite each other / read stale facts without coordination protocols; demands explicit versioning, visibility, and conflict-resolution rules.
- **Governed Shared Memory / MemClaw** (arXiv:2606.24535): fleet memory = governed distributed-systems problem; four failure modes (unauthorized leakage, stale propagation, contradiction persistence, provenance collapse); primitives needed: scoped retrieval, temporal supersession, provenance tracking.
- **MemTX** (arXiv:2607.23929): "a write is not a commit" — staged belief lifecycle, snapshot-isolated commit pipeline, stale-late-write aborts.
- **Panda reasoning**: single-writer doctrine (Cognition 2026; research.md) means v1 needs zero concurrent semantic merge. Append-only + provenance is the cheapest contract that keeps every future option open (auditable synthesis later by a manager role). Deferring merge policy is not kicking a can — shipping one would be premature commitment to an unsolved problem.

## RD-2 Evidence — Ephemeral process over persistent workspace

- Industry convergence on hybrid runtime: durable filesystem state + disposable compute ("workspace state persists on disk, compute suspended when idle... resume in seconds") — ellul/persistent-vs-ephemeral-sandboxes (2026-05-01); "persistent sessions are the unit of agent work, not requests" — ryanmerlin.com (2026-05-05).
- Warm pools matter at *cloud fleet scale* only: warm-pool economics piece (tianpan.co, 2026-07-02) — pools solve cold-start for 10k-tasks/day fleets; value concentrates in dependency-tree snapshots keyed by environment fingerprint. Local-first panda has no such economics; its spawn budget (≤150ms adapter overhead) covers interactive cadence.
- Reference study convergence: all surveyed harnesses spawn ephemeral instances; runcell's caller-owned sandbox handle demonstrates reusable-workspace warmth without process pooling; Terax lazy-spawns PTYs on visibility.

## RD-3 Evidence — MethodPlugin surface

- Spec Kit extensions (`extension.yml` manifest + command templates + scripts; installed via CLI; surfaced as slash commands; 40+ community extensions) — hiddedesmet.com (2026-04-08). The lightest surface with demonstrated third-party ecosystem.
- BMAD v6 module/config persistence (`_cfg/` survival across updates): heavier, file-contract driven, no enforcement mechanism.
- dsh/Cordis: registration paired with named disposer effect IS the whole lifecycle story — activation/deactivation pairing is sufficient machinery for clean mount/unmount; hot-swap idiom = dispose owning effect, register replacement.
- Panda reasoning: FR-28 (`swap method`) requires ordered deactivate→activate between sessions; two hooks satisfy it minimally. More hooks = speculative engineering (repo principle).

## RD-4 Evidence — Quota surfaces

- Orca source study (digest-orca.md §4): Claude via OAuth usage endpoint with Keychain bearer + refresh, PTY `/status` fallback; Codex via read-only `codex app-server` JSON-RPC `{rateLimits}` with per-account CODEX_HOME cross-process lock; probes async off the switch path.
- Brief addendum constraint: vendor ToS gray zones around heavy programmatic use of interactive subscriptions — flag, don't assume. v1 stance: read-only visibility, no automation against limits, no account rotation.

## Source-level digests referenced

`references/digest-{gentle-ai,runcell,terax,orca,deepseek-harness}.md` in this folder — five repos cloned to `C:\code\panda\.scratch\references\`, codegraph-indexed, explored with file:line evidence.

---

## FR-29 — SDK surface parity (added 2026-08-25)

**Why this is being added.** §0 says panda is *"a headless TypeScript SDK and CLI"* and §2 says it *"ships as an SDK first: a headless kernel usable from any project"*. That promise had no requirement. F8's requirements — FR-24 through FR-28 — are all CLI surface, and the knowledge graph over these artifacts shows nothing else claiming the SDK. A promise with no requirement gets no story, no acceptance criterion, and therefore no defence against drift: the composition for `panda run` was written inside `@panda/cli`, where a third party could not reach it, and nothing in the plan was positioned to notice. This is the same structural gap as the six NFRs that reached implementation with no story.

**FR-29: SDK surface parity — every capability the `panda` binary exposes is reachable by importing packages, without installing `@panda/cli`. The CLI parses arguments, formats output and maps results to exit codes; it holds no capability of its own.**

**Testable behaviour.** For each CLI command, a consumer that has NOT installed `@panda/cli` can obtain the same result by importing the packages that own the capability, with no code copied from the CLI. Proven positively — a consumer test that imports only the owning package and asserts the observable result the CLI produces — rather than by scanning the CLI's sources for forbidden text, which a composition can be rewritten to evade.

**Scope note.** FR-29 constrains where capability lives, not what it is. It adds no capability of its own and is satisfied incrementally: each CLI command satisfies it as that command is built.
