export { runProjection, groupByKind, hasFileChangedSince } from './engine.ts'
export type {
  NativeFileSnapshot,
  ProjectionRun,
  RunProjectionOptions,
} from './engine.ts'
export { ProjectionLedger, hashOwnedText, resolveOwnedPath, sameOwnedPath } from './ledger.ts'
export type {
  ProjectionLedgerOptions,
  ProjectionLedgerRead,
  ProjectionLedgerScope,
  ProjectionLedgerState,
} from './ledger.ts'
export { createProjectionTargetFromTraits } from './formats.ts'
export type {
  FileFormat,
  NativeEntryShape,
  ProjectionTargetTraits,
  TraitTargetOptions,
} from './formats.ts'
export { createClaudeMcpTarget, CLAUDE_MCP_TARGET_ID, CLAUDE_MCP_TRAITS } from './targets/claude-mcp.ts'
export type { ClaudeMcpTargetOptions } from './targets/claude-mcp.ts'
export { createCodexConfigTarget, CODEX_CONFIG_TARGET_ID, CODEX_CONFIG_TRAITS } from './targets/codex-config.ts'
export type { CodexConfigTargetOptions } from './targets/codex-config.ts'
export {
  createOpenCodeConfigTarget,
  OPENCODE_CONFIG_TARGET_ID,
  OPENCODE_CONFIG_TRAITS,
} from './targets/opencode-config.ts'
export type { OpenCodeConfigTargetOptions } from './targets/opencode-config.ts'
