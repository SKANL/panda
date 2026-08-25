import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectionTarget } from '@panda/contracts'
import { createProjectionTargetFromTraits } from '../formats.ts'
import type { ProjectionTargetTraits, TraitTargetOptions } from '../formats.ts'

// OpenCode config target. opencode.json is JSONC-tolerant (comments and
// trailing commas are legal), so it reuses the shared root-key splice
// strategy WITHOUT the strict-JSON guard — expressed purely as trait data.

export const OPENCODE_CONFIG_TARGET_ID = 'opencode-config'

const OPENCODE_CONFIG_TRAITS: ProjectionTargetTraits = {
  targetId: OPENCODE_CONFIG_TARGET_ID,
  fileFormat: 'jsonc',
  ownedRegionStrategy: 'root-key-splice',
  defaultPath: join(homedir(), '.config', 'opencode', 'opencode.json'),
}

export type OpenCodeConfigTargetOptions = TraitTargetOptions

export function createOpenCodeConfigTarget(options: OpenCodeConfigTargetOptions = {}): ProjectionTarget {
  return createProjectionTargetFromTraits(OPENCODE_CONFIG_TRAITS, options)
}
