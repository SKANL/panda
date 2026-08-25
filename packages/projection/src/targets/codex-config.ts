import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectionTarget } from '@panda/contracts'
import { createProjectionTargetFromTraits } from '../formats.ts'
import type { ProjectionTargetTraits, TraitTargetOptions } from '../formats.ts'

// Codex config.toml target. Codex config is TOML, so ownership is the shared
// delimited comment block strategy: one panda-managed region at EOF,
// replaced wholesale on every projection — foreign TOML is never parsed.
//
// Design-Notes escape hatch (spec 2.3): because the strategy never parses
// foreign TOML, MALFORMED-TOML isolation is deliberately out of scope — a
// syntactically broken foreign file is undetectable here and drift doctor
// owns anomaly reporting later. The clause suite's
// `supportsMalformedIsolation: false` for this target is intentional, not a
// gap.

export const CODEX_CONFIG_TARGET_ID = 'codex-config'

const CODEX_CONFIG_TRAITS: ProjectionTargetTraits = {
  targetId: CODEX_CONFIG_TARGET_ID,
  fileFormat: 'toml',
  ownedRegionStrategy: 'delimited-block',
  defaultPath: join(homedir(), '.codex', 'config.toml'),
}

export type CodexConfigTargetOptions = TraitTargetOptions

export function createCodexConfigTarget(options: CodexConfigTargetOptions = {}): ProjectionTarget {
  return createProjectionTargetFromTraits(CODEX_CONFIG_TRAITS, options)
}
