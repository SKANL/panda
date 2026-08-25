import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES } from '@panda/contracts'
import type { ProjectionTarget, RegistryEntriesByKind } from '@panda/contracts'
import { runProjection } from '../src/engine.ts'
import { ProjectionLedger } from '../src/ledger.ts'

// Shared projection clause suite (FR-8): every target — shipped or trait-only
// stub — must satisfy the SAME clauses, exercised uniformly through this
// runner. Malformed isolation applies only to strategies able to detect
// malformed native input; the TOML strategy manages foreign bytes at string
// level and deliberately never parses them.

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
  tool: [{ type: 'tool', id: 'ripgrep', command: 'rg' }],
  skill: [{ type: 'skill', id: 'commit-lint', entryPath: '~/.panda/skills/commit-lint.ts' }],
  'mcp-server': [
    { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    { type: 'mcp-server', id: 'ast-grep', command: 'ast-grep', args: ['mcp'] },
  ],
  profile: [],
}

/** Deletes every owned span, which is what "foreign bytes survived" means. */
export function withoutOwnedSpans(text: string, spans: readonly (readonly [number, number])[]): string {
  let foreign = ''
  let cursor = 0
  for (const [start, end] of spans) {
    foreign += text.slice(cursor, start)
    cursor = end
  }
  return foreign + text.slice(cursor)
}

export function makeLedger(homeDir: string): ProjectionLedger {
  return new ProjectionLedger({ homeDir })
}

function staticSiblingTarget(homeDir: string, label: string): ProjectionTarget {
  return {
    targetId: `${label}-sibling`,
    filePath: join(homeDir, `${label}-sibling.out`),
    merge: ({ entries }) => ({
      text: JSON.stringify(entries['mcp-server']),
      drift: [],
      records: [],
      ownedSpans: [],
    }),
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
      const first = await target.merge({ entries, records: [], nativeText: clauseCase.sampleNative })
      expect(first.drift).toEqual([])
      // The second merge carries the ledger the first one produced, which is
      // the only thing that lets panda recognise its own entries.
      const second = await target.merge({ entries, records: first.records, nativeText: first.text })
      expect(second.text).toBe(first.text)
      expect(second.records).toEqual(first.records)
    })

    it('preserves foreign content in its original relative order', async () => {
      const target = clauseCase.makeTarget(homeDir)
      const outcome = await target.merge({
        entries: SUITE_ENTRIES,
        records: [],
        nativeText: clauseCase.sampleNative,
      })
      let searchFrom = 0
      for (const sentinel of clauseCase.foreignSentinels) {
        const foundAt = outcome.text.indexOf(sentinel, searchFrom)
        expect(foundAt, `foreign sentinel not preserved in order: ${sentinel}`).toBeGreaterThanOrEqual(0)
        searchFrom = foundAt + sentinel.length
      }
    })

    it('preserves every foreign BYTE outside the reported owned spans', async () => {
      const target = clauseCase.makeTarget(homeDir)
      const outcome = await target.merge({
        entries: SUITE_ENTRIES,
        records: [],
        nativeText: clauseCase.sampleNative,
      })
      // Byte-level guarantee on a file panda never wrote: deleting the owned
      // spans must give back the native input EXACTLY. Any reformatting of
      // foreign bytes — even adjacent to a splice point (the trailing-comma
      // regression) — breaks this.
      expect(outcome.ownedSpans.length).toBeGreaterThan(0)
      expect(withoutOwnedSpans(outcome.text, outcome.ownedSpans)).toBe(clauseCase.sampleNative)
    })

    it('preserves foreign BYTES across a RE-projection over panda’s own regions', async () => {
      const target = clauseCase.makeTarget(homeDir)
      const entries = SUITE_ENTRIES
      const first = await target.merge({ entries, records: [], nativeText: clauseCase.sampleNative })
      // The other half of the invariant, and the half a run over a file panda
      // never wrote cannot exercise: with PRIOR regions on disk, deleting the
      // new spans must leave exactly what deleting the old ones left.
      const renamed: RegistryEntriesByKind = {
        ...entries,
        'mcp-server': [{ type: 'mcp-server', id: 'renamed-server', command: 'other', args: ['x'] }],
      }
      const second = await target.merge({
        entries: renamed,
        records: first.records,
        nativeText: first.text,
      })
      // A run that WROTE must report a span: a rename is a removal plus an
      // insertion, and a zero-width removal span must never swallow the
      // insertion's own and leave the verification surface empty.
      expect(second.text).not.toBe(first.text)
      expect(second.ownedSpans.length).toBeGreaterThan(0)
      const foreign = withoutOwnedSpans(second.text, second.ownedSpans)
      expect(foreign).not.toContain('renamed-server')
      let searchFrom = 0
      for (const sentinel of clauseCase.foreignSentinels) {
        const foundAt = foreign.indexOf(sentinel, searchFrom)
        expect(foundAt, `foreign sentinel lost on re-projection: ${sentinel}`).toBeGreaterThanOrEqual(0)
        searchFrom = foundAt + sentinel.length
      }
    })

    it('lands once on disk and writes nothing on the second run', async () => {
      const target = clauseCase.makeTarget(homeDir)
      const ledger = makeLedger(homeDir)
      await mkdir(dirname(target.filePath), { recursive: true })
      await writeFile(target.filePath, clauseCase.sampleNative, 'utf8')
      const entries = SUITE_ENTRIES

      const firstRun = await runProjection({ entries, targets: [target], ledger })
      expect(firstRun.failures).toEqual([])
      expect(firstRun.warnings).toEqual([])
      expect(firstRun.results[0]).toMatchObject({ written: true })
      const projected = await readFile(target.filePath, 'utf8')

      const secondRun = await runProjection({ entries, targets: [target], ledger })
      expect(secondRun.results[0]).toMatchObject({ written: false, byteDelta: 0, drift: [] })
      expect(await readFile(target.filePath, 'utf8')).toBe(projected)
      // Atomic temp+rename leaves no temp files behind.
      const siblings = await readdir(dirname(target.filePath))
      expect(siblings.filter((name) => name.endsWith('.tmp'))).toEqual([])
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
          ledger: makeLedger(homeDir),
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
