import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packagesDir = join(import.meta.dirname, '..', '..')

/**
 * AD-2's ONE universal clause, derived once for all ten packages.
 *
 * The four `test/guard.test.ts` files in `environment`, `kernel`, `projection`
 * and `session` are NOT duplicated here and are not replaced: they carry
 * package-SPECIFIC clauses no generic checker can express — `@panda/environment`
 * permits only `access`, `constants`, `mkdir` and `stat` from the filesystem and
 * forbids the literal string `atomicWriteText`. What this file adds is the
 * clause that is the SAME for every package and is therefore a fact about the
 * GRAPH rather than about any package: strictly-downward `@panda/*` imports.
 * Writing it six more times would be six spellings of one rule, which is how two
 * answers come to disagree.
 *
 * It lives in `contracts` because that is the package every other one sits on,
 * and because it is the package that had no guard.
 *
 * SCOPE, said out loud rather than implied: `src/` only. A `test/` importing
 * anywhere is deliberately out of the tier rule — a test is a consumer, and the
 * two guards that DO want their tests scanned (`kernel`, `environment`) scan
 * them themselves, with reasons specific to those packages.
 */

/**
 * The declared role order, lowest first, restated from
 * `_bmad-output/planning-artifacts/architecture/architecture-panda-2026-08-24/ARCHITECTURE-SPINE.md`
 * (AD-2, the `flowchart BT`). A mermaid diagram is not executable, so the
 * restatement is the thing under test — and both directions of rot are checked
 * below, because an order that silently stops naming reality is worse than none.
 *
 * How the spine's ROLES map onto the ten directories:
 * - tier 0 — `KERNEL --> (no deps, not even contracts)` and
 *   `CONTRACTS --> (no external runtime deps)`. Tier 0 with nothing beneath it
 *   IS AD-1: `dependencyTier >= tier` is true for every possible import, so the
 *   kernel's empty allowlist needs no special case. The kernel's own guard keeps
 *   its richer clauses; this one agrees with it rather than replacing it.
 * - tier 1 — the spine's `IMPL["adapter-* · memory-* · workspace-* · projection"]`,
 *   plus `registry`, which is an implementation of the Registry ports in exactly
 *   the same sense and imports exactly the same set.
 * - tier 2 — the CONSUMER packages that compose implementations. The spine does
 *   not name them individually; `packages/environment/test/guard.test.ts` does,
 *   in its own words: "`@panda/environment` is CONSUMER tier, exactly like
 *   `@panda/session`". Two consumer packages at the same tier may not import each
 *   other, which is what "strictly" downward buys.
 * - tier 3 — `CLI --> KERNEL`, `CLI --> CONTRACTS`, `CLI --> IMPL`: the CLI sits
 *   on everything.
 */
const TIER: Readonly<Record<string, number>> = {
  kernel: 0,
  contracts: 0,
  'adapter-cli': 1,
  projection: 1,
  registry: 1,
  'workspace-git-worktree': 1,
  'workspace-local': 1,
  environment: 2,
  session: 2,
  cli: 3,
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__scratch' || entry.name === 'node_modules') return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? collectSourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

/**
 * Static, dynamic and re-export forms alike — the same extractor the kernel and
 * environment guards use. It reads IMPORT SPECIFIERS rather than raw text, so
 * naming a package in a comment or a test title is not a violation, and this
 * file names several.
 */
function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined)
}

/**
 * The package a specifier names, or `undefined` when it names none.
 * `@panda/contracts/validation` and `@panda/contracts` are one dependency.
 */
function packageNameOf(specifier: string): string | undefined {
  return specifier.startsWith('@panda/') ? specifier.slice('@panda/'.length).split('/')[0] : undefined
}

function workspaceDependenciesOf(files: readonly string[]): string[] {
  const found = new Set<string>()
  for (const file of files) {
    for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
      const name = packageNameOf(specifier)
      if (name !== undefined && name !== '') found.add(name)
    }
  }
  return [...found].sort()
}

/**
 * The rule itself, as a pure function so it can be falsified without planting a
 * file. A green scan over a clean tree says nothing on its own; the clause at the
 * bottom of this file drives THIS with imports it knows are wrong.
 */
function violationsFor(packageName: string, dependencies: readonly string[]): string[] {
  const tier = TIER[packageName]
  if (tier === undefined) return [`@panda/${packageName} has no declared tier`]
  return dependencies.flatMap((dependency) => {
    const dependencyTier = TIER[dependency]
    if (dependencyTier === undefined) {
      return [`@panda/${packageName} (tier ${tier}) imports @panda/${dependency}, which the declared order does not name`]
    }
    // Strictly downward: a SIBLING at the same tier is a violation too. Two
    // packages at one tier importing each other are one package with two names.
    return dependencyTier >= tier
      ? [
          `@panda/${packageName} (tier ${tier}) imports @panda/${dependency} (tier ${dependencyTier}) — imports must be strictly downward`,
        ]
      : []
  })
}

/** Every directory under `packages/` that actually holds sources. */
function packagesWithSource(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'src')))
    .map((entry) => entry.name)
    .sort()
}

describe('package topology is strictly downward (AD-2)', () => {
  it('declares a tier for every package, and names no package that is gone', () => {
    // BOTH directions, because the order must not rot either way. A package
    // added to `packages/` and not placed in the order would otherwise be
    // scanned against `tier === undefined` and silently treated as fine, which
    // is the hole this gate exists to close; a tier left behind by a deleted
    // package is the same defect pointing the other way.
    expect(Object.keys(TIER).sort()).toEqual(packagesWithSource())
  })

  it('reports zero upward or sibling @panda/* imports across every package src', () => {
    const violations: string[] = []
    let scanned = 0
    for (const packageName of packagesWithSource()) {
      const files = collectSourceFiles(join(packagesDir, packageName, 'src'))
      scanned += files.length
      violations.push(...violationsFor(packageName, workspaceDependenciesOf(files)))
    }
    // A zero without a control means "I did not look". This is the cheap half:
    // the scan reached real files in every package. The expensive half is the
    // clause below, which drives the rule with imports known to be wrong.
    expect(scanned).toBeGreaterThan(Object.keys(TIER).length)
    expect(violations, `AD-2 violations:\n${violations.join('\n')}`).toEqual([])
  })

  it('flags an upward import, a sibling import, and an unknown package', () => {
    // Every failure mode of the matrix, driven rather than described.
    expect(violationsFor('contracts', ['session'])).toEqual([
      '@panda/contracts (tier 0) imports @panda/session (tier 2) — imports must be strictly downward',
    ])
    expect(violationsFor('contracts', ['kernel'])).toEqual([
      '@panda/contracts (tier 0) imports @panda/kernel (tier 0) — imports must be strictly downward',
    ])
    // AD-1 falls out of tier 0 rather than being restated: the kernel may import
    // nothing at all, contracts included.
    expect(violationsFor('kernel', ['contracts'])).toEqual([
      '@panda/kernel (tier 0) imports @panda/contracts (tier 0) — imports must be strictly downward',
    ])
    expect(violationsFor('cli', ['not-a-package'])).toEqual([
      '@panda/cli (tier 3) imports @panda/not-a-package, which the declared order does not name',
    ])
    expect(violationsFor('brand-new', ['contracts'])).toEqual(['@panda/brand-new has no declared tier'])
    // And the shape that must NOT fire, or every row above proves only that the
    // function returns strings.
    expect(violationsFor('cli', ['contracts', 'kernel', 'session'])).toEqual([])
  })

  it('extracts a package name from every import form, subpaths included', () => {
    // The scan is only as good as this: a specifier form it cannot see is a
    // violation it cannot report.
    // The package names are interpolated so this fixture is not itself an import
    // the scan above would flag — the extractor is deliberately naive about context.
    const kernel = `@panda/${'kernel'}`
    expect(
      [
        `import { a } from '${kernel}'`,
        `const m = await import("${kernel}")`,
        `export * from '${kernel}/deep/path'`,
        `import type { B } from '@panda/${'contracts'}/validation'`,
        `import { readFileSync } from 'node:fs'`,
        `import { local } from './sibling.ts'`,
      ].flatMap((source) => importsOf(source).map(packageNameOf)),
    ).toEqual(['kernel', 'kernel', 'kernel', 'contracts', undefined, undefined])
  })
})
