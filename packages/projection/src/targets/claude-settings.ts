import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectionTarget } from '@panda/contracts'
import { createProjectionTargetFromTraits } from '../formats.ts'
import type { ProjectionTargetTraits, TraitTargetOptions } from '../formats.ts'

// Claude Code settings.json target (Story 2.2). Claude settings are STRICT
// JSON — comments and trailing commas are startup errors — expressed purely
// as trait data (`strictJson: true`) over the shared root-key splice
// strategy; all merging lives in formats.ts.

export const CLAUDE_SETTINGS_TARGET_ID = 'claude-settings'

const CLAUDE_SETTINGS_TRAITS: ProjectionTargetTraits = {
  targetId: CLAUDE_SETTINGS_TARGET_ID,
  fileFormat: 'jsonc',
  ownedRegionStrategy: 'root-key-splice',
  defaultPath: join(homedir(), '.claude', 'settings.json'),
  strictJson: true,
}

export type ClaudeSettingsTargetOptions = TraitTargetOptions

export function createClaudeSettingsTarget(options: ClaudeSettingsTargetOptions = {}): ProjectionTarget {
  return createProjectionTargetFromTraits(CLAUDE_SETTINGS_TRAITS, options)
}
