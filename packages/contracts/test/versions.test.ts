import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSemver } from '../src'

const packagesDir = join(import.meta.dirname, '..', '..')

/**
 * NFR-8's FIRST clause, wired instead of written.
 *
 * `epics.md` states it as "Contracts semver together; deprecation warned >= 2
 * minor releases before major removal". The second half needs releases nobody
 * has cut. The first half is checkable today, at whatever version the packages
 * carry, and `ROADMAP-02` named its absence: "NFR-8 ... Unimplementable while
 * every package is private and unversioned. It is the same finding as
 * distribution, wearing a different number."
 *
 * That reads as though the NUMBER were the blocker. It is not. "Together" is a
 * statement about twelve manifests AGREEING, and twelve manifests can disagree
 * at `0.0.0` exactly as easily as at `1.4.2` — the day someone bumps one
 * package to fix one thing. This gate is the half that does not need a release
 * to be true, and it makes any future bump safe: move one and the run reddens
 * naming the odd one out.
 *
 * DELIBERATELY NOT a single source of truth in a thirteenth file. Twelve
 * manifests agreeing IS the source of truth; a `version.json` they must match is
 * one more place for the number to be wrong.
 *
 * SCOPE, said out loud. This is the NPM PACKAGE version. The `version` a plugin
 * declares in its kernel manifest is a different axis — `kernel/src/manifest.ts`
 * binds it to NFR-8 in a comment, and measured, nothing reads it back — so the
 * three plugin literals are out of scope here and are not compared against
 * these. A gate covering both would tie two numbers that no code compares.
 */

interface Manifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly private?: unknown
  readonly publishConfig?: { readonly access?: unknown }
}

/** Every directory under `packages/` that actually holds sources. */
function packagesWithSource(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'src')))
    .map((entry) => entry.name)
    .sort()
}

function manifestOf(packageDir: string): Manifest {
  return JSON.parse(readFileSync(join(packagesDir, packageDir, 'package.json'), 'utf8')) as Manifest
}

/**
 * The rule itself, over a list of `[package, version]` pairs.
 *
 * Extracted so the clauses below can DRIVE it with known-bad input. A checker
 * only ever run against the real tree passes for a reason nobody has tested,
 * which is this repository's own lesson about an instrument needing its own
 * control.
 */
function versionDisagreements(
  versions: readonly (readonly [string, unknown])[],
): readonly string[] {
  const problems: string[] = []
  for (const [name, version] of versions) {
    if (!isSemver(version)) problems.push(`${name}: ${JSON.stringify(version)} is not semver`)
  }
  const distinct = [...new Set(versions.map(([, version]) => String(version)))].sort()
  if (distinct.length > 1) {
    problems.push(`versions disagree: ${distinct.join(' vs ')}`)
  }
  return problems
}

describe('the Contracts version together (NFR-8)', () => {
  const packages = packagesWithSource()

  it('scans every package that has sources, and there is more than one', () => {
    // The control for every clause below. A run that scanned nothing would
    // satisfy "no disagreements" and "all semver" perfectly.
    expect(packages.length).toBeGreaterThan(1)
    expect(packages).toContain('contracts')
  })

  it('carries one valid semver across every manifest', () => {
    const versions = packages.map((name) => [name, manifestOf(name).version] as const)
    expect(versionDisagreements(versions)).toEqual([])
  })

  it('keeps every package PUBLISHABLE, because publishing is a decision that was taken', () => {
    // This clause used to assert the OPPOSITE — `private === true` on all of
    // them — and it was right to: `spec-m3a` listed removing `private` as Ask
    // First, and this is what stopped it being removed by accident. The owner
    // answered the question in M37.A, so the gate now pins the new decision
    // instead of being deleted. A guarantee that changes direction still needs
    // something that fails when it is violated.
    //
    // Two properties, each wrong on its own:
    //   - `private` present at all -> npm refuses the publish outright, loudly.
    //   - `publishConfig.access` not 'public' -> a SCOPED package defaults to
    //     restricted, so the publish SUCCEEDS and the package is unusable. That
    //     is the quiet one, and the reason it is asserted beside the loud one.
    const problems = packages.flatMap((name) => {
      const manifest = manifestOf(name)
      const found: string[] = []
      if (manifest.private !== undefined) found.push(`${name}: still carries \`private\``)
      if (manifest.publishConfig?.access !== 'public') {
        found.push(`${name}: publishConfig.access is ${String(manifest.publishConfig?.access)}, not 'public'`)
      }
      return found
    })
    expect(problems, problems.join('\n')).toEqual([])
  })

  it.each([
    ['one package moved alone', [['a', '0.1.0'], ['b', '0.0.0']], 'versions disagree'],
    ['a version that is not semver', [['a', '1.0'], ['b', '1.0']], 'is not semver'],
    ['a v-prefixed tag', [['a', 'v1.0.0'], ['b', 'v1.0.0']], 'is not semver'],
    ['a leading zero', [['a', '01.0.0'], ['b', '01.0.0']], 'is not semver'],
    ['a missing version', [['a', undefined], ['b', undefined]], 'is not semver'],
  ] as readonly (readonly [string, readonly (readonly [string, unknown])[], string])[])(
    'REDDENS on %s',
    (_label, versions, needle) => {
      const problems = versionDisagreements(versions)
      expect(problems.length).toBeGreaterThan(0)
      expect(problems.join(' | ')).toContain(needle)
    },
  )

  it('CONTROL: says nothing about a set that agrees and is valid', () => {
    // Without this the clauses above are satisfied by a checker that complains
    // about everything, which is the same green as one that checks nothing.
    expect(
      versionDisagreements([
        ['a', '0.0.0'],
        ['b', '0.0.0'],
        ['c', '0.0.0'],
      ]),
    ).toEqual([])
    expect(
      versionDisagreements([
        ['a', '1.4.2-rc.1'],
        ['b', '1.4.2-rc.1'],
      ]),
    ).toEqual([])
  })
})
