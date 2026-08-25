export { runProjection, groupByKind, hasFileChangedSince } from './engine.ts'
export type {
  NativeFileSnapshot,
  ProjectionRun,
  RunProjectionOptions,
} from './engine.ts'
export { atomicWriteText } from './atomic-write.ts'
export { renderOwnedSubtree } from './owned-subtree.ts'
export {
  createProjectionTargetFromTraits,
  mergeDelimitedBlockRegion,
  spliceRootKeyRegion,
} from './formats.ts'
export type {
  FileFormat,
  OwnedRegionStrategyId,
  ProjectionTargetTraits,
  TraitTargetOptions,
} from './formats.ts'
export { createClaudeSettingsTarget, CLAUDE_SETTINGS_TARGET_ID } from './targets/claude-settings.ts'
export type { ClaudeSettingsTargetOptions } from './targets/claude-settings.ts'
export { createCodexConfigTarget, CODEX_CONFIG_TARGET_ID } from './targets/codex-config.ts'
export type { CodexConfigTargetOptions } from './targets/codex-config.ts'
export { createOpenCodeConfigTarget, OPENCODE_CONFIG_TARGET_ID } from './targets/opencode-config.ts'
export type { OpenCodeConfigTargetOptions } from './targets/opencode-config.ts'
