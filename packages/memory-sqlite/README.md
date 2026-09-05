# @skanl/panda-memory-sqlite

The embedded-SQLite `MemoryProvider`, on `node:sqlite`'s `DatabaseSync`.

**No new dependency.** `node:sqlite` is the platform, measured working on Node 24.14.1 and Node
26.8.1 — the exact two versions CI runs. Panda ships exactly one non-`@skanl/panda-*` runtime dependency
in total (`jsonc-parser`, in `@skanl/panda-projection`) and this package does not make it two.

```ts
import { SqliteMemoryProvider } from '@skanl/panda-memory-sqlite'

const provider = await SqliteMemoryProvider.open({ databasePath: '/tmp/panda-memory.db' })
await provider.save({
  payload: 'the deploy script needs PANDA_HOME set',
  provenance: { agentId: 'claude-code', workspaceId: 'ws-7', recordedAt: new Date().toISOString() },
})
const recent = await provider.search({ workspaceId: 'ws-7' })
await provider.dispose()
```

The store is one `entries` table whose `sequence` is `INTEGER PRIMARY KEY AUTOINCREMENT`, and the
format version lives in `PRAGMA user_version`, which is where SQLite already keeps exactly this
fact. Append-only is enforced by omission and by SQL: `sqlite-memory-provider.ts` contains no
UPDATE and no DELETE. `user_version = 0` is a database nobody has stamped — an absent store, so it
is stamped and served (AD-5); any other value is refused with
`PANDA_CONTRACT_MEMORY_STORE_VERSION_MISMATCH`, and the refused open closes its connection and
creates no table.

## The experimental warning

Node 24 prints `ExperimentalWarning: SQLite is an experimental feature` when `node:sqlite` LOADS,
not when a database opens — so a static import would put it on stderr for a consumer that never
touches a store, and stderr is a contract surface for `panda run`. `src/load-sqlite.ts` therefore
does two things: it imports the module lazily on first `open()`, and it confines that one warning
for the duration of that one import. The filter is narrow (type AND text), so every other warning
still reaches the user. `test/load-sqlite.test.ts` proves all of it in child processes, with two
controls: a plain import that MUST show the warning, and an unrelated `ExperimentalWarning` that
MUST survive the confinement.

## Conformance

`packages/contracts/src/contract-suite/memory-clauses.ts` holds the clauses, and
`test/contract.test.ts` runs every one of them against this provider. The identical array runs
against `@skanl/panda-memory-filesystem`; that swap is FR-16 and scenario S2.
