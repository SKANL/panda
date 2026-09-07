import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PANDA_VERSION, isSemver } from '../src'

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
  readonly scripts?: Readonly<Record<string, unknown>>
  readonly keywords?: unknown
  readonly bugs?: unknown
  readonly homepage?: unknown
  readonly engines?: Readonly<Record<string, unknown>>
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

  it('says the same version the manifests do', () => {
    // `PANDA_VERSION` is a LITERAL since the `readFileSync` walk it replaced
    // threw at import inside any bundle, taking 12 of 13 packages down with it.
    // A literal without this clause would be the defect the walk was avoiding —
    // a fourteenth place the number lives and nothing checking it — so the
    // clause is the whole justification for the literal. Bump the manifests and
    // forget the constant and this reddens naming both values.
    expect(PANDA_VERSION).toBe(manifestOf('contracts').version)
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

describe('every published package builds before it is packed', () => {
  it('declares a prepack, because `files: ["dist"]` ships nothing without one', () => {
    // DRIVEN, with a control: `pnpm pack` on a package whose `dist/` is absent
    // produced a 3-entry, 2056-byte tarball and EXIT 0, against 21 entries and
    // 47259 bytes with `dist/` present — the diff is exactly the 18 `dist/`
    // entries, and there is no warning anywhere.
    //
    // WHAT THAT COSTS A CONSUMER, also driven: `npm install <that tarball>`
    // exits 0 and says "added 1 package", and the failure lands later as
    // `ERR_MODULE_NOT_FOUND` naming a path inside `node_modules` — which reads
    // as "this published package is broken", not "you forgot to build". For the
    // CLI it is quieter still: npm SILENTLY SKIPS the bin shim when its target
    // is missing, so `node_modules/.bin/` does not exist and the user gets
    // `panda: command not found` from an install that reported success.
    //
    // CI and the release workflow both build first, and so does the
    // consumer-install proof. The one documented HUMAN path does not:
    // `README.md` says "Building from source still works and needs no registry:
    // `pnpm pack` produces the same tarballs the release publishes." A `prepack`
    // makes that sentence true, and both `pnpm pack` and `npm pack` honour it.
    const missing = packagesWithSource().filter(
      (name) => typeof manifestOf(name).scripts?.['prepack'] !== 'string',
    )

    // CONTROL: a scan over an empty list would pass this trivially.
    expect(packagesWithSource().length).toBeGreaterThan(10)
    expect(missing, 'these ship `files: ["dist"]` and would pack an empty tarball').toEqual([])
  })
})

describe('every published package carries the metadata npm asks for', () => {
  // npm's own reason for each, quoted from docs.npmjs.com:
  //   keywords -- "Put keywords in it. It's an array of strings. This helps
  //                people discover your package as it's listed in `npm search`."
  //   bugs     -- "The URL to your project's issue tracker and / or the email
  //                address to which issues should be reported."
  //   repository, description -- both already present on all 13.
  //
  // `keywords` is the ONE absent field npm ties to a functional outcome rather
  // than to a page rendering: without it these packages are findable only by
  // typing their exact name. `bugs` and `homepage` are what the npm page renders
  // as its sidebar links, so a reader who lands there has somewhere to go.
  //
  // NOT gated here, deliberately: `author` and `funding`, which npm's docs
  // describe and never recommend, and for which no consumer effect is
  // documented. A gate over a field nobody needs is a gate that only ever costs.
  it.each(['keywords', 'bugs', 'homepage'] as const)('declares a non-empty %s', (field) => {
    // CONTROL: a scan over an empty list would pass this trivially.
    expect(packagesWithSource().length).toBeGreaterThan(10)
    const missing = packagesWithSource().filter((name) => {
      const value = manifestOf(name)[field]
      if (Array.isArray(value)) return value.length === 0
      return typeof value !== 'string' && typeof value !== 'object'
    })
    expect(missing, `npm's docs ask for \`${field}\` on a package meant to be found and reported against`).toEqual([])
  })

  it('gives each package keywords of its OWN, not one copied list', () => {
    // A shared block pasted thirteen times is worse than none: every panda
    // package would rank identically for every query, which is the same as
    // ranking for nothing. Each must carry at least one term the others do not.
    const byPackage = new Map(
      packagesWithSource().map((name) => [name, new Set((manifestOf(name).keywords as string[]) ?? [])]),
    )
    const shared = new Set<string>()
    for (const [name, own] of byPackage) {
      for (const term of own) {
        if ([...byPackage].every(([other, terms]) => other === name || terms.has(term))) shared.add(term)
      }
    }
    const indistinct = [...byPackage]
      .filter(([, own]) => [...own].every((term) => shared.has(term)))
      .map(([name]) => name)
    expect(indistinct, 'these carry only terms every other package also carries').toEqual([])
  })
})

describe('the declared Node floor is the one CI actually runs', () => {
  // `engines` is a promise to a CONSUMER about what their runtime must be, and
  // the only thing that can keep it honest is a CI leg pinned to that exact
  // version. Declaring a floor nobody runs is a guarantee in prose; declaring
  // one CI runs is a guarantee something fails on.
  //
  // HOW THE NUMBER WAS FOUND, because it is not the obvious one. The floor was
  // `>=24`, above every comparable published package measured (peer floors run
  // 16 to 22.13; nobody declares 24). Driven, nothing in panda's source needs
  // it. Lowering it took three measurements, and the first two failed for
  // reasons that are not panda's code:
  //
  //     22.5.0   ERROR: This version of pnpm requires at least Node.js v22.13
  //     22.13.0  ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"
  //     22.18.0  green on every gate
  //
  // The first is the build toolchain, the second is two `memory-sqlite` clauses
  // spawning a child Node that imports `.ts` before native stripping was
  // unflagged. Both are DEVELOPER floors. A consumer runs `dist` and needs
  // neither, so the true consumer floor is lower still and remains unproven —
  // proving it needs a build-once-then-run-the-tarball matrix, which is
  // recorded in deferred-work rather than guessed at here.
  const workflow = readFileSync(join(packagesDir, '..', '.github', 'workflows', 'ci.yml'), 'utf8')

  it('pins a CI leg at exactly the version every manifest declares', () => {
    const declared = new Set(packagesWithSource().map((name) => manifestOf(name).engines?.['node']))
    // CONTROL: one floor across the workspace, or the question below is
    // ambiguous and the clause would be comparing against an arbitrary member.
    expect([...declared], 'the 13 manifests disagree about the Node floor').toHaveLength(1)

    const floor = [...declared][0]
    expect(typeof floor).toBe('string')
    const exact = String(floor).replace(/^>=/, '')
    expect(
      workflow,
      `every manifest declares node ${String(floor)}; CI must run that literal version, or the floor is a number nobody has tried`,
    ).toContain(`'${exact}'`)
  })
})
