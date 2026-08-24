import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = join(import.meta.dirname, '..')

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? collectSourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

function relativeImportsOf(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined && specifier.startsWith('.'))
}

describe('@panda/kernel zero-dependency invariant', () => {
  it('declares no runtime dependencies or peer dependencies (AD-1/AD-2)', () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg['dependencies'] ?? {}).toEqual({})
    expect(pkg['peerDependencies'] ?? {}).toEqual({})
  })

  it('never imports @panda/contracts from kernel sources (AD-1)', () => {
    const sources = collectSourceFiles(join(packageDir, 'src'))
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/@panda\/contracts/)
    }
  })

  it('never imports outside the kernel package through relative paths (AD-1)', () => {
    const sources = [...collectSourceFiles(join(packageDir, 'src')), ...collectSourceFiles(join(packageDir, 'test'))]
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      for (const specifier of relativeImportsOf(readFileSync(file, 'utf8'))) {
        const resolvedPath = resolve(dirname(file), specifier)
        const escapesPackage = !resolvedPath.startsWith(packageDir + sep)
        expect(escapesPackage, `${file} imports '${specifier}' which resolves outside @panda/kernel`).toBe(false)
      }
    }
  })

  it('captures static, dynamic, and re-export import forms in the escape scan', () => {
    expect(relativeImportsOf(`import x from '../outside/a'`)).toEqual(['../outside/a'])
    expect(relativeImportsOf(`const m = await import('../outside/b')`)).toEqual(['../outside/b'])
    expect(relativeImportsOf(`export * from '../outside/c'`)).toEqual(['../outside/c'])
  })
})
