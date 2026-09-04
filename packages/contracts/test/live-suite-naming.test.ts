import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packagesDir = join(import.meta.dirname, '..', '..')

/**
 * THE EXCLUSION GLOB IS A THING A HUMAN TYPES, SO IT CANNOT ENFORCE ITSELF.
 *
 * Live suites drive real vendor binaries over the network. Every gate run in
 * this repository excludes them with a glob on a command line, and
 * `AGENTS.md` teaches that glob. `deferred-work.md` already recorded one
 * generation of this defect: `**\/*.live.test.ts` (WITH a dot) silently missed
 * `confinement-live.test.ts`, so several sessions of "live excluded" runs were
 * quietly running it and reading its flake as a break. The remedy recorded
 * there was a wider glob, `**\/*live.test.ts`, and the entry was closed.
 *
 * That remedy has ALREADY EXPIRED. Measured at HEAD:
 *
 *     vitest list --exclude '**\/*live.test.ts'  still lists  live-smoke.test.ts
 *     vitest list                                 lists all four adapter-cli live files
 *
 * A third naming style arrived — `live-` as a PREFIX — and a suffix glob
 * cannot cover a prefix. So the same defect shipped twice, the second time
 * against a ledger entry that said it was fixed and against the sentence in
 * `AGENTS.md` that teaches the fix.
 *
 * A wider glob would be a third guess. This is the gate instead: the canonical
 * pattern is checked against the FILESYSTEM, in BOTH directions, so a live
 * suite named in a fourth style fails here rather than running silently inside
 * a run that believed it was excluded.
 *
 * WHAT THIS DOES NOT FIX, and it is the honest upgrade path: each live suite
 * carries its OWN opt-out variable — `PANDA_LIVE_SMOKE`, `PANDA_LIVE_USAGE`,
 * `PANDA_LIVE_SKILLS` — so there is no single switch, and turning live suites
 * off by environment means knowing every name. That is the same parallel-list
 * shape `packages/cli/test/executor-catalogue-parity.test.ts` was written
 * about. One shared `PANDA_LIVE=0` honoured by all of them, gated here, is the
 * fix; it touches every live file and is deliberately not bundled into the
 * change that stops the bleeding.
 */

/** The glob every gate run must use, kept here so the docs quote the gate. */
export const LIVE_EXCLUDE_GLOB = '**/*live*.test.ts'

/**
 * EVERY live suite, named rather than matched.
 *
 * The list is the point. A pattern that decides which files are live is
 * circular — it can tell you the glob covers what the glob matches and nothing
 * more — and the wide glob has a real hazard in the other direction: `live` is a
 * SUBSTRING of ordinary English. `delivery.test.ts` matches it, and a suite
 * silently excluded is a worse defect than the one this gate was written for.
 *
 * Measured at HEAD: no such collision exists today (the wide glob matches
 * exactly these files, control — the same listing without the exclude returns
 * all of them). A future one fails HERE, loudly, instead of quietly not running.
 *
 * Same idiom as `topology.test.ts`'s tier map, and for the same stated reason: a
 * rule that quietly classifies a new file is a rule that classifies it wrongly
 * one day.
 */
const LIVE_SUITES: readonly string[] = [
  'adapter-cli/test/confinement-live.test.ts',
  'adapter-cli/test/live-smoke.test.ts',
  'adapter-cli/test/stream-mode-live.test.ts',
  'adapter-cli/test/usage-live.test.ts',
  'cli/test/status-live.test.ts',
  'projection/test/codex-strict-config.live.test.ts',
  'projection/test/skills-discovery.live.test.ts',
]

/** Every `*.test.ts` under any package's `test/` directory, package-relative. */
function everyTestFile(): string[] {
  const found: string[] = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const testDir = join(packagesDir, entry.name, 'test')
    if (!existsSync(testDir)) continue
    for (const file of readdirSync(testDir, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.test.ts')) found.push(`${entry.name}/test/${file.name}`)
    }
  }
  return found.sort()
}

/** The same decision the exclusion glob makes, on a filename. */
function matchesLiveGlob(packageRelativePath: string): boolean {
  const name = packageRelativePath.slice(packageRelativePath.lastIndexOf('/') + 1)
  return name.includes('live') && name.endsWith('.test.ts')
}

describe('the live-suite exclusion covers every live suite, and nothing else', () => {
  const testFiles = everyTestFile()
  // This gate's own file contains `live` and is NOT a live suite; excluding it
  // by name here rather than listing it above keeps the roster honest about
  // what actually drives a vendor.
  const candidates = testFiles.filter((path) => !path.endsWith('/live-suite-naming.test.ts'))

  it('scans a real corpus of test files', () => {
    // The control for every clause below. A run that found no files would
    // satisfy "every live suite is covered" perfectly.
    expect(testFiles.length).toBeGreaterThan(50)
    expect(testFiles).toContain('contracts/test/live-suite-naming.test.ts')
  })

  it('matches the roster exactly, in both directions', () => {
    // ONE direction catches the measured defect: a live suite the glob misses
    // runs a real vendor call inside a gate that reported it excluded. The OTHER
    // catches the hazard the wide glob introduces: an ordinary suite whose name
    // happens to contain `live` and would be silently skipped.
    expect(candidates.filter(matchesLiveGlob)).toEqual([...LIVE_SUITES].sort())
  })

  it('names a roster whose every entry still exists', () => {
    // A renamed or deleted live suite must fail here rather than shrink the
    // roster silently, which is the same rot the previous remedy died of.
    expect(LIVE_SUITES.filter((path) => !testFiles.includes(path))).toEqual([])
  })

  it('covers all three naming styles that exist, by example', () => {
    // Named rather than counted, so a rename that drops a style is visible.
    // These are the exact shapes the glob has to survive: a dash SUFFIX, a dot,
    // and the dash PREFIX that expired the previous remedy.
    for (const example of [
      'adapter-cli/test/confinement-live.test.ts',
      'projection/test/skills-discovery.live.test.ts',
      'adapter-cli/test/live-smoke.test.ts',
    ]) {
      expect(LIVE_SUITES).toContain(example)
      expect(matchesLiveGlob(example), `${example} escapes ${LIVE_EXCLUDE_GLOB}`).toBe(true)
    }
  })

  it('DRIVES the matcher, including the collision the roster exists to catch', () => {
    // A green run must mean the matcher discriminates, not that it says yes to
    // everything. The fourth row is the honest one: `delivery` CONTAINS `live`,
    // the wide glob does match it, and that is precisely why the roster is a
    // list and not a pattern.
    expect(matchesLiveGlob('x/test/usage-live.test.ts')).toBe(true)
    expect(matchesLiveGlob('x/test/live-smoke.test.ts')).toBe(true)
    expect(matchesLiveGlob('x/test/a.live.test.ts')).toBe(true)
    expect(matchesLiveGlob('x/test/delivery.test.ts')).toBe(true)
    expect(matchesLiveGlob('x/test/bundle.test.ts')).toBe(false)
  })
})
