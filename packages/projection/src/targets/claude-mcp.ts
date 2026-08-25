import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectionTarget } from '@panda/contracts'
import { createProjectionTargetFromTraits } from '../formats.ts'
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
}

export type ClaudeMcpTargetOptions = TraitTargetOptions

export function createClaudeMcpTarget(options: ClaudeMcpTargetOptions = {}): ProjectionTarget {
  return createProjectionTargetFromTraits(CLAUDE_MCP_TRAITS, options)
}
