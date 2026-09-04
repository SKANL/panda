import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MEMORY_CLAUSES, MEMORY_FORMAT_VERSION, runMemoryContractSuite } from '@panda/contracts'
import type { MemoryContractHarness, SuiteReport } from '@panda/contracts'
import { FilesystemMemoryProvider } from '../src/index.ts'

const temporaryRoot = await mkdtemp(join(tmpdir(), 'panda-memory-filesystem-'))
afterAll(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }))

let media = 0

/**
 * A FRESH medium per harness, because `fresh-store-is-typed-empty` refuses to
 * run over a store that already holds entries — deliberately, so the clause
 * cannot be quietly defanged by reuse.
 */
async function harness(): Promise<MemoryContractHarness> {
  media += 1
  const storeDir = join(temporaryRoot, `store-${String(media)}`)
  return {
    providerName: '@panda/memory-filesystem',
    provider: await FilesystemMemoryProvider.open({ storeDir }),
    // The reopen seam: a NEW instance over the SAME directory, which is exactly
    // what a process restart produces.
    reopen: () => FilesystemMemoryProvider.open({ storeDir }),
    openDivergentFormatVersion: async () => {
      media += 1
      const other = join(temporaryRoot, `divergent-${String(media)}`)
      await mkdir(other, { recursive: true })
      await writeFile(
        join(other, 'meta.json'),
        JSON.stringify({ formatVersion: MEMORY_FORMAT_VERSION + 98 }),
        'utf8',
      )
      return FilesystemMemoryProvider.open({ storeDir: other })
    },
  }
}

function describeReport(report: SuiteReport): string {
  return report.violations.map((violation) => `${violation.clause}: ${violation.detail}`).join('\n')
}

describe('FilesystemMemoryProvider against the memory contract suite', () => {
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
    // Driven, not described: a subject that fails the FIRST clause, run through
    // the same runner both providers use. Without this, "the provider is named"
    // is a claim about a code path no green run ever takes.
    const subject = await harness()
    await subject.provider.save({
      payload: 'this store is no longer fresh',
      provenance: { agentId: 'a', workspaceId: 'w', recordedAt: new Date().toISOString() },
    })
    const report = await runMemoryContractSuite(subject)
    expect(report.passed).toBe(false)
    expect(report.violations[0]?.clause).toBe('fresh-store-is-typed-empty')
    for (const violation of report.violations) {
      expect(violation.detail).toContain('@panda/memory-filesystem')
    }
  })
})
