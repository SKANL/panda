import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectionConfigTarget } from '@skanl/panda-contracts'
import { createProjectionTargetFromTraits, readNativeCommand } from '../formats.ts'
import type { ProjectionTargetTraits, TraitTargetOptions } from '../formats.ts'

// Codex config.toml target.
//
// The key is `mcp_servers` — snake_case, the name `ConfigToml` actually
// declares. The previous build wrote `[mcpServers.<id>]` plus foreign sub-keys
// into `[tools]` and `[skills]`, which are REAL fixed structs; under the
// documented `--strict-config` flag that made the user's entire config.toml
// fail to load. Panda now emits only `command`/`args` inside a table Codex
// owns, so strict mode has nothing to reject.

export const CODEX_CONFIG_TARGET_ID = 'codex-config'

export const CODEX_CONFIG_TRAITS: ProjectionTargetTraits = {
  targetId: CODEX_CONFIG_TARGET_ID,
  fileFormat: 'toml',
  defaultPath: join(homedir(), '.codex', 'config.toml'),
  mcpContainerKey: 'mcp_servers',
  renderMcpEntry: (entry) => ({ command: entry.command, args: entry.args }),
  // The inverse, beside the renderer it inverts. Codex's table carries no
  // discriminator, so the reading is the shared one; anything else a user put in
  // the table (`env`, `startup_timeout_sec`) is reported as dropped rather than
  // silently discarded, against the key set the renderer above emits.
  readMcpEntry: (native) => readNativeCommand(native),
}

export type CodexConfigTargetOptions = TraitTargetOptions

export function createCodexConfigTarget(options: CodexConfigTargetOptions = {}): ProjectionConfigTarget {
  return createProjectionTargetFromTraits(CODEX_CONFIG_TRAITS, options)
}
