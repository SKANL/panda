import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MEMORY_CLAUSES, MEMORY_FORMAT_VERSION, runMemoryContractSuite } from '@skanl/panda-contracts'
import type { MemoryContractHarness, SuiteReport } from '@skanl/panda-contracts'
import { SqliteMemoryProvider } from '../src/index.ts'
// Through the package's OWN confined loader, not a bare `import 'node:sqlite'`:
// a direct import here would print the ExperimentalWarning into `pnpm test`
// output, which is the exact noise `load-sqlite.ts` exists to keep out. The
// loader is not assumed correct on that point — `load-sqlite.test.ts` proves it
// in child processes, with a control.
import { loadSqlite } from '../src/load-sqlite.ts'

const { DatabaseSync } = await loadSqlite()

const temporaryRoot = await mkdtemp(join(tmpdir(), 'panda-memory-sqlite-'))

// Every subject this file opens, closed before the directory is removed: an open
// SQLite connection holds its file on Windows, and a cleanup that cannot delete
// fails the suite for a reason that has nothing to do with the contract.
const opened: SqliteMemoryProvider[] = []
afterAll(async () => {
  for (const provider of opened) await provider.dispose().catch(() => {})
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 })
})

let media = 0

async function harness(): Promise<MemoryContractHarness> {
  media += 1
  const databasePath = join(temporaryRoot, `store-${String(media)}.db`)
  const provider = await SqliteMemoryProvider.open({ databasePath })
  opened.push(provider)
  return {
    providerName: '@skanl/panda-memory-sqlite',
    provider,
    // A NEW connection to the SAME file. The previous instance is deliberately
    // left open: two readers of one SQLite file is the mildest form of the
    // restart this seam stands for, and the clause still has to see the writes.
    reopen: async () => {
      const reopened = await SqliteMemoryProvider.open({ databasePath })
      opened.push(reopened)
      return reopened
    },
    openDivergentFormatVersion: () => {
      media += 1
      const other = join(temporaryRoot, `divergent-${String(media)}.db`)
      const seeded = new DatabaseSync(other)
      seeded.exec(`PRAGMA user_version = ${String(MEMORY_FORMAT_VERSION + 98)}`)
      seeded.close()
      return SqliteMemoryProvider.open({ databasePath: other })
    },
  }
}

function describeReport(report: SuiteReport): string {
  return report.violations.map((violation) => `${violation.clause}: ${violation.detail}`).join('\n')
}

describe('SqliteMemoryProvider against the memory contract suite', () => {
  it('passes every clause in the aggregate run', async () => {
    const report = await runMemoryContractSuite(await harness())
    expect(report.suite).toBe('memory-provider')
    expect(report.clauses).toEqual(MEMORY_CLAUSES.map((clause) => clause.name))
    expect(report.violations, describeReport(report)).toEqual([])
    expect(report.passed).toBe(true)
  })

  it('passes each clause independently by name', async () => {
    for (const clause of MEMORY_CLAUSES) {
      const outcome = await clause.check(await harness())
      expect(outcome.ok, `${clause.name} failed: ${outcome.detail ?? ''}`).toBe(true)
    }
  })

  it('names the provider in every violation, so a red clause says which one broke', async () => {
    const subject = await harness()
    await subject.provider.save({
      payload: 'this store is no longer fresh',
      provenance: { agentId: 'a', workspaceId: 'w', recordedAt: new Date().toISOString() },
    })
    const report = await runMemoryContractSuite(subject)
    expect(report.passed).toBe(false)
    expect(report.violations[0]?.clause).toBe('fresh-store-is-typed-empty')
    for (const violation of report.violations) {
      expect(violation.detail).toContain('@skanl/panda-memory-sqlite')
    }
  })
})
