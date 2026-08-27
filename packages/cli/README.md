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

## Putting something in the registry

Everything `panda init` projects comes out of the registry, and until story M4.D
there was no way to put anything in it from the binary — the store shipped, the
surface did not.

```sh
pnpm panda add skill commit-lint --entry-path ./skills/commit-lint/SKILL.md
pnpm panda add mcp-server fs --command npx --arg -y --arg @modelcontextprotocol/server-filesystem
pnpm panda list
pnpm panda remove skill commit-lint
```

The scope comes from the GRAMMAR, never from a flag: `panda <verb>` is the
machine scope and `panda project <verb> … [directory]` is a project's, exactly
like `init`, `doctor` and `remediate`. There is deliberately no `--scope agent` —
the agent scope is an in-memory map that dies with the process, so a flag for it
would accept the flag, exit 0 and persist nothing.

Which field flags a type accepts is the registry CONTRACT's answer, not this
command's: `panda add mcp-server t --entry-path ./x` is refused with
`PANDA_REGISTRY_INVALID_ENTRY`, because an `mcp-server` carries a `command` and
`args`. The CLI holds no per-type table, so it cannot drift from the one the
contract already has.

Story M4.E RETIRED the `tool` type: no executor has a non-MCP location for an
identity plus an executable command, and an `mcp-server` entry already carries
exactly what a `tool` entry carried. `panda add tool …` is a usage error, but a
registry written by an older build is still read, still listed, and still
emptied through the product — `panda remove` accepts a retired type, and
`panda doctor` prints the exact spelling for each entry it finds.

`add` registers and projects nothing; it names the command that does. Coupling
the two would make registration fail for projection reasons.

That next step is DERIVED from the same planner `panda init` runs, never written
beside the command, and it can say that nothing takes the entry at all:

```
$ panda project add skill deadend --entry-path ./s.md
registered: project - skill - deadend
NOTHING TAKES IT HERE: no detected executor has a project-scope location for a
skill entry, so `panda project init` would project it nowhere
the machine scope takes it (codex): register it with `panda add` and project it
with `panda init`
```

That is a real dead end and it used to be silent: no executor has a
project-scope skills root panda has verified, machine-scope projection cannot
see a project-scope entry, and `add` still pointed at `panda project init`, which
exits 0 and delivers nothing. The registration still succeeds — the entry is
yours and `panda list` shows it — but the command you are pointed at is the one
that would actually deliver it, or none, and never a command that would not.

`remove` on an entry that was not there says so and exits 1. An empty `list`
exits 0 — an empty list is a result, not a failure.

## Leaving a state `panda doctor` reported

`panda doctor` reports drift and refuses to resolve it, which is correct and used
to be terminal: the only exit was hand-editing `~/.panda/projection-ledger.json`,
the file every safety guarantee in that subsystem is stored in.

```sh
pnpm panda remediate adopt --executor claude-code --entry context7          # describes
pnpm panda remediate adopt --executor claude-code --entry context7 --apply  # performs
```

One finding at a time, named by the user, and only a finding the same run just
reported — zero matches and more than one match are both refusals, and the
refusal lists what could have been named. Without `--apply` the command only
describes, computed by the code that would perform it. Nothing is ever
remediated automatically or in bulk.

| Verb | What it changes | What it lets a LATER run do |
| ---- | --------------- | --------------------------- |
| `adopt` | panda's ledger only | panda OWNS the location: the next `panda init` replaces what is there, and on a skills root can remove it. Every path that becomes deletable is named in the description first |
| `release` | panda's ledger only | nothing — the claim goes, the file is not even opened, and no later run touches it |
| `repair` | panda's own ledger document, dropping exactly the records it cannot read | nothing to a vendor file, ever |
| `discard` | one vendor file, removing only panda's own prior output (correction-01 C6) | nothing further |

Three of the four write nothing but panda's own ledger — but `adopt` is an
ownership TRANSFER, and owning a location is what makes it replaceable and, on a
skills root, removable. Read the description: it says which of the two the next
`panda init` will do and which paths it covers. A `remediate` that panda refuses
exits 1 with `PANDA_PROJECTION_REMEDIATION_REFUSED` and changes nothing.

`panda doctor` names the verb for every state that has one, so the report and the
exit are one string.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | run completed with a status `ok` envelope |
| 1 | run returned `failed` or `cancelled` (envelope still printed) |
| 2 | usage error, invalid request, or environment failure (message on stderr) |

For `doctor` the three narrow: 0 clean, 1 at least one finding that is a problem,
2 no diagnosis could be produced. For `remediate`: 0 described or performed, 1
panda refused, 2 usage or environment failure. For `remove`: 0 removed, 1 the
entry was not registered at that scope (typed absence, never a silent 0), 2 usage
or a coded registry failure.

An executor name panda has no adapter for (`PANDA_EXECUTOR_NOT_FOUND`) and an
unusable configuration document (`PANDA_CONFIGURATION_UNUSABLE`) are both 2, and
carry distinct codes because their fixes differ: correct the name versus repair
the file.

No TUI, no streaming — progress surfaces arrive in later stories.
