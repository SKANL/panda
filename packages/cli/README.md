# @panda/cli

Minimal `panda` command-line surface, and nothing more than a binding: it parses
argv, calls [`@panda/session`](../session/README.md), prints the typed envelope as
structured JSON and maps it to an exit code. The composition it used to own —
workspace under `<cwd>/.panda/workspaces/<uuid>`, adapter, cancellation, cleanup —
lives in that package, so a third party can do everything this CLI does without
installing it. It reads no files itself; `eslint.config.js` forbids this package
from importing `node:fs` at all, because a capability that needs a filesystem
read is a capability that belongs in `@panda/session` or `@panda/environment`.

## Usage

```sh
pnpm panda run "list files in this workspace"
pnpm panda run --executor codex "list files in this workspace"
```

Output: the `ResultEnvelope` as pretty-printed JSON on stdout.

## Choosing an executor

Panda ships three adapters — `claude-code`, `codex` and `opencode` — and resolves
which one runs through layered configuration, widest to narrowest:

| Layer | Source |
| ----- | ------ |
| `defaults` | panda's built-in default, `claude-code` |
| `global` | `~/.panda/config.json` |
| `project` | `<project>/.panda/config.json` |
| `invocation` | `--executor <id>` (or `--executor=<id>`) |

The document is JSON with one key this command reads:

```json
{ "executor": "codex" }
```

**Every real invocation now writes one line to stderr**, naming the selection and
the layer that decided it — `executor: codex (selected by the 'project' layer)`.
A run whose output cannot tell you which agent produced it is not a swap you can
trust. This is a behaviour change for a script that treats any stderr output as
failure; branch on the exit code instead.

A configuration document that is MISSING is simply an absent layer. One that
exists and cannot be used — unreadable, a dangling symlink, invalid JSON, not an
object, or an `executor` that is not a string — is a coded error and exits 2. It
is never a quiet fall back to the default, because running a different agent than
the one you configured is the failure this feature exists to remove. `--executor`
overrides a configuration panda can READ; it does not rescue one it cannot.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | run completed with a status `ok` envelope |
| 1 | run returned `failed` or `cancelled` (envelope still printed) |
| 2 | usage error, invalid request, or environment failure (message on stderr) |

An executor name panda has no adapter for (`PANDA_EXECUTOR_NOT_FOUND`) and an
unusable configuration document (`PANDA_CONFIGURATION_UNUSABLE`) are both 2, and
carry distinct codes because their fixes differ: correct the name versus repair
the file.

No TUI, no streaming — progress surfaces arrive in later stories.
