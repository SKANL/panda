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

This story covers MCP servers, the one concept all three executors express
natively. Skills (filesystem materialisation) and entries no target can express
are Stories 2.9 and 2.10; until then they are reported through
`skippedEntryIds`.
