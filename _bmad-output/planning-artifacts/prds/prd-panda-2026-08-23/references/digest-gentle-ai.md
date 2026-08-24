# Reference digest: gentle-ai (source-level)

Repo: C:\code\panda\.scratch\references\gentle-ai · Explored 2026-08-23

## 1. Shared MCP/skill projection
Install-time materialization into each CLI's native format — no symlinks, no shared runtime config. Central `Adapter` interface exposes paths (`SkillsDir`, `MCPConfigPath`, `SettingsPath`) and injection strategies (`internal/agents/interface.go:28-39`). MCP injection dispatches on `adapter.MCPStrategy()` (`internal/components/mcp/inject.go:35-54`): separate JSON per server (Claude `~/.claude/mcp/<name>.json` + user registry `~/.claude.json`, `inject.go:37-43,263-284`), deep-merge into `opencode.json` `mcp` block with `__replace__` sentinel against stale keys (`inject.go:147-194`), TOML upsert for codex `config.toml` (`inject.go:62-82`), YAML upsert for Hermes, workspace `.mcp.json` for Claude project scope. Skills walked out of Go embedded FS, written byte-for-byte per adapter `SkillsDir` (`internal/components/skills/inject.go:61-97,113-138`); per-model capability slicing via `<!-- section:model-capable -->` markers (`inject.go:127-129,165-171`). Limits: only manages its own servers; correctness rests on hand-written per-format mergers + legacy migration/cleanup code.

## 2. Per-CLI model orchestration
Canonical intent in `model.Selection`: ModelAssignments keyed by sub-agent, Claude aliases (fable|opus|sonnet|haiku), Codex phase→effort assignments, Codex "carril" tiers sdd-strong/mid/cheap (`internal/model/selection.go:13-22`). Projection: opencode overlay merged into opencode.json with decision tree TUI-wins → preserve user keys → stamp root model (`internal/components/sdd/inject.go:2694-2780`); Claude via `{{CLAUDE_MODEL}}` sentinels resolved by adapter interface (`sdd/inject.go:109-117`); Codex via three profile .config.toml files selected at runtime by `codex --profile` (`internal/components/engram/inject.go:490-501`).

## 3. Review lifecycle facade
Verbs routed in `internal/app/app.go:116-130`. Lineage ID derived not chosen: `sha256("gentle-ai.review-start-lineage/v3\0" ‖ worktreeIdentity ‖ targetIdentity)[:16]` (`internal/cli/review_start_lineage.go:41-64`) — idempotent re-start for same frozen candidate; named lineages are historical authority, never overwritten. Storage: hash-chained record store under `<git-common-dir>/gentle-ai/review-transactions/{v1,v2}/<lineage>` (`internal/reviewtransaction/store.go:107`), LOCK files with pid/host liveness. State machine unreviewed→…→approved|escalated|invalidated (`transaction.go:36-47`). Receipt minted only at terminal states; binds tree hashes + digests (`receipt.go:15-100`); published immutably per-OS.

## 4. SDD dispatcher
`sdd-status/continue` resolve state via one resolver (`internal/cli/sdd_status.go:22-81`) and emit next-step orchestrator instructions (Markdown) or contract-gated JSON v1. Artifacts from openspec files (checklist parsing) OR engram (`engram export <tmp>.json`, observations titled `sdd/<change>/<artifact>`) (`status.go:761-954`). Routing is NOT code-dispatched — dispatcher resolves state, orchestrator prompt routes.

## 5. Skills packaging
Skill = embedded dir with SKILL.md frontmatter (name/description/disable-model-invocation/user-invocable/delegate_only), copied into every selected adapter's skills dir. Cross-CLI discovery solved separately: skillregistry scans ~17 known global skill dirs and regenerates unified index `.atl/skill-registry.md` + fingerprint cache (`internal/skillregistry/registry.go:18-80`).

## 6. Engram integration
Engram registered as local MCP per strategy with args `["mcp","--tools=agent"]`. Beyond MCP: protocol injected as prompt text — HTML-comment section markers in system prompts, Jinja include for Kimi; Codex gets engram-instructions.md via `model_instructions_file` TOML (`engram/inject.go:416-563`). Protocol mandates proactive mem_save triggers, mem_context→mem_search recall chains, topic_key upsert discipline (golden-file tested).

## Design lessons for panda
- Separate WHERE (path resolution) from HOW (strategy enum) per CLI — the Adapter split is what makes N CLIs tractable
- Project via atomic idempotent merge with ownership sentinels (`__replace__`); never rewrite whole configs; migrate own legacy shapes
- Derive identity from content hashes (worktree+target) — free idempotency, collision-free resume
- Hash-chain records; gate receipts behind terminal states binding tree hashes
- Keep dispatchers dumb: resolve state, emit instructions; prompt does routing
- Prompt-injection protocols need versioned packaging with golden tests
- Cross-CLI skill registry index cheaper than forcing one canonical skills path
- Capability manifests beat boolean soup: declare features once per agent, derive SupportsX()
