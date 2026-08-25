export { runProjection, groupByKind, hasFileChangedSince } from './engine.ts'
export type {
  NativeFileSnapshot,
  ProjectionRun,
  RunProjectionOptions,
} from './engine.ts'
export { atomicWriteText } from './atomic-write.ts'
export { renderOwnedSubtree } from './owned-subtree.ts'
export { createClaudeSettingsTarget, CLAUDE_SETTINGS_TARGET_ID } from './targets/claude-settings.ts'
export type { ClaudeSettingsTargetOptions } from './targets/claude-settings.ts'
