import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packagesDir = join(import.meta.dirname, '..', '..')

/**
 * A package that IMPORTS a value from a sibling at runtime must DECLARE it as a
 * dependency.
 *
 * WHY THIS EXISTS. `@skanl/panda-cli` carried `@skanl/panda-contracts` in
 * `devDependencies` while `src/run.ts:1` imported `PANDA_VERSION` from it at the
 * top level. Everything was green: `pnpm check` resolves through the workspace,
 * and a consumer install resolves it too because npm hoists the whole tree flat.
 * Under a NESTED or strict layout — `npm i --install-strategy=nested`, or pnpm
 * without hoisting — the published binary cannot start at all, and not only for
 * `--version`: it is a top-level ESM import, so every command dies with
 * `ERR_MODULE_NOT_FOUND` before argv is read.
 *
 * `topology.test.ts` scans the same imports and asks a different question — the
 * TIER ORDER, whether the graph runs strictly downward. A package may sit at a
 * legal tier and still not declare what it imports. Two questions, two files,
 * rather than one file that answers whichever it was asked last.
 *
 * `consumer-install.proof.ts` could not catch it either, and its own comment says
 * why in a neighbouring clause: it asserts that entry points RESOLVE and that
 * declared `@skanl/*` ranges match the packed version. Resolution under a hoisted
 * install is exactly the condition that hides this.
 *
 * TYPE-ONLY IMPORTS ARE EXCLUDED, and that is the whole subtlety. `import type
 * { PluginFactory } from '@skanl/panda-kernel'` erases at compile time and needs
 * nothing at runtime — four packages take only types from the kernel and would
 * be wrongly accused by a rule that read specifiers alone.
 */

/** `src/` only: a test importing anything is a consumer, not a shipped path. */
function sourceFilesOf(packageDir: string): string[] {
  const src = join(packagesDir, packageDir, 'src')
  if (!existsSync(src)) return []
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '__scratch' || entry.name === 'node_modules') return []
      const path = join(dir, entry.name)
      return entry.isDirectory() ? walk(path) : entry.name.endsWith('.ts') ? [path] : []
    })
  return walk(src)
}

/**
 * Every sibling package a source file needs AT RUNTIME.
 *
 * `import type …` and the inline `type` specifier are both erased, so neither
 * counts. A bare `import '@skanl/panda-x'` for side effects does count, which is
 * why the pattern does not require a binding clause.
 */
export function runtimeImportsOf(source: string): string[] {
  const found = new Set<string>()
  const statements = source.matchAll(/(?:^|\n)\s*(?:import|export)\s+([^;]*?)from\s*['"]([^'"]+)['"]/g)
  for (const statement of statements) {
    const clause = statement[1] ?? ''
    const specifier = statement[2] ?? ''
    if (/^\s*type\s/.test(clause)) continue
    const name = packageNameOf(specifier)
    if (name !== undefined) found.add(name)
  }
  // Side-effect and dynamic forms carry no binding clause to inspect, so they are
  // runtime by construction.
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)) {
    const name = packageNameOf(match[1] ?? match[2] ?? '')
    if (name !== undefined) found.add(name)
  }
  return [...found].sort()
}

/** `@skanl/panda-contracts/validation` and `@skanl/panda-contracts` are one dependency. */
function packageNameOf(specifier: string): string | undefined {
  if (!specifier.startsWith('@skanl/panda-')) return undefined
  const rest = specifier.slice('@skanl/'.length).split('/')[0]
  return rest === undefined || rest === '' ? undefined : `@skanl/${rest}`
}

function packagesWithSource(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'src')))
    .map((entry) => entry.name)
    .sort()
}

/**
 * The rule, as a pure function so it can be driven with input it knows is wrong.
 * A green scan over a clean tree proves nothing on its own.
 */
export function undeclaredRuntimeDeps(
  packageName: string,
  imported: readonly string[],
  declared: readonly string[],
): string[] {
  return imported
    .filter((name) => name !== packageName && !declared.includes(name))
    .map((name) => `${packageName}: imports ${name} at runtime but does not declare it in dependencies`)
}

describe('a runtime import is a declared dependency', () => {
  it('holds for every package', () => {
    const problems = packagesWithSource().flatMap((dir) => {
      const manifest = JSON.parse(
        readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'),
      ) as { readonly name?: string; readonly dependencies?: Record<string, string> }
      const imported = [
        ...new Set(sourceFilesOf(dir).flatMap((file) => runtimeImportsOf(readFileSync(file, 'utf8')))),
      ].sort()
      return undeclaredRuntimeDeps(
        manifest.name ?? dir,
        imported,
        Object.keys(manifest.dependencies ?? {}),
      )
    })
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('REDDENS on the exact shape that shipped', () => {
    // `@skanl/panda-cli` importing `PANDA_VERSION` from contracts while contracts
    // sat in devDependencies.
    const problems = undeclaredRuntimeDeps(
      '@skanl/panda-cli',
      ['@skanl/panda-contracts', '@skanl/panda-session'],
      ['@skanl/panda-session'],
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('@skanl/panda-contracts')
  })

  it('CONTROL: says nothing when everything imported is declared', () => {
    // Without this the clause above is satisfied by a checker that complains
    // about everything, which is the same green as one that checks nothing.
    expect(
      undeclaredRuntimeDeps('@skanl/panda-cli', ['@skanl/panda-session'], ['@skanl/panda-session']),
    ).toEqual([])
  })

  it('reads a VALUE import and ignores a type-only one', () => {
    // The subtlety the rule turns on: four packages take only types from the
    // kernel, and a scanner that read specifiers alone would accuse all four.
    expect(runtimeImportsOf(`import { createKernel } from '@skanl/panda-kernel'`)).toEqual([
      '@skanl/panda-kernel',
    ])
    expect(runtimeImportsOf(`import type { PluginFactory } from '@skanl/panda-kernel'`)).toEqual([])
    expect(runtimeImportsOf(`import '@skanl/panda-kernel'`)).toEqual(['@skanl/panda-kernel'])
    expect(runtimeImportsOf(`import { isRecord } from '@skanl/panda-contracts/validation'`)).toEqual([
      '@skanl/panda-contracts',
    ])
    expect(runtimeImportsOf(`import { readFileSync } from 'node:fs'`)).toEqual([])
    expect(runtimeImportsOf(`import { local } from './sibling.ts'`)).toEqual([])
  })

  it('CONTROL: the scan reaches real sources', () => {
    // A zero from the first clause would otherwise be indistinguishable from a
    // walk that found no files at all.
    const packages = packagesWithSource()
    expect(packages.length).toBeGreaterThan(10)
    expect(sourceFilesOf('cli').length).toBeGreaterThan(0)
  })
})
