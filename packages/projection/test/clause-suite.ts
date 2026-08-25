import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES } from '@panda/contracts'
import type { ProjectionTarget, RegistryEntriesByKind } from '@panda/contracts'
import { runProjection } from '../src/engine.ts'
import { renderOwnedSubtree } from '../src/owned-subtree.ts'

// Shared projection clause suite (FR-8): every target — shipped or trait-only
// stub — must satisfy the SAME clauses, exercised uniformly through this
// runner. Malformed isolation applies only to strategies able to detect
// malformed native input; the TOML delimited-block strategy manages foreign
// bytes at string level and deliberately never parses them.

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

export interface TargetClauseCase {
  readonly label: string
  /** Must return a target whose file lives INSIDE homeDir. */
  readonly makeTarget: (homeDir: string) => ProjectionTarget
  /** Foreign-content-rich native sample the target must project around. */
  readonly sampleNative: string
  /** Distinctive foreign fragments that must survive projection, in order. */
  readonly foreignSentinels: readonly string[]
  readonly supportsMalformedIsolation: boolean
  readonly malformedSample?: string
}

/** The same registry state every case projects; mirrors the committed goldens. */
export const SUITE_ENTRIES: RegistryEntriesByKind = {
  tool: [
    { type: 'tool', id: 'ripgrep', command: 'rg' },
    { type: 'tool', id: 'fd-find', command: '~/bin/fd' },
  ],
  skill: [{ type: 'skill', id: 'commit-lint', entryPath: '~/.panda/skills/commit-lint.ts' }],
  'mcp-server': [
    { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  ],
  profile: [],
}

function staticSiblingTarget(homeDir: string, label: string): ProjectionTarget {
  return {
    targetId: `${label}-sibling`,
    filePath: join(homeDir, `${label}-sibling.out`),
    merge: ({ ownedContent }) => ({ text: JSON.stringify(ownedContent), drift: [] }),
  }
}

export function runProjectionClauseSuite(cases: readonly TargetClauseCase[]): void {
  describe.each(cases)('projection clause suite — $label', (clauseCase) => {
    let homeDir: string

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), `panda-clause-${clauseCase.label}-`))
      tempRoots.push(homeDir)
    })

    it('projects the sample and is byte-idempotent across repeated merges', async () => {
      const target = clauseCase.makeTarget(homeDir)
      const entries = SUITE_ENTRIES
      const ownedContent = renderOwnedSubtree(entries)
      const first = await target.merge({ entries, ownedContent, nativeText: clauseCase.sampleNative })
      expect(first.drift).toEqual([])
      const second = await target.merge({ entries, ownedContent, nativeText: first.text })
      expect(second.text).toBe(first.text)
    })

    it('preserves foreign content in its original relative order', async () => {
      const target = clauseCase.makeTarget(homeDir)
      const outcome = await target.merge({
        entries: SUITE_ENTRIES,
        ownedContent: renderOwnedSubtree(SUITE_ENTRIES),
        nativeText: clauseCase.sampleNative,
      })
      let searchFrom = 0
      for (const sentinel of clauseCase.foreignSentinels) {
        const foundAt = outcome.text.indexOf(sentinel, searchFrom)
        expect(foundAt, `foreign sentinel not preserved in order: ${sentinel}`).toBeGreaterThanOrEqual(0)
        searchFrom = foundAt + sentinel.length
      }
    })

    it('preserves every foreign BYTE outside the reported owned span', async () => {
      const target = clauseCase.makeTarget(homeDir)
      const outcome = await target.merge({
        entries: SUITE_ENTRIES,
        ownedContent: renderOwnedSubtree(SUITE_ENTRIES),
        nativeText: clauseCase.sampleNative,
      })
      // Byte-level guarantee: the output must be input-prefix + owned-region
      // + input-suffix. Any reformatting of foreign bytes — even adjacent to
      // the splice point (the trailing-comma regression) — breaks this.
      expect(outcome.ownedSpan).toBeDefined()
      const [start, end] = outcome.ownedSpan!
      const output = outcome.text
      const suffixLength = output.length - end
      expect(output.slice(0, start)).toBe(clauseCase.sampleNative.slice(0, start))
      expect(output.slice(end)).toBe(clauseCase.sampleNative.slice(clauseCase.sampleNative.length - suffixLength))
    })

    it('lands once on disk and writes nothing on the second run', async () => {
      const target = clauseCase.makeTarget(homeDir)
      await mkdir(dirname(target.filePath), { recursive: true })
      await writeFile(target.filePath, clauseCase.sampleNative, 'utf8')
      const entries = SUITE_ENTRIES

      const firstRun = await runProjection({ entries, targets: [target] })
      expect(firstRun.failures).toEqual([])
      expect(firstRun.results[0]).toMatchObject({ written: true })
      const projected = await readFile(target.filePath, 'utf8')

      const secondRun = await runProjection({ entries, targets: [target] })
      expect(secondRun.results[0]).toMatchObject({ written: false, byteDelta: 0, drift: [] })
      expect(await readFile(target.filePath, 'utf8')).toBe(projected)
      // Atomic temp+rename leaves no temp files behind.
      expect(await readdir(dirname(target.filePath))).toEqual([basename(target.filePath)])
    })

    it.skipIf(!clauseCase.supportsMalformedIsolation)(
      'contains a malformed native file: only this target fails, the sibling still projects',
      async () => {
        const target = clauseCase.makeTarget(homeDir)
        await mkdir(dirname(target.filePath), { recursive: true })
        await writeFile(target.filePath, clauseCase.malformedSample!, 'utf8')
        const sibling = staticSiblingTarget(homeDir, clauseCase.label)

        const run = await runProjection({
          entries: SUITE_ENTRIES,
          targets: [target, sibling],
        })

        expect(run.failures).toHaveLength(1)
        expect(run.failures[0]!.targetId).toBe(target.targetId)
        expect(run.failures[0]!.error.code).toBe(PANDA_ERROR_CODES.projectionNativeMalformed)
        expect(run.failures[0]!.error.message).toContain(target.filePath)
        expect(run.results).toHaveLength(1)
        expect(run.results[0]!.targetId).toBe(sibling.targetId)
        expect(run.results[0]!.written).toBe(true)
        // The malformed file is untouched.
        expect(await readFile(target.filePath, 'utf8')).toBe(clauseCase.malformedSample!)
      },
    )
  })
}
