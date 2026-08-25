import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_SOURCE_EXTENSION_KEY } from '@panda/contracts'
import type { RegistryEntry, ToolProvider } from '@panda/contracts'
import { RegistryStore, ingestProviders } from '@panda/registry'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { groupByKind, runProjection } from '../src/engine.ts'
import { ProjectionLedger } from '../src/ledger.ts'

// End-to-end closing of the ingest -> registry -> projection loop (Story 2.4),
// now landing in the vendor's own vocabulary.
//
// What this pins is the OBSERVABLE end of the claim: re-ingesting the same
// contribution leaves the projected file byte-identical, and a changed one does
// not. It is deliberately not evidence that ingestion skipped a store write —
// the write-spy in the registry suite pins that. What it does prove here is
// that panda's own tracking state (the reserved extensions payload) never
// reaches the executor's file.

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

// Distinctive enough that "the tracking key is absent" is a real assertion.
const SOURCE_ID = 'sha256-6f1c0a2d-source-token'

function provider(command: string): ToolProvider {
  return {
    sourceId: SOURCE_ID,
    list: (): readonly RegistryEntry[] => [
      { type: 'mcp-server', id: 'commit-lint', command, args: ['serve'] },
    ],
  }
}

describe('provider ingestion projected end to end', () => {
  it('re-projects byte-identically while the contribution is unchanged, and only then', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-ingest-projection-'))
    tempRoots.push(homeDir)
    const store = new RegistryStore({ homeDir })
    const filePath = join(homeDir, '.claude.json')
    const ledger = new ProjectionLedger({ homeDir })
    const project = async (): Promise<{ written: boolean; text: string }> => {
      const run = await runProjection({
        entries: groupByKind(await store.list()),
        targets: [createClaudeMcpTarget({ filePath })],
        ledger,
      })
      expect(run.failures).toEqual([])
      return { written: run.results[0]!.written, text: await readFile(filePath, 'utf8') }
    }

    await ingestProviders(store, { toolProviders: [provider('commit-lint-mcp')] })
    const first = await project()
    expect(first.written).toBe(true)
    expect(JSON.parse(first.text)['mcpServers']).toEqual({
      'commit-lint': { type: 'stdio', command: 'commit-lint-mcp', args: ['serve'] },
    })
    // Source tracking is panda-side state, not projected content.
    expect(first.text).not.toContain(SOURCE_ID)
    expect(first.text).not.toContain(PANDA_SOURCE_EXTENSION_KEY)

    await ingestProviders(store, { toolProviders: [provider('commit-lint-mcp')] })
    const second = await project()
    expect(second.written).toBe(false)
    expect(second.text).toBe(first.text)

    const changed = await ingestProviders(store, { toolProviders: [provider('renamed-mcp')] })
    expect(changed.registered).toEqual(['mcp-server:commit-lint'])
    const third = await project()
    expect(third.written).toBe(true)
    expect(third.text).toContain('renamed-mcp')
    expect(third.text).not.toContain('commit-lint-mcp')
  })
})
