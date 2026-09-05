# @skanl/panda-memory-filesystem

The filesystem `MemoryProvider`: one directory, one `meta.json` format stamp, and one append-only
`entries.ndjson` log. State written into a store survives disposal and process restarts, which is
what `state-survives-reopen` in the shared contract suite exists to prove.

```ts
import { FilesystemMemoryProvider } from '@skanl/panda-memory-filesystem'

const provider = await FilesystemMemoryProvider.open({ storeDir: '/tmp/panda-memory' })
await provider.save({
  payload: 'the deploy script needs PANDA_HOME set',
  provenance: { agentId: 'claude-code', workspaceId: 'ws-7', recordedAt: new Date().toISOString() },
})
const recent = await provider.search({ workspaceId: 'ws-7' })
await provider.dispose()
```

`open()` is async and there is no public constructor, because the format stamp has to be READ
before this build agrees to serve the directory. An ABSENT store is stamped and served — absence
is not failure (AD-5) — while a store stamped with another format version is refused with
`PANDA_CONTRACT_MEMORY_STORE_VERSION_MISMATCH`. Version by reject, never migrate.

Writes are append-only with mandatory provenance (RD-1): `save()` appends exactly one line and
this file contains no rewrite, truncate or seek. Supersession is an APPEND carrying
`supersedes: <id>`; the superseded entry stays in the log and stays readable. `overwrite()` exists
only to refuse, with `PANDA_CONTRACT_MEMORY_OVERWRITE_UNSUPPORTED`, having changed nothing.

`dispose()` is idempotent and destroys nothing — the directory outlives every provider.

## Conformance

`packages/contracts/src/contract-suite/memory-clauses.ts` holds the clauses, and
`test/contract.test.ts` runs every one of them against this provider. The identical array runs
against `@skanl/panda-memory-sqlite`; that swap is FR-16 and scenario S2.
