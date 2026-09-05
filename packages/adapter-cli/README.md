# @skanl/panda-adapter-cli

Every shipped `ExecutorAdapter` (`@skanl/panda-contracts`) that drives an out-of-process coding CLI.
One generic engine spawns the binary headlessly inside a workspace's root path and maps its
output to a typed `ResultEnvelope`; each executor is a trait RECORD over that engine, never a
class of its own.

## Trait table

`ExecutorTraits` = `{executorId, command, args, promptDelivery, promptArgSeparator?, output}`.
The two real structural axes are prompt delivery and payload shape — everything else is shared
machinery. The factory validates the record and rejects the shapes that would fail silently
(empty `command`, empty `resultPath`, empty `errorStatusPrefix`, `usagePaths` that is empty or
names an empty path, `usagePaths` without the `usageWhen` that bounds it, a `metadata` key colliding with
an engine-owned `data` key) with a coded error.

| Executor | Invocation | Prompt | Payload | Result |
|---|---|---|---|---|
| `claude-code` | `claude --print --output-format json --no-session-persistence --dangerously-skip-permissions` | stdin | one JSON object | `result` |
| `codex` | `codex exec --json --skip-git-repo-check` | stdin (positional omitted) | JSONL events | `item.text` where `item.type == "agent_message"` |
| `opencode` | `opencode run --format json -- <prompt>` | final argv entry | JSONL events | `part.text` where `part.type == "text"` |

Adding a fourth executor means adding a record — `test/trait-stub.test.ts` proves it by passing
the whole clause suite with a trait record the engine has never seen.

All three are reachable from `panda run --executor <id>` and from
`.panda/config.json`'s `executor` key (Story 2.7c). This package owns the catalogue that maps an
id to its adapter — `EXECUTOR_CATALOGUE`, `DEFAULT_EXECUTOR_ID`, `createExecutorAdapter` — because
the kernel plugin below has to perform that lookup for itself.

### As a kernel plugin

`createExecutorPlugin()` mounts an adapter on a `@skanl/panda-kernel` container. It reads WHICH executor
from the kernel's composed configuration (its own `executor` key, the same one `.panda/config.json`
spells), rejects activation when that key names nothing this package ships, and provides the
`executor` service.

That service is a **runner**, not an adapter: `{ executorId, run(actionId, request) }`. The adapter
is closed over and never handed out, so every run registers an action on the KERNEL's interception
waterfall and a cap refuses before a process is spawned. What that closes is the container's
surface — anyone who imports `createClaudeCodeAdapter` from here can still drive one directly, and
`deferred-work.md` keeps that open rather than claiming otherwise.

### Finding the result in a JSONL stream

The engine reads the stream once and keeps two records: the first one that reports a failure, and
the last one carrying a usable result. Codex's `ThreadEvent` variants and OpenCode's event types
are their own evolving vocabularies, so matching on event NAMES would break panda on their next
release; the engine only matches the paths a trait record names, which costs nothing when the
stream ends in trailing noise.

Failure detection is deliberately non-positional. OpenCode emits recoverable `error` events and
keeps going, so "last qualifying line wins" would silently drop a reported failure whenever any
output followed it.

A result path alone is not enough to identify the answer: codex `reasoning` items and opencode
`reasoning` parts both carry a `text` field, so both records add a discriminator. Without one the
adapter would confidently return chain-of-thought as the result.

### Working directory

All three CLIs accept a cwd flag (`-C`, `--dir`), and none of them is passed: the spawn seam
starts the child in `workspace.rootPath`. Codex additionally needs `--skip-git-repo-check`
because a panda workspace is not necessarily a git repository.

The cwd is **not** the only mechanism, and believing it was is what M4.A found. `opencode`
resolves its file tools against `$PWD` rather than against `process.cwd()`, so with panda's own
`PWD` inherited it wrote into the directory panda was launched from — twice, reproducibly. The
spawner therefore hands every child a `PWD` equal to the cwd it is given. Two mechanisms, and for
opencode the second one is the load-bearing one.

### What the workspace is, and what it is not

Measured per executor against the real binaries (`test/confinement-live.test.ts`):

| Executor | A workspace-relative write | Notes |
|---|---|---|
| `claude-code` | lands in the workspace | resolves against its cwd; ignores a lying `PWD` |
| `codex` | never happens | `codex exec` defaults to the `read-only` sandbox, so **as panda ships it codex cannot create or edit a file at all** |
| `opencode` | lands in the workspace | resolves against `$PWD`, which panda sets to the cwd |

**panda makes the workspace true; it does not enforce it.** Told to write to an ABSOLUTE path
outside the workspace, `claude` did so without hesitating — panda runs it with
`--dangerously-skip-permissions` and spawns an ordinary child with the user's own privileges, and
nothing sits between the two. (`codex` refused, but that is codex's own sandbox, not panda's.)
OS-level sandboxing is a deliberate non-goal here.

And `HOME` is passed through untouched, because scrubbing it would break all three: per-user
executor state is therefore SHARED across concurrent sessions — `opencode` keeps a single SQLite
database under `~/.local/share/opencode/`, `claude` a per-project directory under `~/.claude/`.
Two isolated workspaces do not imply two isolated executors.

### Argument delivery is a trust boundary

Putting the prompt in argv means the OS — and on win32 possibly a shell — parses caller-supplied
text, so that path is guarded:

- A `--` separator (trait data) keeps a prompt starting with `-` out of flag position.
- A prompt beyond the platform's conservative argv bound is refused with a coded envelope naming
  the limit, rather than surfacing as an unattributable spawn error.
- A win32 `.cmd`/`.bat` command can only start by rerouting through `cmd.exe`, which interprets
  `&`, `|`, `>`, `^` and `%VAR%` no matter how the argument is quoted. The run fails closed with
  a coded `executorUnavailable` naming the way out (point `command` at the real executable).
  Escaping for `cmd.exe` is not a winnable game and is not attempted.

## Envelope guarantees

Identical for every adapter: coded `executorUnavailable` when the binary cannot spawn,
`executorRunFailed` on pipe/stream errors, non-zero exits, unparseable output and
executor-reported failures (even at exit code 0), and a `cancelled` envelope with a non-empty
`errors` array on abort. Completion is observed before an abort can claim cancellation, so an
abort landing after a successful exit yields the real `ok` envelope. Cancellation kills the whole
process tree (`taskkill /T /F` on win32, process-group SIGKILL on posix) and never signals a pid
that has already exited.

A structured payload survives a non-zero exit: codex and opencode exit non-zero exactly when they
have printed their error event, so the envelope is built from that payload rather than from
stderr noise. A capture that hit the stream cap is reported as a coded failure naming the
truncation — an `ok` built from the last event that happened to survive the cut would be a
confident wrong answer.

## Child-process seam

All spawning goes through `ChildProcessSpawner` (`spawn-seam.ts`). Production uses
`createNodeChildSpawner()`; every adapter suite injects a fake, so no executor is ever really
started by a test. The spawner is also the orphan-detection surface: after cancellation, and
after a broken stdin pipe, no child may remain unsettled-and-unkilled.

Two suites do spawn real processes, and neither runs an executor: `test/overhead.test.ts` and
`test/tree-kill.test.ts` spawn `process.execPath` (part of `pnpm check`, no network, no auth).
Three suites run a real coding CLI: `test/live-smoke.test.ts`, `test/usage-live.test.ts` and
`test/confinement-live.test.ts`.

The spawner also decides the child's ENVIRONMENT, which is otherwise inherited whole. Exactly one
variable is changed: `PWD` is set to the cwd the child is given, because it is the only inherited
variable that claims to name the working directory and a stale one redirects `opencode`'s writes.
Nothing is removed — `INIT_CWD` was the suspect M3.C named and was ruled out by measurement, and
deleting a variable measured not to matter is a scrub, not a fix.

## Spawn-overhead instrumentation

Pass `onTiming` to receive `{ spawnSetupMs, runMs }` per run. NFR-9 budgets adapter-added overhead
at ≤150ms above raw CLI startup; the deterministic measurement lives in `test/overhead.test.ts`
(adapter vs direct spawn of the same trivial command — no network, no auth, no flake).

## Live smoke

`test/live-smoke.test.ts` runs one tiny real task end-to-end when the `claude` binary is detected
and authenticated; otherwise it skips with an explicit reason (never silently passes).
Set `PANDA_LIVE_SMOKE=0` to disable it explicitly. It is env-gated by design and is never part of
what `pnpm check` guarantees.

## Confinement

`test/confinement-live.test.ts` measures, per executor, where a file the executor was told to
create actually lands. The same rule applies: a missing or non-answering binary skips with its
reason, an authenticated-but-logged-out one skips, and `PANDA_LIVE_CONFINEMENT=0` disables it.
Because that means CI — where none of the three binaries exists — runs it green while measuring
nothing, its last case PRINTS which executors were measured; read that line before trusting a
green run. Its deterministic half (what environment the spawner hands a child) runs everywhere and
needs no binary.

## Token usage

A trait record may declare where its vendor reports what a run spent:

- `usageWhen` — the records that carry usage (`{"type": "turn.completed"}` for codex,
  `{"type": "step_finish"}` for opencode, `{"type": "result"}` for claude-code).
- `usagePaths` — the numeric fields inside such a record. They are summed within a record
  **and across every matching record**, because a vendor that works in steps bills each step.

The total lands on `envelope.data.usage` as a NUMBER — the one non-string value there, and the
reason `usage` is an engine-owned key a `metadata` key may not collide with. Absent means the
vendor reported nothing; the figure is never faked, never estimated and never tokenized by panda.
It fails closed as a whole: if any billed record cannot be read, the run reports no figure rather
than a sum missing a term.

Every shipped figure is verified against the real binary by `test/usage-live.test.ts`, which is
also what keeps a fourth adapter from shipping a `usagePaths` nobody ever exercised.
