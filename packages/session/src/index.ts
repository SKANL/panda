export { runSession, SESSION_ACTION_COST, SESSION_ACTION_ID, type SessionOptions } from './run-session.ts'

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
