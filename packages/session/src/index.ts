export { runSession, SESSION_ACTION_COST, SESSION_ACTION_ID, type SessionOptions } from './run-session.ts'
// The selection, beside the run it feeds (FR-29). A consumer that imports this
// package gets BOTH halves of `panda run` — which executor, and the session —
// without `@panda/cli`. `ExecutorSelection.available` carries the id list, so
// nothing else of the catalogue has to be on the surface to print alternatives.
export {
  resolveExecutor,
  type ExecutorSelection,
  type ResolveExecutorOptions,
} from './executors.ts'
// `SessionOptions.adapterOptions` is on the surface, so its vocabulary has to be
// too — the same rule the block below states: under pnpm's strict layout a
// consumer that installed only `@panda/session` cannot resolve
// `@panda/adapter-cli`, so a seam whose type it cannot name is a seam it cannot
// use. This is exactly what a host needs to point panda at a binary off PATH, or
// to drive the three shipped adapters against a spawner of its own.
export type {
  ChildProcessSpawner,
  CliExecutorAdapterOptions,
  SpawnedChild,
  SpawnOptions,
  SpawnOutcome,
} from '@panda/adapter-cli'

// Re-exported, not merely referenced. Under pnpm's strict layout a consumer that
// installed `@panda/session` cannot resolve `@panda/contracts` or `@panda/kernel`
// unless it declares them too — so a surface that hands back a `ResultEnvelope`
// and takes an `ExecutorAdapter` has to hand back the types as well, or the SDK
// promise is only true for this monorepo. The list is the seams' vocabulary and
// nothing else: what you need to READ a result, IMPLEMENT either seam, or set a
// budget and read its trail.
export type {
  ExecutorAdapter,
  ResultEnvelope,
  RunRequest,
  WorkspaceHandle,
  WorkspaceProvider,
} from '@panda/contracts'
export { createMemoryLogSink } from '@panda/kernel'
export type { ActionPolicy, LogRecord, LogSink, MemoryLogSink } from '@panda/kernel'
