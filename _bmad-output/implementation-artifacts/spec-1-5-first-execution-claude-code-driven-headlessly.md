---
title: 'First execution — Claude Code driven headlessly'
type: 'feature'
created: '2026-08-24'
status: 'in-progress'
review_loop_iteration: 0
baseline_commit: 'b822dd14a85d7fba1bb384fb568d3c0a96150142'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-4-executoradapter-port-with-contract-test-harness.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Panda has ports and a harness but no real executor: no developer can run a coding task through an actual agent and get a typed result back. The platform's first end-to-end execution path (UJ-1 groundwork) is unproven.

**Approach:** Implement the Claude Code adapter on the ExecutorAdapter port (headless spawn inside a Workspace, prompt delivery via stdin/args per Claude Code CLI conventions), add typed `cancelled` status to the envelope with process-tree termination, measure spawn overhead against the 150ms budget, and expose the flow through a minimal `panda run` CLI.

## Boundaries & Constraints

**Always:** the adapter passes the full executor contract suite from Story 1.4; results conform to the typed envelope (now `status: 'ok' | 'failed' | 'cancelled'`); cancellation kills the entire spawned process tree and still returns a typed cancelled envelope; spawn overhead ≤150ms above raw `claude` CLI startup (NFR-9); live-executor tests are environment-gated — they RUN when `claude` is detected and authenticated, and SKIP with an explicit typed reason otherwise (never silently pass); adapter differences vs future executors go through data/traits thinking, not hardcoded branches where avoidable.

**Ask First:** any non-headless/interactive mode; persisting credentials or session state beyond the workspace.

**Never:** no Codex/OpenCode adapters (Epic 2); no liveness hooks/PTY fallback (Story 2.6); no streaming UI — progress events may emit on the kernel bus but no TUI.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | Simple coding task in a local workspace, claude available | Typed ok envelope {status:'ok', data, summary, changedPaths?} | N/A |
| Task failure | Task/command errors out | Typed failed envelope with errors populated | Coded envelope, non-zero mapping |
| Mid-run cancel | Cancel invoked while executing | Process tree terminated; typed cancelled envelope | No orphan processes |
| Spawn overhead | Time adapter-spawn minus raw CLI cold start | ≤150ms delta (NFR-9) measured by test | Budget breach = failing measurement test |
| Missing binary | claude not installed | Typed failed envelope naming the missing executor; env-gated tests skip with explicit reason | Coded error |
| CLI run | `panda run "<prompt>"` in a bound dir | Envelope printed as structured output; non-zero exit on failure/cancel | Exit codes documented |

</frozen-after-approval>

## Code Map

- `packages/contracts/src/executor.ts` -- extend envelope status union with `'cancelled'`; schema-level rules for each status
- `packages/adapter-claude/` -- NEW package `@panda/adapter-claude`: spawns `claude` headlessly (print/non-interactive mode) inside a WorkspaceHandle rootPath; maps CLI output/errors to envelopes; implements tree-kill cancellation
- `packages/cli/` -- NEW package `@panda/cli`: minimal bin `panda` with `run <prompt>` (first slice only; uses kernel + adapter + workspace-local)
- `packages/contracts/src/contract-suite/` -- cancellation clause added to EXECUTOR_CLAUSES (stub-friendly)
- Tests -- unit suites with a fake child-process seam + environment-gated live smoke (`claude` detection)

## Tasks & Acceptance

**Execution:**
- [ ] `packages/contracts/src/executor.ts` -- `'cancelled'` status in envelope + schema rules -- AC requires typed cancelled result
- [ ] `packages/contracts/src/contract-suite/executor-clauses.ts` -- cancellation clause (cancel mid-run resolves typed cancelled; no orphaned children detectable via seam) -- FR-6 cancellation becomes contractual
- [ ] `packages/adapter-claude` -- headless spawn, envelope mapping, tree-kill cancel, overhead instrumentation -- the story's core deliverable
- [ ] `packages/cli` -- `panda run` minimal command -- FR-6 user surface slice
- [ ] tests -- contract suite green incl. cancellation; overhead measurement; env-gated live smoke -- proves offline AND documents live evidence path

**Acceptance Criteria:**
- Given Claude Code installed and authenticated, when a task runs through the adapter in a local workspace, then a typed ok envelope conforming to the schema returns
- When cancelling mid-run, then the process tree terminates and a typed cancelled envelope returns
- Spawn overhead stays ≤150ms above raw CLI startup (measured test, env-tolerant)
- A minimal `panda run <prompt>` exposes the flow end-to-end
- The adapter passes the full executor contract suite including the new cancellation clause

## Spec Change Log

## Verification

**Commands:**
- `pnpm -r typecheck` -- expected: zero errors
- `pnpm -r test` -- expected: all suites green (live smoke skips cleanly without credentials)
- `pnpm -r lint` -- expected: zero warnings

**Manual checks (live evidence):**
- With `claude` authenticated: `pnpm --filter @panda/cli build:noop && pnpm panda run "list files"` style smoke produces a typed ok envelope (document exact invocation in package README section of the story report)
