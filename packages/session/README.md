# @panda/session

The panda session: everything `panda run` does except argv, JSON and exit codes.
Create a workspace, obtain an adapter, run a prompt under a cancellation signal
through the kernel's interception waterfall, release and dispose.

Installing `@panda/cli` is not required — that is the point of this package. Nor
is installing `@panda/contracts` or `@panda/kernel`: every type and helper the
surface needs is re-exported from here.

```ts
import { runSession } from '@panda/session'

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
- **Interrupts.** There is no default — a library that installs
  `process.on('SIGINT')` steals the signal from its host. Pass `onInterrupt` to
  wire your own (`@panda/cli` passes its SIGINT/SIGTERM registration).

## Budgets and the record stream

The executor invocation is an action on a `createActionPipeline` waterfall, so
declarative caps apply to it and every invocation is recorded:

```ts
import { createMemoryLogSink, runSession, SESSION_ACTION_ID } from '@panda/session'

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

**Read the caps honestly.** One session registers one action of cost 1 and
invokes it once, on a pipeline of its own. So `maxInvocations`, `maxTotalCost`
and `maxConcurrent` currently collapse to a single boolean — *may this session
spawn an executor at all* — and `maxInvocations: 1` is a no-op, not a budget.
Five sessions with `maxInvocations: 1` run five executors, because each owns its
pipeline. A real token budget needs a cost the adapter reports after the run and
a pipeline shared across sessions; both are tracked in
`_bmad-output/implementation-artifacts/deferred-work.md`.
