# @skanl/panda-projection

Projects Registry entries into executors' native configuration files, in each
executor's OWN vocabulary at the location that executor actually reads (port
defined in `@skanl/panda-contracts`).

- `runProjection` — engine: reads the ownership ledger, then runs each target
  SEQUENTIALLY with per-target failure containment (a failing target never
  affects siblings, and failures surface as typed results — the call does not
  throw). The native file lands before the ledger records it, so a crash
  between the two under-claims rather than over-claims. Single-writer
  assumption: concurrent `runProjection` calls over the same projected file are
  unsupported in v1; a file modified externally between read and write fails
  that target instead of landing stale content.
- `runRemediation` — the way OUT of a state projection reports and refuses to
  resolve. Four verbs, one subject per call, and the SAME call describes and
  performs (`mode: 'inspect' | 'apply'`, the engine's own switch), so a preview
  cannot disagree with the act:
  - `adopt` — panda takes ownership of what is at its own location, exactly as
    it is now. It writes only the ledger, and that is not the same as being
    harmless: owning a location is what lets a LATER `runProjection` replace it,
    and on a materialisation root REMOVE it. The description names every path
    that becomes deletable and says which of the two will happen, before the
    claim is written. A tree that is only partly there is claimed as the subset
    that exists, so the ordinary run writes the rest back; an entry that has left
    the registry is claimed from the ledger's own record, and the next run then
    removes the tree. There is no verb that renders one entry outside the merge.
  - `release` — panda stops claiming a location. The file is not opened.
  - `repair` — panda rewrites its OWN ledger to hold exactly the records it can
    read; the only write that does not merge, and the only exit from a ledger
    carrying records it cannot use.
  - `discard` — panda removes its OWN prior output from a vendor file
    (correction-01 C6): a reserved `$.panda` key whose members are *all* panda's
    own vocabulary (`version`, `tools`, `mcpServers`, `skills`, `hooks`), or a
    `# BEGIN panda-managed` block whose sub-keys under `[tools]`/`[skills]` make
    a Codex `config.toml` fail to load under `--strict-config`. A `panda` key
    holding anything else is somebody's own configuration: not reported, not
    removed. A marker inside a multi-line TOML string is the user's bytes and is
    invisible to the scan.

  Containment is the materialisation rule unchanged: every path is resolved and
  proven inside the location panda owns, a link at any depth disqualifies it, and
  a path another surviving claim holds is refused. `discard` checks the REAL
  path, so a junctioned `~/.claude` cannot land the write outside the scope its
  refusal promises. `adopt` builds its claim from the TARGET's plan of what panda
  would write — never from a directory listing — so a file a user put beside
  panda's is never swept into a record that could later authorise deleting it,
  and both ledger verbs write ONE entry through `updateEntry` rather than
  replacing a scope from a read they took earlier. A remediation panda will not
  perform is returned as a coded `PANDA_PROJECTION_REMEDIATION_REFUSED`, not
  thrown, because under inspection the refusal is part of the description.

  `runRemediation` defaults to `mode: 'inspect'` — the opposite of
  `runProjection`, and the same default `panda remediate` uses, so the
  describe-before-act guarantee is true of the SDK surface and of the command.
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

Ledger records, native-entry and drift vocabulary live in `@skanl/panda-contracts`
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
(`skippedEntryIds`, plus the target's own reason in `skipped`): a `skill` is not
expressible by a CONFIG target, and an `mcp-server` with no command has nothing
to render. A RETIRED type never reaches a target at all — `groupByKind` has no
bucket for one — so it is neither projected nor reported here; `panda doctor`
reports it against the registry document instead. Skills at PROJECT scope are
reported the same way — materialising into a project is a decision no story has
taken, so panda invents no location.
