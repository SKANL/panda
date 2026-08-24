# Reference digest: terax-ai (source-level)

Repo: C:\code\panda\.scratch\references\terax-ai · Explored 2026-08-23

## 1. Coding-agent orchestration (Claude Code in a terminal)
Drives the real TUI inside a PTY pane — no SDK/API coupling. PTY layer Rust `portable_pty`: `pty/session.rs:102` spawn() master/slave pair, shell command via `shell_init::build_command` (`session.rs:127`), reader/flusher threads with 4ms coalescing + 4MiB backpressure cap; Windows Job Object kill-on-close + ConPTY lifecycle mutex (`session.rs:33-77`). Writes via `pty_write` raw bytes with `x-pty-id` header (`src/modules/terminal/lib/pty-bridge.ts:59-64`).
Agent detection: pure OSC parser in PTY reader thread — arms on OSC 133;C matching known agent command names (`pty/agent_detect.rs:244-259`), status from OSC 777 `notify;Terax;<agent>;<event>` (`agent_detect.rs:163-199`), emits started/working/attention/finished/exited signals.
Hook injection: writes hooks into each agent's own config (`.claude/settings.json`, `.codex/hooks.json`, `.gemini/settings.json`) via idempotent merge + atomic write (`modules/agent.rs:166-193,232-288`); Claude uses terminalSequence JSON, Codex/Gemini write raw OSC to /dev/tty (Windows: `terax.exe __terax_notify` → CONOUT$).
Spawn flow: side-panel tool spawn_coding_agent → new agent tab → enable hooks → write `"claude\r"` → poll xterm buffer until TUI renders → paste prompt inside bracketed-paste markers `\x1b[200~…\x1b[201~` → `\r` after 120ms. Follow-ups: type instruction into leaf PTY, Enter as separate chunk after 90ms (CR quirk). Output inspection = last N lines of xterm buffer, redacted before reaching the model. Session state machine spawning→working→reviewing→done in `agents/store/managedAgentsStore.ts:5-18`.

## 2. Agentic side panel
Vercel AI SDK streamText loop with tools, step-count stop, context compaction before each run (`ai/lib/agent.ts:406-468`). Providers: OpenAI/Anthropic/Google/xAI/Cerebras/DeepSeek/Mistral/Groq/OpenRouter/OpenAI-compatible/LM Studio/MLX/Ollama. Tools (`ai/tools/tools.ts:31-42`): fs read/write/edit/multi_edit, grep/glob, shell, subagents, todos, managed-agent tools. Approval gating: tool defs set needsApproval:true for mutating tools (`tools/shell.ts:39,76`); stream pauses, approval-requested card rendered; independent second guard checkShellCommand static safety analysis pre-execution. Plan mode swaps to queued-diff mutations.

## 3. TERAX.md
Read per send capped 32KB + 30s mtime cache (`ai/lib/transport.ts:9-34`), injected as stable system block; written by /init slash command through normal approval, capped 200 lines.

## 4. Custom agents
Personas not tool subsets: {id,name,description,instructions,icon} in LazyStore; persona injected as system prompt section. Tool-subset restriction only for built-in SUBAGENTS registry (read-only whitelist).

## 5. Workspace/environment & spaces
Per-tab env WorkspaceEnv = Local | Wsl{distro}; every pty_open passes currentWorkspaceEnv(); WSL paths resolved to \\wsl.localhost\<distro>\...; shell sessions keyed cwd per sessionId:wsl:<distro>. Spaces serialize tabs to JSON (pane tree, per-leaf cwd); restore hydrates cold tabs, PTYs lazy-spawn on visibility.

## Extraction boundary for panda
Reusable near-as-is: PTY session/detector/hook-injection trio, OSC contract (133 + 777 notify), bracketed-paste TUI driving, approval-card UX, TERAX.md-style memory loader, spaces serialization. Brain swap: replace runAgentStream behind ToolContext interface (`tools/context.ts`) with panda ExecutorAdapter; needsApproval flags map onto kernel approval gates; WorkspaceEnv maps onto WorkspaceProvider.

## Design lessons for panda
- Drive CLIs through their real TUI in a PTY: bracketed paste + separate-Enter chunking; passive OSC detection, never screen-scrape state
- Agent liveness via hooks injected into each CLI's native config (idempotent merge, atomic write, ownership markers)
- Two-layer safety: declarative needsApproval per tool + independent static command-safety checker
- Output inspection = capped buffer tail with secret redaction before it reaches any model
- Keep the brain behind one narrow context interface so kernels are swappable
- Env is a first-class spawn parameter (Local|WSL per tab) threaded into every PTY/shell/path resolution
- Persist layout as serializable cold tabs; lazy-spawn processes on activation
