# @panda/cli

Minimal `panda` command-line surface, and nothing more than a binding: it parses
argv, calls [`@panda/session`](../session/README.md), prints the typed envelope as
structured JSON and maps it to an exit code. The composition it used to own —
workspace under `<cwd>/.panda/workspaces/<uuid>`, adapter, cancellation, cleanup —
lives in that package, so a third party can do everything this CLI does without
installing it.

## Usage

```sh
pnpm panda run "list files in this workspace"
```

Output: the `ResultEnvelope` as pretty-printed JSON on stdout.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | run completed with a status `ok` envelope |
| 1 | run returned `failed` or `cancelled` (envelope still printed) |
| 2 | usage error, invalid request, or environment failure (message on stderr) |

No TUI, no streaming — progress surfaces arrive in later stories.
