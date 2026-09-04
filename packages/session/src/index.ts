export {
  createSessionKernel,
  runSession,
  SESSION_ACTION_COST,
  SESSION_ACTION_ID,
  type SessionKernelOptions,
  type SessionOptions,
} from './run-session.ts'
// The selection, beside the run it feeds (FR-29). A consumer that imports this
// package gets BOTH halves of `panda run` — which executor, and the session —
// without `@panda/cli`. `ExecutorSelection.available` carries the id list, so
// nothing else of the catalogue has to be on the surface to print alternatives.
export {
  resolveExecutor,
  readExecutorConfigLayers,
  type ExecutorConfigDocument,
  type ExecutorConfigLayers,
  type ExecutorSelection,
  type ResolveExecutorOptions,
} from './executors.ts'
// `selectMethod` is deliberately NOT exported: `runSession` is its only caller,
// and publishing a surface nothing outside consumes is the defect the handoff
// records for four kernel exports that nothing reads.
//
// `swapMethod` IS exported although panda's own CLI never passes an outgoing
// method — one CLI process has nothing mounted to unmount. FR-28's ordered swap
// is delivered to the audience the PRD names first ("panda ships as an SDK
// first"): a host with a long-lived kernel. Unexported, the guarantee this story
// exists to provide would be reachable only from this package's own tests.
export { resolveMethod, swapMethod } from './methods.ts'
// The workspace selection, beside the executor one and for the same FR-29
// reason: a consumer that imports only this package can ask which provider a
// composed configuration names, without `@panda/cli`.
//
// ONE value, and the trimming is the same call `resolveExecutor`'s block above
// records: `WorkspaceProviderSelection.available` carries the closed catalogue,
// so `availableWorkspaceProviderIds` and the id constants would be surface
// nothing outside consumes. `createSelectedWorkspacePlugin` stays unexported for
// the harder reason — it hands back a `PluginFactory`, and a factory a caller
// can invoke with an `ActivationContext` of its own is exactly the bypass
// surface the block below records five withdrawn exports for.
export { selectWorkspaceProvider, type WorkspaceProviderSelection } from './workspaces.ts'
// The recorded quota reading, beside the run that produces it (Story M15.A,
// D7): `panda run` records, `panda status` reads, and nothing here invokes an
// executor. Both halves are exported for the same FR-29 reason as the two
// selections above — a host that installed only this package gets the whole
// pair without `@panda/cli`.
export {
  readUsageReports,
  recordUsageObservation,
  usageObservationsPath,
  type UsageStoreOptions,
} from './usage.ts'
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
  UsageAbsence,
  UsageObservation,
  UsageReport,
  UsageWindow,
  WorkspaceHandle,
  WorkspaceProvider,
} from '@panda/contracts'
// A VALUE, not a type: `UsageAbsence.reason` is routed on (AD-7), and a consumer
// that cannot name the codes would have to compare the strings by hand.
export { USAGE_ABSENCE_REASONS } from '@panda/contracts'
// Two sink constructors, and neither is a factory in the sense the note below
// withdraws. `createMemoryLogSink` retains; `createLogSink` takes the caller's
// own write function and retains nothing — it is the bring-your-own-exporter
// door, and `SessionOptions.log` is the only thing either one is for. What was
// withdrawn was a factory a caller could invoke with an `ActivationContext` to
// get back a wired vendor adapter; a function from `LogWrite` to `LogSink`
// composes nothing and reaches no adapter.
export { createLogSink, createMemoryLogSink } from '@panda/kernel'
// `PandaKernel` is a TYPE and nothing else — it is what names
// `SessionOptions.kernel` and the return of `createSessionKernel`, and it erases
// at runtime. `createKernel` itself, both plugin FACTORIES and the config
// seed/select helpers were briefly re-exported here for a host that wanted to
// assemble a kernel; every one of them was withdrawn on review, because a
// factory a caller can invoke with an `ActivationContext` of its own hands back
// a real vendor adapter wired to the caller's own pipeline. A session-only
// consumer's bypass surface went from nothing to one, and a complete session
// composition was planted inside `@panda/cli` importing only this package with
// the whole gate green. `createSessionKernel` above replaces all five: it gives
// a host the shared-kernel capability and hands back no factory.
export type { ActionPolicy, LogRecord, LogSink, MemoryLogSink, PandaKernel } from '@panda/kernel'
