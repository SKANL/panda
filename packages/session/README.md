# @skanl/panda-session

The panda session: everything `panda run` does except argv, JSON and exit codes.
Compose through a kernel, create a workspace, run a prompt under a cancellation
signal through that kernel's interception waterfall, release and dispose.

The adapter and the workspace provider are **mounted as kernel plugins**, not
constructed: `createSessionKernel` registers both, seeds the kernel's layered
configuration from panda's own documents, and `runSession` consumes the
`executor` and `workspace` services by name.

Installing `@skanl/panda-cli` is not required — that is the point of this package. Nor
is installing `@skanl/panda-contracts` or `@skanl/panda-kernel`: every type and helper the
surface needs is re-exported from here.

```ts
import { runSession } from '@skanl/panda-session'

const envelope = await runSession({ prompt: 'list files in this workspace' })
console.log(envelope.status, envelope.summary)
```

The returned value is the `ResultEnvelope` `panda run` prints. Environment
failures throw instead, carrying a `code` — `PANDA_CONTRACT_*` from the workspace
port, `PANDA_KERNEL_*` from a budget refusal:

```ts
try {
  await runSession({ prompt: 'list files' })
} catch (error) {
  console.error((error as { code?: string }).code)
}
```

## What it writes, and what it owns

- **Disk.** Each call creates `<cwd>/.panda/workspaces/<uuid>` and **nothing ever
  removes it**: `release()` ends a lease and `dispose()` leaves the tree so work
  survives. Cleaning up is the caller's.
- **The provider.** The session disposes whatever `createProvider` returns, on
  every path. Return a **fresh** provider per session; a pooled one comes back
  disposed and the next session fails with `PANDA_CONTRACT_PROVIDER_DISPOSED`.
  `createProvider` is **refused** beside a supplied `kernel` — a supplied kernel
  already carries a provider, and pooling one behind its shared pipeline made the
  second run fail `PANDA_KERNEL_ACTION_INVALID` on a repeated workspace id.
- **The kernel.** A kernel `runSession` built itself is stopped on every path,
  which is what runs every mounted plugin's disposer. A kernel you passed in is
  yours to stop; the session never does, so several sessions can share one.
- **Interrupts.** There is no default — a library that installs
  `process.on('SIGINT')` steals the signal from its host. Pass `onInterrupt` to
  wire your own (`@skanl/panda-cli` passes its SIGINT/SIGTERM registration).

## Budgets and the record stream

The executor invocation is an action on the **kernel's** waterfall, so
declarative caps apply to it and every invocation is recorded. `log` receives the
waterfall's records; the kernel's lifecycle records (manifest validation,
activation, disposal) stay in the kernel's own stream — build the kernel yourself
to read those, as the shared-kernel example below does:

```ts
import { createMemoryLogSink, runSession, SESSION_ACTION_ID } from '@skanl/panda-session'

const log = createMemoryLogSink()
try {
  // A refusal happens BEFORE the executor process is started.
  await runSession({ prompt: 'do not spawn', log, actionPolicy: { maxInvocations: 0 } })
} catch {
  // `drain()` first: an async sink still has records in flight when runSession resolves.
  await log.drain()
  console.log(log.records.map((record) => record.event)) // ['action.refused']
}
```

Records are subject-scoped to the workspace, so match with
`record.subject.startsWith(SESSION_ACTION_ID + '#')`.

## Panda's own configuration

`runSession` reads no files. Hand it the documents instead, and they seed the
kernel's layered configuration — the ONE composed document both the executor
selection and every mounted plugin read:

```ts
import { readExecutorConfigLayers, runSession } from '@skanl/panda-session'

const configLayers = await readExecutorConfigLayers({ projectDir: process.cwd() })
await runSession({ prompt: 'list files', configLayers })
```

`resolveExecutor()` still exists and still answers *which executor*, but a
selection alone carries no document: `runSession({ executorId })` seeds only
panda's defaults and that one choice, so nothing a user wrote reaches a mounted
plugin. Pass `configLayers` whenever you want the document to configure the run.

Resolution order is `defaults → global → project → agent → invocation`. Naming a
`cwd` makes the workspace root this invocation's answer; omitting one lets a
`workspace.rootDir` in the document decide. A key panda reads and cannot use is
reported through `onWarning` and never fails the run.

## One kernel, many sessions — one budget

`runSession` builds a kernel per call unless you hand it one. `createSessionKernel`
builds one you own, and then the pipeline, its caps and its record stream are
shared by every session on it:

```ts
import { createMemoryLogSink, createSessionKernel, runSession } from '@skanl/panda-session'

const log = createMemoryLogSink()
const kernel = createSessionKernel({
  log, // the WHOLE kernel stream: activation and disposal, not only the waterfall
  actionPolicy: { maxTotalCost: 1.5 },
  executorId: 'codex',
  onWarning: (message) => console.error(message),
})

await runSession({ prompt: 'first', kernel })
// Refused: PANDA_KERNEL_COST_CAP_EXCEEDED, before the executor is spawned.
await runSession({ prompt: 'second', kernel }).catch(() => {})
await kernel.stop() // disposes every mounted plugin, in reverse order
```

`createSessionKernel` is the only composition surface this package exposes, and
that is deliberate: it hands back a started kernel and no plugin factory. A
`PluginFactory` a caller can invoke with an `ActivationContext` of its own
construction yields a real vendor adapter wired to the caller's own pipeline, so
re-exporting the factories put a bypass on the surface of a package whose reason
to exist is that the executor goes through the waterfall.

A kernel you supply owns its configuration, its plugins, its pipeline, its sink
and its provider, so `configLayers`, `cwd`, `executorId`, `adapterOptions`,
`createAdapter`, `createProvider`, `onSelection`, `log` and `actionPolicy` are
**refused** beside it rather than silently ignored.

**Read the caps honestly.** A run is ADMITTED at `SESSION_ACTION_COST` (a flat 1)
and then SETTLED against the token figure the executor itself reported, so
`maxTotalCost` and `maxInvocations` now refuse on **different runs**: one
claude-code run settles at tens of thousands of tokens, which trips a cost cap
while the invocation count is still 1, and a cheap run trips an invocation cap
with the settled cost nowhere near its own limit. The error `code` still says
which cap fired.

Two ceilings remain, and both are tracked in
`_bmad-output/implementation-artifacts/deferred-work.md`. `maxConcurrent` is
still collapsed with the other two for a session that registers one action and
awaits it — nothing a single `panda run` does puts two operations in flight. And
the ESTIMATE is a flat 1 while the settlement is in the vendor's tokens, so a
host that budgets in tokens should pass its own `cost` through
`createExecutorPlugin`; panda will not invent a pre-run token figure.

The settlement is also what the record stream carries: with a policy configured,
each admitted run emits an `action.estimated` and, if the vendor reported a
figure, an `action.settled`, so the total is reconstructable from the records
alone. With no policy set, the stream is exactly what it was before.
