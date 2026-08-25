---
name: 'Correction 01 — Native-vocabulary projection'
type: architecture-correction
status: adopted
created: '2026-08-25'
amends: [AD-4, AD-6, AD-9, 'Consistency Conventions › Liveness detection', 'Capability Map › F3']
supersedes_implementation_of: [FR-12, FR-13]
evidence: 'empirical verification against installed claude-code, codex-cli 0.149.1, opencode'
sources:
  - ARCHITECTURE-SPINE.md
  - implementation-artifacts/spec-2-2-projection-engine-with-sentinel-grammar-claude-target.md
  - implementation-artifacts/spec-2-3-codex-and-opencode-targets-via-trait-data.md
  - implementation-artifacts/spec-2-6-liveness-detection-hierarchy.md
---

# Correction 01 — Projection must speak native vocabulary at native locations

## Why this document exists

Stories 2.2 through 2.5 shipped a projection engine that is **correct in its mechanics and inert in its effect**. Every acceptance criterion passed, every clause suite was green, byte-for-byte foreign preservation was proven — and not one byte panda writes is read by any executor.

This was not caught by the tests because the acceptance criteria were written in **panda's own vocabulary** ("the projected tools appear in the native config") and never pinned the only thing that matters: that the native CLI **reads** them.

## Evidence

Verified by reading each CLI's own configuration schema AND by running the installed binaries.

| Executor | What panda writes | What the executor actually reads | Result |
|---|---|---|---|
| Claude Code | `$.panda.{tools,mcpServers,skills,hooks}` in `~/.claude/settings.json` | `settings.json` has NO `mcpServers`/`tools`/`skills` key. MCP servers come from `~/.claude.json` / `.mcp.json`. Skills are directories `~/.claude/skills/<name>/SKILL.md`. Hooks are the TOP-LEVEL `hooks` key. | **Inert.** Unknown key tolerated; nothing reaches MCP, skills or hooks. |
| OpenCode | `$.panda.{…}` in `opencode.json` | `mcp:{<id>:{type:'local', command:string[]…}}` — `command` is argv, there is NO `args` field. `tools` is `Record<string,boolean>` and cannot DEFINE a tool. `skills:{paths,urls}` is a folder list. No hooks key at all — lifecycle interception is plugin-only. | **Inert.** Dropped at decode (`onExcessProperty: 'ignore'`). |
| Codex | `[tools.<id>]`, `[skills.<id>]`, `[mcpServers.<id>]` inside the managed block in `config.toml` | `[tools]` is a REAL fixed struct (`web_search`, …). `[skills]` is a REAL struct. The MCP key is **`mcp_servers`** (snake_case). | **Inert by default, HARMFUL under `--strict-config`:** panda writes foreign sub-keys into two vendor-owned tables, so a documented, shipped flag makes the user's ENTIRE `config.toml` fail to load — blast radius the whole file, not panda's block. |

## Decisions

### C1 — Projection renders native vocabulary at native locations

A projection target's job is to make the registry's intent **true in the executor's own terms**. Panda's vocabulary is the canonical INPUT; it is never the output format. A target that writes panda-shaped data into a vendor file has not projected anything — it has decorated the file.

Panda MUST NOT claim a reserved namespace inside a vendor's configuration as the delivery mechanism. The reserved-root-key design was an implementation reading of AD-9 that AD-9 never required: AD-9 says contracts owns a sentinel grammar and that targets implement **per-format encodings of that grammar**. Encoding a grammar is not the same as inventing a vocabulary.

### C2 — Ownership is a durable panda-side record, not a marker inside vendor files

AD-6 already governs this and was not applied to projection: *"Ownership is proven by durable metadata records written at creation — never inferred from paths."*

Panda keeps its own **projection ledger** in panda's own directory, recording for every entry it wrote: the target file, the native location, and a content hash of what panda placed there. Consequences:

- Ownership survives formats that cannot carry a sentinel (a JSON array entry, a directory of files) and formats where an unknown field is a validation error.
- Drift is a comparison between the ledger and what is on disk — richer than a marker, because it distinguishes *edited*, *removed by the user*, and *never written*.
- Foreign content stays byte-for-byte untouched, because panda no longer needs to inject anything of its own to recognise its work later.
- Nothing panda writes can be rejected by a vendor's schema validation for being unknown, because panda only ever writes shapes the vendor defines.

Comment-based sentinels remain permitted where a format supports them (TOML) as a courtesy to humans reading the file. They are legibility, never authority.

### C3 — Vendor-strictest-mode safety is a hard requirement

Whatever panda writes MUST survive the vendor's most pedantic validation mode, not merely its default. Codex's `--strict-config` is the proof case: tolerance by default is not tolerance. A projection that only works when the user does not use a documented flag is a latent outage panda inflicted on them.

**Panda never writes an unknown key into a vendor-owned structure.** If a concept has no native representation, panda does not invent one — see C5.

### C4 — ProjectionTarget covers materialisation, not only config merging

Skills in both Claude Code and Codex are **directory trees** (`<root>/skills/<name>/SKILL.md`), not config entries. OpenCode's skills are a list of folder paths. The current port models only "surgically merge a region of a text file", which cannot express any of that.

The port grows a second materialisation kind: **filesystem tree**. Both kinds keep the properties that made the config-merge path trustworthy — atomic writes, idempotence, foreign content untouched, per-target failure isolation — and both are governed by the same ledger from C2.

### C5 — A concept with no native representation is reported, never faked

Claude Code has no notion of "a tool that is a shell command"; the nearest native homes are an MCP stdio server or a skill. OpenCode cannot define a tool at all. Codex has no custom-tool concept.

When the registry holds an entry a target cannot express natively, the target reports it as **unprojectable, naming the entry and the reason**. It does not write a best-effort approximation into a namespace nobody reads. The existing per-target `skippedEntryIds` channel is the right shape; what changes is that skipping becomes a *reported product fact* surfaced by `panda doctor`, not an internal detail.

### C6 — Remediation obligation for already-written blocks

Any panda build that already wrote a `$.panda` key or a `# BEGIN panda-managed` block into a user's file created state that the corrected build must clean up. Removal of panda's own prior output is part of this correction, not a later nicety — the Codex case is actively harmful and must not be left behind on any machine that ran a previous build.

## Consequences

**Invalidated:** the rendering half of Stories 2.2, 2.3 and 2.6 — the owned-subtree vocabulary, the reserved root key, the `# BEGIN panda-managed` block as a delivery mechanism, and the grammar version bump that was made to carry hooks.

**Retained, and worth retaining:** the surgical offset-based JSONC splice (byte preservation by construction), the atomic write path, per-target failure isolation, the clause-suite discipline, the trait-table dispatch, and the liveness vocabulary/port/sequencer/clause-suite from 2.6. The machinery was never the problem; its output was.

**Newly required, per target, from the verified schemas:**

| Concept | Claude Code | OpenCode | Codex |
|---|---|---|---|
| MCP server | `mcpServers.<id>` in `~/.claude.json` / `.mcp.json` — `{type:'stdio', command, args, env}` | `mcp.<id>` in `opencode.json` — `{type:'local', command: string[], environment?, enabled?}` | `[mcp_servers.<id>]` in `config.toml` — `command`, `args`, `env` |
| Skill | directory `~/.claude/skills/<id>/SKILL.md` | directory + `skills.paths[]` | directory `~/.codex/skills/<id>/SKILL.md`, optional `[skills] config=[{path,enabled}]` |
| Tool (shell command) | no native concept — report unprojectable, or express as MCP stdio | no native concept (`tools` is a boolean map) — report unprojectable | no native concept — report unprojectable |
| Hook | top-level `hooks.<Event>[].hooks[]` — `{type:'command', command, shell?: 'bash'\|'powershell', timeout?, async?}` | none — plugin-only; liveness declares unsupported | `[hooks]` — `<Event> = [{matcher?, hooks:[{type='command', command, commandWindows?, timeout?, async?}]}]`; note hook trust exists |

Two details worth carrying into implementation: Claude's per-platform knob is `shell: bash|powershell` while Codex's is a separate `commandWindows` field — a real per-target difference, and therefore trait data. Codex hooks are subject to a trust mechanism (`trusted_hash`, `--dangerously-bypass-hook-trust`) that panda must surface rather than work around.

## What this changes about how acceptance criteria are written

The failure that produced this document was a *testing philosophy* failure, not a coding one. Every criterion was satisfiable without the feature working.

From here, any story that writes into a surface owned by an external tool carries at least one criterion phrased in **the external tool's terms**, verifiable against that tool's published schema or its own source — not in panda's. Where the tool can be run, the criterion says what running it must show.
