# Reference digest: orca (source-level)

Repo: C:\code\panda\.scratch\references\orca · Explored 2026-08-23

## 1. Parallel worktrees
Location convention: `<workspaceRoot>/<repoName>/<name>` when nesting enabled, else flat (`src/main/ipc/worktree-logic.ts:101-114`). WSL repos force worktrees onto Linux FS under `~/orca/workspaces` to avoid cross-FS I/O (`worktree-logic.ts:91-100`). Naming: curated name pool with tiered suffixing; retired names NEVER reused — over-retiring costs one name but under-retiring reissues a path with existing agent history (`src/shared/worktree-name-suggestion.ts:47-62`, `src/main/worktree-retirement-discovery.ts:13-27`). Ownership: worktree counts as managed only if strong metadata proves it (orcaCreatedAt etc., `src/shared/worktree/ownership.ts:120-122,227-238`); everything else external/agent-scratch/unknown-legacy; plain git-worktree-add inside Orca's folder NOT trusted. Branch naming `${prefix}/${sanitizedName}` with check-ref-format early validation. Creation via single contract IGitProvider.addWorktree(repoPath, branchName, targetDir, {base, checkoutExistingBranch, noCheckout}) (`git-provider-contract.ts:76-81`). Cleanup: clean preflight then rename-to-trash hidden sibling `.orca-worktree-trash/wt-<epoch>-<nonce>` so IPC returns instantly, background serialized deletion + startup sweep of crash leftovers (`worktree-trash.ts:1-58,99-133`); branch cleanup deletes merged only, force-delete fenced on expectedHead; orphan detection proves dead dir via linked gitdir file.

## 2. Agent executors
No class hierarchy: union type TuiAgent (~39 CLIs) + declarative config table TUI_AGENT_CONFIG (`src/shared/tui-agent-config.ts:20-51`): detectCmd/aliases, launchCmd (+per-platform overrides), expectedProcess, promptInjectionMode ('argv'|'flag-prompt'|'stdin-after-start'|...) — how task text reaches each TUI safely. Quirks as config: draftPromptFlag (Claude --prefill), argvPromptSeparator '--', composer-ready signals, trust preflights, Windows CSI-u encodings. Flags/models per-vendor session-option catalogs resolved into launch argv; default args/env table; YOLO permission presets.

## 3. SSH worktrees
Transport duality: embedded ssh2 + system-ssh fallback; host-key verification with known-hosts store. Remote execution via versioned Node relay bundle deployed to the box (content-hashed install dirs, staged uploads, install locks) multiplexing PTY/SFTP/git/hook channels over one connection. Same contracts different impls: SshGitProvider implements IGitProvider routing mux.request('git.addWorktree'); file editing SFTP namespace provider; terminals relay-hosted PTYs reattached by incarnation IDs. Reconnect: backoff ladder with 60s stability reset, flap delay capped so retry lands inside remote relay's grace period (else relay shuts down killing all remote PTYs). Port forwarding manager with ssh2 and system-ssh -L providers.

## 4. Usage tracking & account switching
Claude rate limits: OAuth call api.anthropic.com/api/oauth/usage with bearer from Keychain/credentials.json + proactive refresh; hidden-PTY /status parse fallback. Codex: read-only non-interactive `codex app-server` newline-delimited JSON-RPC {rateLimits:{primary,secondary}}; per-account CODEX_HOME with cross-process lock so probes don't fight live CLI. Historical usage/cost: local scan of transcript JSONL/session files attributed per-worktree by cwd path mapping, priced via model tables. Hot-swap without re-login: enroll captures each account's credentials (Keychain snapshot / auth.json copy); switching materializes selected account's auth store and patches spawn env (CLAUDE_CONFIG_DIR per account WSL-aware, CODEX_HOME export); deselect restores snapshotted default; probes async so switching never blocks.

## 5. Session/output handling
Agents are interactive TUIs in real PTYs behind one IPtyProvider interface (spawn/write/resize, onData/onExit, buffer snapshots for restore, producer backpressure). Structured completion/idle from MANAGED HOOKS not screen scraping: installs hook/plugin entries into each CLI's settings POSTing lifecycle events (Stop, SubagentStop, sessionEnd) to an HTTP listener; same pipeline inside SSH relay. Residual PTY heuristics for agents without hooks: foreground-process scanning, title/spinner scanners, shell readiness markers.

## Design lessons for panda
- Make WorkspaceProvider contract wide enough that SSH is just another implementation of the SAME interface (IGitProvider/IPtyProvider parity makes remotes feel native)
- Prove ownership with durable metadata, never path heuristics — unproven = external
- Retire used workspace names permanently; sweep crash leftovers at startup (trash-rename + pattern sweep)
- Model executor differences as DATA (prompt-injection mode, ready signals, flags catalog), not subclasses — new CLI = config entry + hook adapter
- Read quota state from official surfaces (OAuth usage endpoint, app-server RPC) with PTY-parse fallback; keep probes off the switch-critical path
- Account hot-swap = snapshot credentials per account + env-dir patch at spawn (CLAUDE_CONFIG_DIR/CODEX_HOME), never re-login
- Capture agent state via installed hooks/events first; PTY scraping strictly as fallback
- Design reconnect around the remote's lifetime budget: cap retry delays to beat remote supervisor grace period; sessions resumable by incarnation ID
