---
title: 'technical research: formal contracts and process gates'
type: 'technical'
topic: 'Formal paper claims, executable engineering contracts, and the boundary between analogy and proof'
decision: 'How panda may use Cordis/DSH formal and process prior art without overstating equivalence or enforcement'
source: 'arXiv:2608.25512, DeepSeek Harness origin/master c291e796, and panda repository guidance'
status: complete
preset: 'standard'
created: '2026-09-11'
updated: '2026-09-11'
validation: measured
claims_verified: 17
claims_unverified: 6
extends: 'cordis-spatiotemporal-composability-2026-09-01 and deepseek-harness-the-last-nine-groups-2026-09-04'
---

# Formal contracts and process gates

## Executive summary

The paper formalizes a calculus and metatheory; it does not prove panda satisfies that calculus. The safe comparison is that panda resembles analogous mechanisms until an executable panda invariant proves the correspondence. The same discipline applies to process: a prose rule is not an enforced contract unless a gate fails when the rule is violated.

## Measured evidence

- The formal-source claims are: state-local inverse, local witness, reactive coeffects, temporal conditions, spatial ordering, and the implementation algorithm. The exact paper sections and page/line ranges reviewed for those claims are recorded at `C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:57-61`. These establish what the paper formalizes, not panda theorem satisfaction.
- DSH makes several engineering contracts executable: release packaging and validation (`deepseek-harness@origin/master:.github/workflows/release.yml:80-107`), process/thread test separation (`deepseek-harness@origin/master:vitest.config.ts:158-220`), translation pairing and hashes (`deepseek-harness@origin/master:docs/i18n/README.md:7-57`), and doc budgets (`deepseek-harness@origin/master:docs/AGENTS.md:47-57`).
- Panda already encodes the same governing principle in its repository rules: the source-byte and consumer-proof architecture claims are at `C:\code\panda\AGENTS.md:61-70`; the check pipeline and process surfaces are at `C:\code\panda\AGENTS.md:88-104`. These are panda evidence of selected contracts, not proof of the paper's formal premises.
- Process evidence also includes scoped zeros. DSH's two commands with no non-`package.json` references are controlled by positive references to `check:all` and `verify-cordis-api` (`C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:63-68`). Panda's old dynamic-import zero is not a valid control: `C:\code\panda\packages\session\src\methods.ts:106-115` and `C:\code\panda\packages\memory-sqlite\src\load-sqlite.ts:41-54` are positive counterexamples.

## Controls and classification

| Finding | Classification | Control / interpretation |
|---|---|---|
| Paper formalizes temporal/spatial/revertible concepts | mechanism (formal-source only) | Paper citations identify definitions and algorithms; no panda theorem claim follows. |
| DSH turns packaging, testing, i18n, and documentation rules into executable surfaces | mechanism | Workflow/configuration paths above are the control. |
| Panda's invariant-first rule | panda-ahead / mechanism | Existing byte, topology, guard, and consumer gates are executable controls; prose alone is not counted. |
| Panda resembles Cordis/DSH contracts | analogy | Refusal to call this equivalence unless a panda-specific test proves the matching invariant. |
| Unopened formal premises, full release behavior, and deployment effects | gap | Claims remain unverified rather than inferred from analogous names or comments. |

No code was changed, no frozen spec was created, and no sprint-status entry was created. The notes are research artifacts, not implementation authorization.

## What this note did not open

It did not prove panda satisfies any paper theorem, run Cordis tests because of the lockfile limitation, publish a package, or execute DSH release workflows. GitNexus was not refreshed: its indexes were stale, and `analyze` was deliberately not run because it can mutate read-only/user-instruction files (`C:\code\panda\.scratch\research-pass-2026-09-11\verification.md:70-74`). It did not inspect Landlock internals, deployment-specific telemetry listeners, or arbitrary-document credential leakage.
