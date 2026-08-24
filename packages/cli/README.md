# @panda/cli

Minimal `panda` command-line surface. First slice only: `run <prompt>` wires
`@panda/workspace-local` (workspace under `<cwd>/.panda/workspaces/<uuid>`) to the Claude Code
adapter and prints the resulting typed envelope as structured JSON.

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
