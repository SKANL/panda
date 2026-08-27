export { runProjection, groupByKind, hasFileChangedSince, resolveProjectionMode } from './engine.ts'
export type {
  NativeFileSnapshot,
  ProjectionMode,
  ProjectionRun,
  RunProjectionOptions,
} from './engine.ts'
export { runRemediation } from './remediate.ts'
export type {
  AdoptRemediationOptions,
  DiscardRemediationOptions,
  LegacyBlockLocation,
  ReleaseRemediationOptions,
  RepairRemediationOptions,
  RunRemediationOptions,
} from './remediate.ts'
export { ProjectionLedger, hashOwnedBytes, hashOwnedText, resolveOwnedPath, sameOwnedPath } from './ledger.ts'
export type {
  ProjectionLedgerOptions,
  ProjectionLedgerRead,
  ProjectionLedgerScope,
  ProjectionLedgerState,
} from './ledger.ts'
export { createProjectionTargetFromTraits, scanLegacyPandaBlock } from './formats.ts'
export type {
  FileFormat,
  LegacyPandaBlock,
  LegacyPandaScan,
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
export {
  CLAUDE_SKILLS_TARGET_ID,
  CLAUDE_SKILLS_TRAITS,
  CODEX_SKILLS_TARGET_ID,
  CODEX_SKILLS_TRAITS,
  OPENCODE_SKILLS_TARGET_ID,
  OPENCODE_SKILLS_TRAITS,
  SKILL_ENTRY_FILE,
  createClaudeSkillsTarget,
  createCodexSkillsTarget,
  createOpenCodeSkillsTarget,
  createSkillsTargetFromTraits,
} from './targets/skills.ts'
export type { SkillsTargetOptions, SkillsTargetTraits } from './targets/skills.ts'
