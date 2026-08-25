import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectionTarget } from '@panda/contracts'
import { createProjectionTargetFromTraits } from '../formats.ts'
import type { ProjectionTargetTraits, TraitTargetOptions } from '../formats.ts'

// OpenCode config target.
//
// `mcp.<id>` in opencode.json, shape `{type:'local', command: string[]}`.
// OpenCode's `command` IS the argv — there is no `args` field — so the split
// panda keeps internally is joined here and nowhere else. opencode.json is
// JSONC-tolerant (comments and trailing commas are legal), so it reuses the
// shared splice WITHOUT the strict-JSON guard.

export const OPENCODE_CONFIG_TARGET_ID = 'opencode-config'

export const OPENCODE_CONFIG_TRAITS: ProjectionTargetTraits = {
  targetId: OPENCODE_CONFIG_TARGET_ID,
  fileFormat: 'jsonc',
  defaultPath: join(homedir(), '.config', 'opencode', 'opencode.json'),
  mcpContainerKey: 'mcp',
  renderMcpEntry: (entry) => ({ type: 'local', command: [entry.command, ...entry.args] }),
}

export type OpenCodeConfigTargetOptions = TraitTargetOptions

export function createOpenCodeConfigTarget(options: OpenCodeConfigTargetOptions = {}): ProjectionTarget {
  return createProjectionTargetFromTraits(OPENCODE_CONFIG_TRAITS, options)
}
