---
title: 'Shipped adapters complete the set'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 1
baseline_commit: '8f825cd'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-4-executoradapter-port-with-contract-test-harness.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-5-first-execution-claude-code-driven-headlessly.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-3-codex-and-opencode-targets-via-trait-data.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Only Claude Code is drivable. `ClaudeCodeAdapter` mixes genuinely generic machinery — spawn seam, cancellation, exit-code and stream-error classification, timing, summarization — with the handful of things that are actually Claude-specific. Adding Codex or OpenCode by copying that class would triple the machinery and let the three drift apart; FR-7/8/9/10 require executor differences to be DATA.

**Approach:** The same move Story 2.3 made for projection targets, applied to executors. One generic CLI-executor engine driven by an `ExecutorTraits` record: `{executorId, command, args, promptDelivery, output}`. Three trait records — Claude Code, Codex, OpenCode — and a trait-only stub executor proving a fourth needs no engine change. All of them run the Story 1.4 contract suite, uniformly, against fake spawners.

**Verified CLI contracts (do not re-derive from memory):** Codex is `codex exec [OPTIONS] [PROMPT]` — the prompt is read from STDIN when the positional is omitted, and `--json` prints events to stdout as **JSONL**. OpenCode is `opencode run [message..]` — the prompt is a POSITIONAL argument and `--format json` streams raw JSON events. Claude Code is `--print --output-format json` — the prompt arrives on stdin and stdout carries ONE JSON object. So the two real structural axes are prompt delivery (stdin vs argument) and payload shape (single object vs newline-delimited stream).

## Boundaries & Constraints

**Always:** every shipped adapter is a trait record over ONE engine — adding an executor means adding a record, verified by a stub-executor test that touches no existing adapter code; all three (plus the stub) pass the SAME Story 1.4 contract suite in CI on Node 24; every adapter keeps the existing envelope guarantees — coded `executorUnavailable` when the binary cannot spawn, `executorRunFailed` on pipe/stream errors, non-zero exits and unparseable output, a `cancelled` envelope with a non-empty errors array on abort, and completion observed before an abort can claim cancellation; the process-tree kill and NFR-9 spawn-overhead timing stay shared; adapters continue to receive the abstract `WorkspaceHandle` and never a bare cwd; contract-suite runs use fake spawners exclusively — no test may execute a real binary.

**Ask First:** a fourth shipped executor; any change to the `ResultEnvelope` schema; wiring adapter selection into the CLI beyond keeping `panda run` working.

**Never:** no live-binary smoke test added to `pnpm check` (the existing env-gated one stays env-gated); no bespoke per-executor error taxonomy — the coded vocabulary in `@skanl/panda-contracts` is closed; no session/resume features; no liveness detection (Story 2.6).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Prompt delivery, stdin | Claude / Codex traits | Prompt written to stdin and stdin closed; no prompt in argv | Pipe failure → coded `executorRunFailed` |
| Prompt delivery, argument | OpenCode traits | Prompt appended as the final argv entry; stdin closed immediately | N/A |
| Single-object payload | Claude, stdout = one JSON object | Parsed; result text and metadata into the envelope | Unparseable → coded `executorRunFailed` |
| JSONL payload | Codex / OpenCode, stdout = event stream | The LAST line parsing as an object carrying the configured result field wins | No such line → coded `executorRunFailed` naming the executor |
| JSONL with trailing noise | Stream ends with blank lines / a non-object line | Ignored; the last qualifying event still wins | N/A |
| Executor-reported failure | Payload carries the trait's error flag or an error-ish status | `failed` envelope with non-empty errors, exit code 0 notwithstanding | Coded `executorRunFailed` |
| Binary missing | Spawn reports a spawn error | `failed` envelope | Coded `executorUnavailable` |
| Abort mid-run | Signal fires before completion | `cancelled` envelope, non-empty errors, process tree killed | N/A |
| Abort after completion | Signal fires once the child already exited 0 | The real `ok` envelope, NOT cancelled | N/A |
| Trait-only stub executor | New trait record, zero engine edits | Contract suite passes for it | N/A |

</frozen-after-approval>

## Code Map

- `packages/adapter-claude/` -- RENAMED to `packages/adapter-cli` (`@skanl/panda-adapter-cli`). It already owns the spawn seam and the Node spawner; the package name is what stops being true, not its contents. Single consumer to update: `packages/cli` (`package.json` + `src/run.ts`).
- `packages/adapter-cli/src/traits.ts` -- NEW: `ExecutorTraits` types + the generic engine (`createCliExecutorAdapter`), extracted behavior-neutrally from `claude-code-adapter.ts`
- `packages/adapter-cli/src/executors/{claude-code,codex,opencode}.ts` -- THIN trait records
- `packages/adapter-cli/src/{spawn-seam,node-child-spawner}.ts` -- unchanged
- `packages/adapter-cli/test/` -- the Story 1.4 contract suite instantiated for all three + a trait-only stub; existing Claude behavior tests stay green through the rename

## Tasks & Acceptance

**Execution:**
- [x] Rename the package and update its single consumer; existing tests stay green (behavior-neutral)
- [x] Extract the generic engine + `ExecutorTraits`; Claude becomes a trait record with no behavior change
- [x] Codex and OpenCode trait records against the verified CLI contracts above
- [x] Contract suite run uniformly across all three adapters plus a trait-only stub executor
- [x] Matrix rows covered, fake spawners only

**Acceptance Criteria:**
- Given the contract-test suite from Story 1.4, when all three adapters run through it in CI, then all pass on Node 24
- Per-executor differences live exclusively in the trait table, demonstrated by a test adding a trait-only stub executor without code changes

## Spec Change Log

- **Review, command injection on win32 (patch, SECURITY):** the seam relaunches `.cmd`/`.bat` through `cmd.exe /d /s /c`, and Node's CRT-style argument quoting does not neutralise cmd.exe metacharacters. Claude was stdin-only so the prompt never entered argv; argument delivery put it there, making `&`, `|`, `>`, `^`, `%VAR%` and newlines interpretable — the class Node closed by refusing to spawn `.cmd` without a shell. Escaping for cmd.exe is not winnable, so the run FAILS CLOSED with a coded envelope naming the way out. Argument delivery additionally gained a `--` separator (trait data, so a record can opt out) and a platform argv-length guard, since the stdin path's documented length guarantee had no counterpart.
- **Review, four confidently-wrong answers on the new executors' paths (patch):** (1) the stream capture cap never advanced its byte counter, so every chunk past the cap appended another cap-sized slice — no cap at all, and newly routine because codex/opencode emit an event per token where Claude emitted one object; (2) a truncated JSONL tail failed to parse, was skipped, and an EARLIER event was returned as `ok`; (3) a non-zero exit discarded the parsed payload entirely — exactly when codex and opencode print their structured error event; (4) an error event followed by later output vanished, because failure detection rode on the same backward positional scan. Failure detection is now non-positional: correctness cannot depend on an emission order no executor guarantees, and the direction that failed was the unsafe one.
- **Review, chain-of-thought as the answer (patch, verified not guessed):** `resultPath: ['item','text']` qualified any event carrying that path. Confirmed against `codex-rs/exec/src/exec_events.rs`: `ThreadItemDetails` is `#[serde(tag = "type")]` and BOTH `AgentMessageItem` and `ReasoningItem` carry `text`, so an undiscriminated scan returns the model's reasoning as the result. Added `resultWhen` as OPTIONAL trait data — the engine still knows no event taxonomy, the record carries the value. Applied to OpenCode too, whose `reasoning` events have the same shape: fixing only the executor that was named would have left its sibling broken.
- **Review, process lifecycle (patch):** the win32 `.cmd` EINVAL reroute attaches a NEW child, but the prompt had already been written and stdin closed on the first one synchronously — the rerouted child waited on stdin forever, hanging Claude and Codex on Windows. The seam now buffers stdin writes and the end signal and replays them onto whichever child it installs. A throwing `writeStdin` no longer orphans a live executor, `killTree` is guarded against signalling a recycled pid, and the abort handler consults the seam's settled state so a completed run cannot be discarded as cancelled.
- **Review, trait records are an API surface (patch):** validated at factory time — empty command, empty `resultPath` (resolves to the record itself, never matches), empty `errorStatusPrefix` (`''.startsWith('')` marks every run failed), and `metadata` keys colliding with the engine's own `result`/truncation keys. Reuses the closed `contractEnvelopeInvalid` code rather than adding an executor-traits code, per this spec's Never clause; a trait record is a contract object handed to a factory, which is what that code already means elsewhere.
- **Review, behavior-neutrality delta (patch):** the summary fallback had moved from a constant to the command string, leaking an absolute binary path into a persisted user-facing field whenever `command` is overridden. It now uses `executorId` — the stable identity, which is why that property exists.
- **Review, tests asserting less than they claimed (patch):** the fixed argv of codex and opencode was pinned by nobody — deleting `--skip-git-repo-check` or `--format json` left the suite green while the real binaries would refuse to run or emit non-JSON. Likewise the reported-failure clause never read `errors[0].message`, so `stringifyDetail` (the entire reason OpenCode's object-shaped error survives) could be stubbed to `''` with everything passing. Both pinned, along with per-executor metadata, the command override versus `executorId`, and the previously unreachable branches.
- **Honest gap recorded:** the `Object.hasOwn` guard in the path resolver is defence in depth that no test can distinguish from its absence — `isRecord` already rejects every inherited value one hop earlier, since every `Object.prototype` member is a function. Kept and documented as such rather than covered by a test that would claim more than it proves.

## Design Notes

**Finding the result in a JSONL stream without pinning event names.** Codex's `EventMsg` variants and OpenCode's event shapes are their own evolving vocabularies; hard-coding a `type` string would make panda break on their next release. The engine instead scans the stream from the END and takes the first line that parses as an object carrying the trait's configured result field. It is the laziest rule that is also the most robust one: it needs no event taxonomy, tolerates trailing noise, and degrades to a coded error rather than a wrong answer.

**Why the rename rather than a new package.** `packages/adapter-claude` already holds the spawn seam, the Windows-safe process-tree kill and the Node spawner — all executor-agnostic. A new package would duplicate that or depend on a package whose name claims to be Claude-only. One rename with one consumer is the smaller, honest diff.

**Working directory.** All three CLIs accept a cwd flag (`-C`, `--dir`), but the spawn seam already starts the child in `workspace.rootPath`. Do not add the flags: one mechanism, shared, already exercised. Codex additionally needs `--skip-git-repo-check` because a panda workspace is not necessarily a git repository.

## Verification

**Commands:**
- `pnpm check` -- expected: fully green
