import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = join(import.meta.dirname, '..')

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    // `__scratch/` is git-ignored test scratch; recursing into a leftover probe
    // turns the gate red for something that is not source.
    if (entry.name === '__scratch' || entry.name === 'node_modules') return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? collectSourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined)
}

function workspaceImportsOf(files: readonly string[]): Set<string> {
  const found = new Set<string>()
  for (const file of files) {
    for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('@skanl/panda-')) found.add(specifier)
    }
  }
  return found
}

const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
const declaredDependencies = Object.keys((packageJson['dependencies'] ?? {}) as Record<string, unknown>)

/**
 * AD-2's topology is strictly downward. `@skanl/panda-session` is CONSUMER tier: it may
 * depend on the kernel, the contracts and the implementations it wires, and on no
 * other consumer. These pins are the mechanism behind that sentence — without
 * them the tier is a claim in a comment, and pnpm would happily resolve an import
 * of `@skanl/panda-cli` from the very package whose reason to exist is that a third
 * party does not need the CLI.
 *
 * These clauses read IMPORT SPECIFIERS, so they see `@skanl/panda-x` and not a relative
 * path out of the package. That second route is closed repo-wide by the
 * `no-restricted-imports` regex in `eslint.config.js`, which is where it belongs:
 * a lint rule sees every package, where a per-package test only ever sees one.
 */
describe('@skanl/panda-session dependency direction (AD-2)', () => {
  it('declares exactly the packages it composes', () => {
    expect([...declaredDependencies].sort()).toEqual([
      '@skanl/panda-adapter-cli',
      '@skanl/panda-contracts',
      '@skanl/panda-kernel',
      '@skanl/panda-workspace-git-worktree',
      '@skanl/panda-workspace-local',
    ])
  })

  it('imports nothing it has not declared, and declares nothing it does not import', () => {
    // Both directions on purpose: an undeclared import is a dependency that
    // happens to resolve through the workspace hoist and breaks on install
    // elsewhere; a declared-but-unused one is the tier drifting wider than the
    // code, which is how a consumer-tier package quietly becomes a god package.
    const imported = workspaceImportsOf(collectSourceFiles(join(packageDir, 'src')))
    expect([...imported].sort()).toEqual([...declaredDependencies].sort())
  })

  it('never reaches for @skanl/panda-cli, from src or from its own tests', () => {
    // The acceptance criterion is "a project that has NOT installed @skanl/panda-cli".
    // A test that imported the CLI would be exercising the wrong claim, so the
    // scan covers `test` as well as `src` — the same reason the kernel's guard
    // scans both.
    const files = [...collectSourceFiles(join(packageDir, 'src')), ...collectSourceFiles(join(packageDir, 'test'))]
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        expect(specifier.startsWith('@skanl/panda-cli'), `${file} imports '${specifier}'`).toBe(false)
      }
    }
  })

  it('exports exactly one entry point, so the surface stays the one the pins watch', () => {
    expect(Object.keys(packageJson['exports'] as Record<string, unknown>)).toEqual(['.'])
  })
})
