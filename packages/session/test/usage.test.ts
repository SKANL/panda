import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { USAGE_ABSENCE_REASONS, usageObservation } from '@panda/contracts'
import type { UsageReport } from '@panda/contracts'
import { readUsageReports, recordUsageObservation, usageObservationsPath } from '../src/usage.ts'

// The recorded side of D7: the run writes the reading down, the report reads it.
//
// Nothing in this file spawns anything, which is not an omission — it is the
// property. `readUsageReports` cannot invoke an executor, so a report can never
// cost the quota it reports on.

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'panda-usage-'))
  roots.push(dir)
  return dir
}

function byId(reports: readonly UsageReport[]): Map<string, UsageReport> {
  return new Map(reports.map((report) => [report.executorId, report]))
}

const OBSERVATION = usageObservation(
  'claude-code',
  [
    { name: 'five_hour', utilization: 0.13, resetsAt: 1788491400 },
    { name: 'seven_day', utilization: 0.22, resetsAt: 1788728400 },
  ],
  '2026-09-03T18:00:00.000Z',
)

describe('the report covers every executor panda ships', () => {
  it('answers for all three, and invents no fourth', async () => {
    const reports = await readUsageReports({ homeDir: await tempHome() })
    expect(reports.map((report) => report.executorId)).toEqual(['claude-code', 'codex', 'opencode'])
  })

  it('states codex and opencode as ABSENT with a reason, never a zero (E3)', async () => {
    const reports = byId(await readUsageReports({ homeDir: await tempHome() }))

    for (const executorId of ['codex', 'opencode']) {
      const report = reports.get(executorId)
      // The clause AC-3 asks for, and it fails on all three wrong answers.
      // ERROR: a report that threw would never have reached this line, and an
      // absence is not an error — `readUsageReports` resolved.
      if (report === undefined) throw new Error(`'${executorId}' produced no row at all`)
      // BLANK: the row exists and carries a stated reason.
      expect(report.kind, `'${executorId}' must be stated absent`).toBe('absent')
      if (report.kind !== 'absent') throw new Error('unreachable')
      expect(report.reason).toBe(USAGE_ABSENCE_REASONS.noUsageSurface)
      expect(report.detail).toContain('publishes no usage surface')
      // ZERO: no utilisation figure exists anywhere in the row, of any value.
      // A `0` for an executor panda cannot measure reads as a measurement that
      // was taken, which is worse than the absence it replaced.
      expect(JSON.stringify(report)).not.toContain('utilization')
      expect(JSON.stringify(report)).not.toContain('windows')
      expect(Object.hasOwn(report, 'windows')).toBe(false)
    }
  })

  it('states claude as not-yet-observed, and NAMES the command that records one (E4)', async () => {
    const report = byId(await readUsageReports({ homeDir: await tempHome() })).get('claude-code')

    expect(report?.kind).toBe('absent')
    if (report?.kind !== 'absent') throw new Error('unreachable')
    // A DIFFERENT reason from codex's, because they are different situations
    // with different exits: one has nothing to read, the other has not read yet.
    expect(report.reason).toBe(USAGE_ABSENCE_REASONS.notObserved)
    expect(report.reason).not.toBe(USAGE_ABSENCE_REASONS.noUsageSurface)
    expect(report.detail).toContain('panda run')
    expect(report.detail).toContain('--executor claude-code')
  })
})

describe('a reading survives the run that took it', () => {
  it('round-trips the vendor values and the instant, unchanged', async () => {
    const homeDir = await tempHome()
    await recordUsageObservation(OBSERVATION, { homeDir })

    const report = byId(await readUsageReports({ homeDir })).get('claude-code')
    expect(report).toEqual(OBSERVATION)
    // The file lives under panda's own directory and nowhere else.
    expect(usageObservationsPath(homeDir)).toBe(join(homeDir, '.panda', 'usage-observations.json'))
    await expect(readFile(usageObservationsPath(homeDir), 'utf8')).resolves.toContain('five_hour')
  })

  it('replaces the previous reading rather than accumulating history', async () => {
    const homeDir = await tempHome()
    await recordUsageObservation(OBSERVATION, { homeDir })
    const later = usageObservation(
      'claude-code',
      [{ name: 'five_hour', utilization: 0.55, resetsAt: 1788491400 }],
      '2026-09-03T19:00:00.000Z',
    )
    await recordUsageObservation(later, { homeDir })

    const report = byId(await readUsageReports({ homeDir })).get('claude-code')
    expect(report).toEqual(later)
    // "How much is left" is only answered by the newest reading; a log of past
    // utilisations is a different feature and nothing reads one.
    await expect(readFile(usageObservationsPath(homeDir), 'utf8')).resolves.not.toContain('0.13')
  })

  it('keeps readings for different executors side by side', async () => {
    const homeDir = await tempHome()
    await recordUsageObservation(OBSERVATION, { homeDir })
    // A record for an executor whose traits declare no surface must not be able
    // to invent a row: the catalogue decides, not the file.
    await recordUsageObservation(usageObservation('codex', [{ name: 'x', utilization: 1, resetsAt: 2 }], 'then'), {
      homeDir,
    })

    const reports = byId(await readUsageReports({ homeDir }))
    expect(reports.get('claude-code')).toEqual(OBSERVATION)
    expect(reports.get('codex')?.kind).toBe('absent')
  })
})

describe('a document panda can no longer read is absence, not a failure', () => {
  it.each([
    ['unparseable bytes', 'not json at all'],
    ['a version this build does not speak', JSON.stringify({ version: 99, reports: { 'claude-code': OBSERVATION } })],
    ['a report of the wrong shape', JSON.stringify({ version: 1, reports: { 'claude-code': { kind: 'observed' } } })],
    [
      'a report filed under the wrong id',
      JSON.stringify({ version: 1, reports: { codex: OBSERVATION } }),
    ],
  ])('reports not-observed for %s instead of throwing', async (_label, contents) => {
    const homeDir = await tempHome()
    const path = usageObservationsPath(homeDir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, 'utf8')

    const report = byId(await readUsageReports({ homeDir })).get('claude-code')
    expect(report?.kind).toBe('absent')
    if (report?.kind !== 'absent') throw new Error('unreachable')
    expect(report.reason).toBe(USAGE_ABSENCE_REASONS.notObserved)
  })

  it('keeps the readable entries beside an unreadable one', async () => {
    // Per ENTRY, not per document: the control for the clause above, without
    // which "tolerates a bad file" could just mean "ignores the whole file".
    const homeDir = await tempHome()
    const path = usageObservationsPath(homeDir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({ version: 1, reports: { 'claude-code': OBSERVATION, codex: { kind: 'nonsense' } } }),
      'utf8',
    )

    expect(byId(await readUsageReports({ homeDir })).get('claude-code')).toEqual(OBSERVATION)
  })
})
