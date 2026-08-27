# @panda/projection

Projects Registry entries into executors' native configuration files, in each
executor's OWN vocabulary at the location that executor actually reads (port
defined in `@panda/contracts`).

- `runProjection` — engine: reads the ownership ledger, then runs each target
  SEQUENTIALLY with per-target failure containment (a failing target never
  affects siblings, and failures surface as typed results — the call does not
  throw). The native file lands before the ledger records it, so a crash
  between the two under-claims rather than over-claims. Single-writer
  assumption: concurrent `runProjection` calls over the same projected file are
  unsupported in v1; a file modified externally between read and write fails
  that target instead of landing stale content.
- `ProjectionLedger` — panda's durable record of what it wrote (target, file,
  native location, content hash), in `~/.panda/projection-ledger.json`. Panda
  never marks a vendor's file to prove ownership: a marker has nowhere to live
  in some formats and is an unknown field in others. Writes MERGE one target's
  claims into the on-disk document; an unreadable ledger is reported and left
  alone, never overwritten.
- `createClaudeMcpTarget` — `mcpServers` in `~/.claude.json` (or `.mcp.json`
  for project scope), `{type:'stdio', command, args}`.
- `createOpenCodeConfigTarget` — `mcp.<id>` in `opencode.json`,
  `{type:'local', command: argv}`.
- `createCodexConfigTarget` — `[mcp_servers.<id>]` in `config.toml`, `command`
  and `args` only, so `--strict-config` has nothing to reject.

Ledger records, native-entry and drift vocabulary live in `@panda/contracts`
(`src/projection.ts`). Drift is a ledger-versus-disk comparison — `edited`,
`removed-by-user`, `foreign-collision` — and is always reported, never resolved
by writing.

- `createClaudeSkillsTarget` / `createCodexSkillsTarget` /
  `createOpenCodeSkillsTarget` — materialisation targets: they own a ROOT and
  copy each registry skill's `entryPath` to `<root>/<id>/SKILL.md`. Panda
  copies; it never authors skill content.

## Where skills land, and what each executor really reads

Verified by EXECUTION against each installed binary under an injected home
(`test/skills-discovery.live.test.ts`), not by reading a document.

| Executor | Panda writes | How it was verified |
| --- | --- | --- |
| claude-code | `~/.claude/skills/<id>/SKILL.md` | the request claude sends lists it in its own available-skills block |
| codex | `~/.codex/skills/<id>/SKILL.md` | `codex debug prompt-input` names the file by absolute path |
| opencode | `~/.config/opencode/skills/<id>/SKILL.md` | `opencode debug skill` reports that exact `location` |

**OpenCode reads four roots, and panda does not write into the one that wins.**
Measured: `~/.config/opencode/skills`, `~/.config/opencode/skill`,
`~/.opencode/skills` and `~/.opencode/skill` are all scanned, and with the same
skill id present in two of them `~/.opencode/skills` silently takes precedence
while `panda init` and `panda doctor` still report panda's own write as done.
Panda writes one root per executor and claims nothing about precedence between
them. OpenCode additionally scans `~/.claude/skills` and `~/.agents/skills`, so
a skill panda materialises for Claude Code is visible to opencode too.

**Panda's registry id is not necessarily the name the executor shows.** Claude
Code takes the skill's name from the DIRECTORY, while codex and opencode take
it from the source's frontmatter `name:`. A registry entry whose id differs
from its source's frontmatter therefore appears under two different names, and
panda's ledger, `init` and `doctor` all name the registry id.

Entries no target can express are still reported rather than approximated
(`skippedEntryIds`, plus the target's own reason in `skipped`): a `tool` has
no native representation in any of the three, and `profile` is panda's own
concept. Skills at PROJECT scope are reported the same way — materialising into
a project is a decision no story has taken, so panda invents no location.
