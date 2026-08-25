import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_SOURCE_EXTENSION_KEY } from '@panda/contracts'
import type { SkillSource } from '@panda/contracts'
import { RegistryStore, ingestProviders } from '@panda/registry'
import { createClaudeSettingsTarget } from '../src/targets/claude-settings.ts'
import { groupByKind, runProjection } from '../src/engine.ts'

// End-to-end closing of the ingest -> registry -> projection loop (Story 2.4).
//
// What this pins is the OBSERVABLE end of the claim: an unchanged source leaves
// the projected file byte-identical, and a changed one does not. It is
// deliberately not evidence that ingestion skipped the write — renderOwnedSubtree
// sorts by id, so a redundant re-register would project identically too. That
// the write is skipped at all is pinned by the write-spy in the registry suite.
// No projection code is involved beyond the existing engine and Claude target.

// Distinctive enough that "the hash is absent" is a real assertion; 'h1' would
// pass against almost any two characters of JSON.
const HASH = 'sha256-6f1c0a2d-source-token'

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

function source(contentHash: string, entryPath: string): SkillSource {
  return {
    sourceId: 'skills-dir',
    list: () => [{ entry: { type: 'skill', id: 'commit-lint', entryPath }, contentHash }],
  }
}

describe('provider ingestion projected end to end', () => {
  it('re-projects byte-identically while the source hash is unchanged, and only then', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-ingest-projection-'))
    tempRoots.push(homeDir)
    const store = new RegistryStore({ homeDir })
    const filePath = join(homeDir, '.claude', 'settings.json')
    const project = async (): Promise<{ written: boolean; text: string }> => {
      const run = await runProjection({
        entries: groupByKind(await store.list()),
        targets: [createClaudeSettingsTarget({ filePath })],
      })
      expect(run.failures).toEqual([])
      return { written: run.results[0]!.written, text: await readFile(filePath, 'utf8') }
    }

    await ingestProviders(store, { skillSources: [source(HASH, '/skills/commit-lint.ts')] })
    const first = await project()
    expect(first.written).toBe(true)
    // The opaque hash is source-tracking state, not projected content.
    expect(first.text).not.toContain(HASH)
    expect(first.text).not.toContain(PANDA_SOURCE_EXTENSION_KEY)

    const unchanged = await ingestProviders(store, {
      skillSources: [source(HASH, '/skills/commit-lint.ts')],
    })
    expect(unchanged.unchanged).toEqual(['skill:commit-lint'])
    const second = await project()
    expect(second.written).toBe(false)
    expect(second.text).toBe(first.text)

    const changed = await ingestProviders(store, {
      skillSources: [source(`${HASH}-next`, '/skills/renamed.ts')],
    })
    expect(changed.registered).toEqual(['skill:commit-lint'])
    const third = await project()
    expect(third.written).toBe(true)
    expect(third.text).not.toBe(first.text)
    expect(third.text).toContain('/skills/renamed.ts')
  })
})
