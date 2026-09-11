---
title: 'technical research: current upstream deltas in Cordis and DeepSeek Harness'
type: 'technical'
topic: 'What changed upstream after the prior Cordis and DeepSeek Harness research passes'
decision: 'Which prior conclusions remain valid, require narrower wording, or are superseded by current upstream evidence'
source: 'Cordis f8ea3cd and DeepSeek Harness origin/master c291e796, compared with prior research notes'
status: complete
preset: 'standard'
created: '2026-09-11'
updated: '2026-09-11'
validation: measured
claims_verified: 18
claims_unverified: 4
extends: 'deepseek-harness-the-last-nine-groups-2026-09-04 and cordis-spatiotemporal-composability-2026-09-01'
---

# Current upstream delta

## Executive summary

The upstream refresh changes wording and scope, not the central panda decision. Cordis is current at `f8ea3cd50f1a5724e8e715995bcde131c9c12b2c`; its delta does not overturn the prior dependency refusal (`C:\code\panda\_bmad-output\planning-artifacts\research\cordis-spatiotemporal-composability-2026-09-01\research.md:212-214`), but source-code HMR/partial reload requires loader internals while watcher callbacks remain available. DeepSeek Harness was fetched at immutable `origin/master` `c291e7961a515f6d7af9304e7fd1d257929aef26`; the local checkout remains `4e84901e6471b79ec0338099867ebb4606d12bb5` because modified instruction files blocked fast-forward.

## Measured evidence

- Cordis moved from `0027892` to `f8ea3cd` across 10 commits and 52 files (`C:\code\panda\.scratch\research-pass-2026-09-11\evidence.md:9-15`). Runtime-shape loader detection is at `C:\code\cordis\packages\loader\src\internal.ts:111-133`; project-scoped bare resolution is at `C:\code\cordis\packages\loader\src\resolve.ts:12-16,50-68` and `C:\code\cordis\packages\loader\src\config\tree.ts:140-151`.
- The corrected HMR statement is executable-source specific: missing internals disable source-code HMR, while watcher callbacks and other fallback paths remain in `C:\code\cordis\packages\hmr\src\index.ts:139-192`; `ctx.hmr.watch()` remains independently implemented and available at `C:\code\cordis\packages\hmr\src\index.ts:196-218` (`C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:9-17`).
- DeepSeek Harness has a measured delta of 16,477 commits, 7,155 files, `+225,552/-62,355`; current claims use immutable `origin/master` evidence rather than pretending local HEAD moved (`C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:29-33`). Current mechanisms include the parent-owned catalog (`deepseek-harness@origin/master:packages/subagent/subagent/src/catalog.ts:20-40,90-155`), continuation activation (`deepseek-harness@origin/master:packages/subagent/subagent/src/continuation-activation.ts:128-168`), typed `noProgress` (`deepseek-harness@origin/master:packages/experimental/tool-agent-team/src/index.ts:100-115`), and the cross-process lease (`deepseek-harness@origin/master:packages/session/session-persistence-jsonl/src/lease.ts:1-25,70-115`).
- Panda's old repository-wide dynamic-import zero is false. Current panda counterexamples are method loading (`C:\code\panda\packages\session\src\methods.ts:106-115`) and lazy SQLite loading (`C:\code\panda\packages\memory-sqlite\src\load-sqlite.ts:41-54`). The refreshed Cordis loader/config dynamic-import paths are `C:\code\cordis\packages\loader\src\resolve.ts:12-16,61-62` and `C:\code\cordis\packages\loader\src\config\tree.ts:140-151`. The current panda scan found 27 `import()` hits; only a separately proven kernel-specific statement may remain (`C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:19-27`).

## Controls and classification

| Finding | Classification | Control / boundary |
|---|---|---|
| Cordis source-code HMR needs internals | mechanism | Watcher callbacks remain independently implemented and available through `hmr.watch()` (`C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:13-17`). |
| DSH catalog, continuation, typed refusal, and lease | mechanism | Positive source paths above; absence claims are not inferred from the stale checkout. |
| Panda-wide dynamic-import zero | refusal | Refused by three positive counterexamples; kernel-only claims require the kernel guard, not generalisation. |
| DSH unresolved source-driven retraction, Landlock internals, deployment telemetry listeners, and credential leakage from arbitrary documents | gap | Explicitly unverified because the cited external or deployment-specific surface was not opened (`C:\code\panda\.scratch\research-pass-2026-09-11\evidence.md:20-22`). |
| Panda's downward topology and zero-runtime-dependency kernel posture | panda-ahead / existing invariant | Preserve existing executable gates; no new equivalence is claimed here. |

The paper remains a formal source, not panda evidence: its theorems and premises are not established by analogy. No code was changed, no frozen spec was created, and no sprint-status entry was added.

## What this note did not open

No Cordis tests ran because its workspace lockfile lacks the required local workspace; no DeepSeek Harness fast-forward was attempted because modified `AGENTS.md`/`CLAUDE.md` made that unsafe. GitNexus indexes were stale (Cordis `0027892`, DeepSeek Harness `4e84901`, panda `0ffe90`) (`C:\code\panda\.scratch\research-pass-2026-09-11\evidence.md:4-7`), and `analyze` was not run because it can mutate read-only/user-instruction files. This note did not open the Landlock addon internals, deployment-specific telemetry listeners, source-driven retraction behavior, or prove any panda theorem.
