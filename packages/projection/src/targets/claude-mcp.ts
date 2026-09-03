import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectionConfigTarget } from '@panda/contracts'
import { createProjectionTargetFromTraits, readNativeCommand } from '../formats.ts'
import type { ProjectionTargetTraits, TraitTargetOptions } from '../formats.ts'

// Claude Code MCP target.
//
// Verified against Claude Code itself: `settings.json` has NO `mcpServers` key
// — the reason the previous build's output was inert. User-scope MCP servers
// live in `~/.claude.json`; project scope is the SAME `{mcpServers: {...}}`
// shape in `<project>/.mcp.json`, so it is this trait record with an injected
// filePath, not a second target.
//
// `~/.claude.json` is Claude's own state file, so panda touches nothing in it
// but the `mcpServers` key. It is strict JSON, expressed as trait data.

export const CLAUDE_MCP_TARGET_ID = 'claude-mcp'

export const CLAUDE_MCP_TRAITS: ProjectionTargetTraits = {
  targetId: CLAUDE_MCP_TARGET_ID,
  fileFormat: 'jsonc',
  defaultPath: join(homedir(), '.claude.json'),
  strictJson: true,
  mcpContainerKey: 'mcpServers',
  renderMcpEntry: (entry) => ({ type: 'stdio', command: entry.command, args: entry.args }),
  // The inverse, beside the renderer it inverts. A `type` other than `stdio` is
  // a server with no command at all — an HTTP or SSE entry carries a `url` —
  // and panda says so instead of inventing one. Which keys count as CONSUMED is
  // not spelled here: the reader derives that from `renderMcpEntry` above, so a
  // key added to the renderer cannot be reported to a user as dropped.
  readMcpEntry: (native) =>
    native['type'] !== undefined && native['type'] !== 'stdio'
      ? {
          ok: false,
          detail: `its 'type' is ${JSON.stringify(native['type'])} rather than 'stdio', and panda projects a command with arguments`,
        }
      : readNativeCommand(native),
}

export type ClaudeMcpTargetOptions = TraitTargetOptions

export function createClaudeMcpTarget(options: ClaudeMcpTargetOptions = {}): ProjectionConfigTarget {
  return createProjectionTargetFromTraits(CLAUDE_MCP_TRAITS, options)
}
