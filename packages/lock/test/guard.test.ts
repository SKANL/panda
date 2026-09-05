import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = join(import.meta.dirname, '..')

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
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
const sourceFiles = collectSourceFiles(join(packageDir, 'src'))
const testFiles = collectSourceFiles(join(packageDir, 'test'))

/**
 * AD-2's topology is strictly downward, and this package is the BOTTOM of it.
 * That is the whole reason it exists: `@skanl/panda-projection` needed the lockfile
 * protocol that lived in `@skanl/panda-registry`, and the `projection -> registry`
 * edge is forbidden. A leaf below both packages makes the edge unnecessary
 * instead of arguing about it — but only while it stays a leaf.
 *
 * These clauses are the mechanism, not a comment. AD-2 is currently pinned by a
 * guard test in a minority of this repo's packages, and a NEW package arriving
 * without one continues a measured trend: the sentence gets written down, the
 * import gets added two stories later, and pnpm resolves it happily.
 *
 * They read IMPORT SPECIFIERS, so they see `@skanl/panda-x` and not a relative path
 * out of the package. That second route is closed repo-wide by the
 * `no-restricted-imports` regex in `eslint.config.js`.
 */
describe('@skanl/panda-lock is a leaf (AD-2)', () => {
  it('has sources to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(0)
    expect(testFiles.length).toBeGreaterThan(0)
  })

  it('declares exactly one dependency, and it is @skanl/panda-contracts', () => {
    expect([...declaredDependencies].sort()).toEqual(['@skanl/panda-contracts'])
  })

  it('imports nothing it has not declared, and declares nothing it does not import', () => {
    // Two assertions rather than one equality, because they fail DIFFERENTLY and
    // the first is the one that matters: an undeclared import is reported as a
    // list holding exactly the offending package and nothing else, so the
    // failure output names the edge instead of a diff of two sorted arrays.
    const imported = [...workspaceImportsOf(sourceFiles)].sort()
    expect(imported.filter((specifier) => !declaredDependencies.includes(specifier))).toEqual([])
    expect(imported).toEqual([...declaredDependencies].sort())
  })

  it('reaches no @panda package but @skanl/panda-contracts, from src OR from its own tests', () => {
    // `test` is scanned too. A leaf whose SOURCE is clean while its suite pulls
    // in `@skanl/panda-registry` still has the cycle — pnpm installs it, the module
    // graph carries it, and the only thing missing is a manifest line the
    // dependency clause above watches.
    const reached = [...workspaceImportsOf([...sourceFiles, ...testFiles])].sort()
    expect(reached.filter((specifier) => specifier !== '@skanl/panda-contracts')).toEqual([])
  })
})
