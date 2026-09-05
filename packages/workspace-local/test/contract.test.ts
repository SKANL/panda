import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WORKSPACE_CLAUSES, runWorkspaceContractSuite } from '@skanl/panda-contracts'
import { LocalWorkspaceProvider } from '../src'

const rootDir = await mkdtemp(join(tmpdir(), 'panda-workspace-local-'))
afterAll(() => rm(rootDir, { recursive: true, force: true }))

describe('LocalWorkspaceProvider against the workspace contract suite', () => {
  it('passes every clause in the aggregate run', async () => {
    const report = await runWorkspaceContractSuite(new LocalWorkspaceProvider({ rootDir }))
    expect(report.suite).toBe('workspace-provider')
    expect(report.clauses).toEqual(WORKSPACE_CLAUSES.map((clause) => clause.name))
    expect(report.passed).toBe(true)
    expect(report.violations).toEqual([])
  })

  it('passes each clause independently by name', async () => {
    for (const clause of WORKSPACE_CLAUSES) {
      const outcome = await clause.check(new LocalWorkspaceProvider({ rootDir }))
      expect(outcome.ok, `${clause.name} failed: ${outcome.detail ?? ''}`).toBe(true)
    }
  })
})
