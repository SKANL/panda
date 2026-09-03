export { runProjection, groupByKind, hasFileChangedSince, resolveProjectionMode } from './engine.ts'
export type {
  NativeFileSnapshot,
  ProjectionMode,
  ProjectionRun,
  RunProjectionOptions,
} from './engine.ts'
// `atomicWriteText` is deliberately NOT here. A previous story un-exported it so
// `@panda/environment` could not reach it, and `packages/environment/test/guard.test.ts`
// is the clause that notices if it comes back — the ledger is the sole authority
// for what panda writes into a vendor's file. Panda's OWN configuration document
// is a different thing and needs the same symlink-resolving write, so the WRITER
// lives here, beside the primitive, and only the writer is published.
export {
  WRITABLE_CONFIG_KEYS,
  configPathFor,
  setConfigValue,
  type ConfigWriteOptions,
  type ConfigWriteResult,
  type WritableConfigKey,
} from './config-write.ts'
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
export { createProjectionTargetFromTraits, readNativeMcpEntries, scanLegacyPandaBlock } from './formats.ts'
// `readNativeCommand`, `renderedKeys` and the entry-level result types are
// deliberately NOT here: the targets that use them live in this package, and an
// export with no consumer outside it is surface the FR-29 proof pays for.
export type {
  FileFormat,
  LegacyPandaBlock,
  LegacyPandaScan,
  NativeEntryShape,
  NativeMcpRead,
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
