export { acquireLock } from './lock.ts'
export type { LockHolder, LockOptions, RegistryLock, StaleLockBreak } from './lock.ts'
export { RegistryStore } from './store.ts'
export type { RegistryStoreOptions } from './store.ts'
export { IngestWriteFailure, ingestProviders } from './ingest.ts'
export type { IngestProvidersOptions } from './ingest.ts'
export { BUNDLE_KIND, BUNDLE_VERSION, OMITTED_FIELDS, createBundle, isCredential, parseBundle, readBundle, serializeBundle, writeBundle } from './bundle.ts'
export type { OmittedEntry, OmittedField, RegistryBundle } from './bundle.ts'
export { createRegistryPlugin } from './plugin.ts'
export type { RegistryPlugin, RegistryPluginOptions } from './plugin.ts'
export { MACHINE_SKILLS_SOURCE_ID, createMachineSkillsSource } from './skills-source.ts'
export type { MachineSkillsSource, SkillsSourceOptions, SkillsSourceWarning } from './skills-source.ts'
export { MACHINE_MCP_SOURCE_ID, createMachineMcpSource } from './mcp-source.ts'
// Exactly what `@panda/environment` names when it wires and reports this
// source. `McpSourceEntry`, `McpSourceOptions` and `McpSourceReading` are
// satisfied structurally at the call site and need no export.
export type {
  MachineMcpSource,
  McpSourceDropped,
  McpSourceExclusion,
  McpSourceLocation,
  McpSourceOwnedEntry,
  McpSourceWarning,
} from './mcp-source.ts'
