---
title: 'ExecutorAdapter port with contract-test harness'
type: 'feature'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'a75bcad82c4a5b60fd2332238a52b3bc259333fc'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-1-plugin-manifest-foundation.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no ExecutorAdapter port, no typed result envelope, and no runnable way to prove an adapter honors the execution contract — every future adapter (Claude Code, Codex, OpenCode) would be validated ad hoc. The workspace abstraction pandas executors run inside also does not exist.

**Approach:** Define the ExecutorAdapter and WorkspaceProvider ports in `@skanl/panda-contracts` with Standard Schema interfaces and a typed result envelope `{status, data, summary, changedPaths?, errors?}`; publish a runnable contract-test suite that validates ANY adapter against named clauses; ship the local-directory WorkspaceProvider implementation passing those clauses.

## Boundaries & Constraints

**Always:** ports live in `@skanl/panda-contracts` (zero runtime deps, Standard Schema v1 facing); a partially-implemented adapter FAILS the suite with each violated clause NAMED; the local-dir provider passes all workspace contract clauses incl. persistent state across sessions; `@skanl/panda-kernel` stays zero-dependency importing neither contracts nor implementations (guards already enforce); result envelopes are typed per FR-6 shape. New error codes join contracts canonically.

**Ask First:** any real process spawning in this story (adapters spawn in Story 1.5); changing envelope field names.

**Never:** no Claude/Codex/OpenCode adapter implementations here (Story 1.5 / Epic 2); no cancellation/process-tree logic (arrives with first real executor); no CLI surface.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Partial stub adapter | Adapter missing one or more clause implementations | Suite fails naming EACH violated clause | Named failures, non-zero exit |
| Compliant stub adapter | Adapter satisfying every clause | Suite passes | N/A |
| Workspace persistence | Create workspace, write state, release, re-acquire | State visible across acquire/release cycles | N/A |
| Double release / unknown handle | Release same workspace twice or acquire unknown id | Typed coded error naming the clause | Coded errors |
| Envelope conformance | Adapter returns malformed envelope | Suite fails naming the schema violation | Named failure |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/` -- NEW ports: `executor.ts` (ExecutorAdapter, RunRequest, ResultEnvelope schemas), `workspace.ts` (WorkspaceProvider, handle + capabilities)
- `packages/contracts/src/errors.ts` -- codes for contract violations (`PANDA_CONTRACT_*` vocabulary for suite assertions)
- `packages/contracts/src/contract-suite/` -- NEW: published runnable harness (per-clause test functions, aggregate runner reporting violated clauses by name)
- `packages/workspace-local/` -- NEW package: local-directory WorkspaceProvider passing the workspace clauses
- `packages/workspace-local/test/`, `packages/contracts/test/contract-suite.test.ts` -- self-test: suite flags partial stubs clause-by-clause
- Root configs -- register new workspace package(s)

## Tasks & Acceptance

**Execution:**
- [ ] `packages/contracts/src/executor.ts` + `workspace.ts` -- ports + Standard Schema envelope/request/handle definitions -- FR-6/FR-17 contracts
- [ ] `packages/contracts/src/contract-suite/` -- clause-decomposed harness, each clause independently runnable and nameable -- FR-9 infra
- [ ] `packages/workspace-local` -- local-dir provider implementing WorkspaceProvider -- FR-17 reference implementation
- [ ] tests -- partial-stub names each violated clause; compliant stub passes; workspace-local passes all clauses -- proves both directions of the harness
- [ ] root scaffold updates -- new package wired into workspace/scripts -- keeps gates whole

**Acceptance Criteria:**
- Given a stub adapter implementing the port partially, when the contract suite runs, then it fails naming each violated clause
- Given the workspace-local provider, when the workspace contract clauses run, then all pass including state persistence across sessions
- Given `@skanl/panda-kernel`, then it remains zero-dependency importing neither contracts nor implementations (existing guards stay green)

## Spec Change Log

## Verification

**Commands:**
- `pnpm -r typecheck` -- expected: zero errors
- `pnpm -r test` -- expected: all suites green including harness self-tests
- `pnpm -r lint` -- expected: zero warnings

| 2026-08-24 | Review sanctioned one additional canonical code beyond the planned set: PANDA_CONTRACT_WORKSPACE_UNAVAILABLE, owned by wrapped filesystem failures during create/acquire (an I/O outage is neither an invalid handle nor an unknown id). KEEP: per-handle lease semantics and disk-persisted workspace state are correct and must survive re-derivation. | Dead canonical vocabulary and mislabeled IO failures |
