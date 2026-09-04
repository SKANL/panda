export { createCliExecutorAdapter } from './traits.ts'
export type {
  AdapterTiming,
  CliExecutorAdapter,
  CliExecutorAdapterOptions,
  ExecutorOutputTraits,
  ExecutorTraits,
  PathMatch,
  PayloadShape,
  PromptDelivery,
  UsageWindowTraits,
} from './traits.ts'
export { CLAUDE_CODE_TRAITS, createClaudeCodeAdapter } from './executors/claude-code.ts'
export { CODEX_TRAITS, createCodexAdapter } from './executors/codex.ts'
export { OPENCODE_TRAITS, createOpenCodeAdapter } from './executors/opencode.ts'
export { createNodeChildSpawner, routesThroughCmdShim } from './node-child-spawner.ts'
export type {
  ChildProcessSpawner,
  SpawnedChild,
  SpawnOptions,
  SpawnOutcome,
} from './spawn-seam.ts'
export {
  DEFAULT_EXECUTOR_ID,
  EXECUTOR_CATALOGUE,
  availableExecutorIds,
  createExecutorAdapter,
  unknownExecutor,
  type ShippedExecutor,
} from './catalogue.ts'
export {
  DEFAULT_EXECUTOR_ACTION_COST,
  EXECUTOR_CONFIG_KEY,
  EXECUTOR_PLUGIN_ID,
  EXECUTOR_SERVICE,
  createExecutorPlugin,
  type ExecutorPlugin,
  type ExecutorPluginOptions,
  type ExecutorService,
} from './plugin.ts'
