# @skanl/panda-contracts

`@skanl/panda-contracts` is panda's SDK port-authoring kit. It contains the
public types, validation schemas, coded errors, and behavioral clause suites
that let a third party implement a workspace, memory, or executor port without
reading panda's source.

## Quick path: author a port

Install the contracts package by itself in the project that owns your adapter:

```bash
npm i -D @skanl/panda-contracts
```

The package is deliberately usable as a **contracts-only install**. A CI proof
packs this tarball, installs it into a project with nothing else from panda,
compiles a `WorkspaceProvider` against the shipped declarations, and runs the
published workspace suite from the archive. If a runtime dependency leaks into
the package, that proof fails.

## The ports

| Port | Interface | Published clause array |
| --- | --- | --- |
| Workspace | `WorkspaceProvider` | `WORKSPACE_CLAUSES` + `runWorkspaceContractSuite` |
| Memory | `MemoryProvider` | `MEMORY_CLAUSES` + `runMemoryContractSuite` |
| Executor | `ExecutorAdapter` | `EXECUTOR_CLAUSES` + `runExecutorContractSuite` |
| Tool | `ToolProvider` | **none yet** |

`ToolProvider` is stated honestly: it has no clause array, so there is nothing to
run against an implementation of it. NFR-8 asks for a suite per Contract and
this is the one that does not have one yet.

The package root exports the port types and their schemas, `PandaError` and
`PANDA_ERROR_CODES`, the validation helpers, and the clause-suite runners. The
`@skanl/panda-contracts/validation` subpath is also published for the shared
record-shape helper. The examples below use the package root, which is the normal
authoring path.

## The lease model, which the type alone cannot tell you

A workspace handle is a **lease**, not a path.

- `create()` mints a handle. `acquire(id)` returns one for an id that exists.
- Two live handles for one workspace are legal. Releasing the same handle twice is
  not: the second raises `PANDA_CONTRACT_WORKSPACE_DOUBLE_RELEASE`.
- A handle you did not mint is forged, and `release()` must refuse it.
- After `dispose()`, every operation raises `PANDA_CONTRACT_PROVIDER_DISPOSED`.
  `dispose()` itself is idempotent and destroys no durable state—disposing a
  reader is not deleting a workspace.
- An unknown or non-string id leaves through the same coded door,
  `PANDA_CONTRACT_WORKSPACE_UNKNOWN_ID`. This port is reachable from untyped
  JavaScript and from a parsed document, where `null` is a value rather than a
  type error.

## Write the port

```ts
import { PANDA_ERROR_CODES, PandaError, validateWorkspaceHandle } from '@skanl/panda-contracts'
import type { WorkspaceHandle, WorkspaceProvider } from '@skanl/panda-contracts'

export class EphemeralWorkspaces implements WorkspaceProvider {
  async create(): Promise<WorkspaceHandle> {
    return validateWorkspaceHandle({ id: 'w1', rootPath: '/w1', capabilities: ['read', 'write'] })
  }

  async acquire(id: string): Promise<WorkspaceHandle> {
    return validateWorkspaceHandle({ id, rootPath: `/${id}`, capabilities: ['read'] })
  }

  async release(_handle: WorkspaceHandle): Promise<void> {}

  async dispose(): Promise<void> {
    throw new PandaError(PANDA_ERROR_CODES.contractProviderDisposed, 'disposed')
  }
}

// @ts-expect-error 'execute' is not a WorkspaceCapability, so these declarations are real types.
export const wrong: WorkspaceHandle = { id: 'x', rootPath: '/x', capabilities: ['execute'] }
```

That last line is not decoration. If the shipped declarations failed to resolve,
the import would degrade to `any`, the `@ts-expect-error` would be unused, and
`tsc` would report THAT—so a silently degraded resolution fails as loudly as a
missing file. Keep it while you are wiring the package up.

## Then prove it

Implementing the interface makes it compile. The suite is what tells you it is
correct. Run it against your provider and read the report.

```js
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PANDA_ERROR_CODES,
  PandaError,
  runWorkspaceContractSuite,
  validateWorkspaceHandle,
} from '@skanl/panda-contracts'

class HalfRightWorkspaces {
  #roots = new Map()

  async create() {
    const id = `w${this.#roots.size + 1}`
    const root = mkdtempSync(join(tmpdir(), 'panda-contracts-only-'))
    this.#roots.set(id, root)
    return validateWorkspaceHandle({ id, rootPath: root, capabilities: ['read', 'write'] })
  }

  async acquire(id) {
    const root = this.#roots.get(id)
    if (root === undefined) {
      throw new PandaError(PANDA_ERROR_CODES.contractWorkspaceUnknownId, 'unknown workspace id')
    }
    return validateWorkspaceHandle({ id, rootPath: root, capabilities: ['read', 'write'] })
  }

  // PLANTED: a conformant provider refuses a forged handle and a second release.
  async release() {}

  async dispose() {}
}

const suite = await runWorkspaceContractSuite(new HalfRightWorkspaces())

const handle = validateWorkspaceHandle({ id: 'w1', rootPath: process.cwd(), capabilities: ['read', 'write'] })

let rejectedCode = null
try {
  validateWorkspaceHandle({ id: '', rootPath: '', capabilities: [] })
} catch (error) {
  if (!(error instanceof PandaError)) throw error
  rejectedCode = error.code
}
```

**The subject above is wrong on purpose, and the example is better for it.**
`release()` accepts anything, so `release-forged-handle-rejected` and
`double-release-rejected` come back as violations while the filesystem clauses
pass. A worked example that passes everything teaches you nothing about what a
failure looks like—and a suite that passes everything is indistinguishable from
a suite that checks nothing.

`SuiteReport` carries `clauses` (every clause name, in order), `outcomes` (one
result each, with a `detail` when it failed) and `violations` (the failures
alone). Route on the clause name; the detail is prose for a human.

## Validation and errors

Use the exported schemas and validators at your boundary. Every refusal is a
`PandaError` with a `code` from `PANDA_ERROR_CODES`. **Route on the code, never on
the message**—the message is written for a person and is not a contract. No error
panda raises about a document quotes that document's contents, so malformed
configuration is reported by location and never by excerpt.

## Packed declarations and the `panda-source` condition

The manifest declares a `panda-source` condition pointing at `./src/index.ts`,
and the tarball ships no `src/`. That is not a broken package: the condition
exists so panda's own development loop can typecheck and test against sources
without a build step, and it is unreachable unless you opt in with
`node --conditions=panda-source`. A consumer resolves through `import` or
`require` and gets `dist`.

## What this guide proves

The two code blocks above are extracted from this file by
`packages/session/test/consumer-install.proof.ts` and run against the **packed
tarball** in a project outside this repository, offline. The proof matrix checks
packed consumer candidates starting at Node 20; it does not rely on a claim about
"both supported Node versions". If the examples stop compiling or stop
producing a mixed report, the packaging proof fails.

<!-- ponytail: the fenced blocks are executed; the prose between them is not.
     A sentence here can go stale without anything failing. Upgrade path: none
     worth its cost yet — the claims most likely to rot are the coded-error
     names, and those are already pinned by the blocks that use them. -->
