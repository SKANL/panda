# @panda/adapter-claude

Claude Code implementation of the `ExecutorAdapter` port (`@panda/contracts`). It spawns the
`claude` CLI headlessly inside a workspace's root path and maps the result to a typed
`ResultEnvelope`.

## How it runs

- Print mode (`--print`) with `--output-format json`: one JSON result object on stdout.
- The prompt is delivered via stdin (the CLI's piped-input convention), never via argv, so long
  prompts cannot hit command-line length limits.
- `--no-session-persistence` keeps session state from outliving the workspace;
  `--dangerously-skip-permissions` is required because headless execution has no interactive
  approver.
- Cancellation aborts via the standard `AbortSignal` on `RunRequest`; termination kills the whole
  process tree (`taskkill /T /F` on win32, process-group SIGKILL on posix) and resolves a typed
  `cancelled` envelope with a non-empty `errors` array.

## Child-process seam

All spawning goes through `ChildProcessSpawner` (`spawn-seam.ts`). Production uses
`createNodeChildSpawner()`; tests inject fakes so unit suites and the executor contract suite run
without the real binary. The spawner is also the orphan-detection surface: after cancellation no
child may remain unsettled-and-unkilled.

## Spawn-overhead instrumentation

Pass `onTiming` to receive `{ spawnSetupMs, runMs }` per run. NFR-9 budgets adapter-added overhead
at ≤150ms above raw CLI startup; the deterministic measurement lives in
`test/overhead.test.ts` (adapter vs direct spawn of the same trivial command — no network, no auth,
no flake).

## Live smoke

`test/live-smoke.test.ts` runs one tiny real task end-to-end when the `claude` binary is detected
and authenticated; otherwise it skips with an explicit reason (never silently passes).
Set `PANDA_LIVE_SMOKE=0` to disable it explicitly.
