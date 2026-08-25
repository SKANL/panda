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
