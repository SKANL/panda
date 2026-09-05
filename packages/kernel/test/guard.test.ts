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

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined)
}

function relativeImportsOf(source: string): string[] {
  return importsOf(source).filter((specifier) => specifier.startsWith('.'))
}

describe('@skanl/panda-kernel zero-dependency invariant', () => {
  it('declares no runtime dependencies or peer dependencies (AD-1/AD-2)', () => {
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg['dependencies'] ?? {}).toEqual({})
    expect(pkg['peerDependencies'] ?? {}).toEqual({})
  })

  it('exports exactly one entry point, so the surface pins cannot be bypassed by the manifest', () => {
    // The exported-surface pins read `src/index.ts`. Adding `"./src/*": "./src/*"`
    // here would expose every internal module — a raw runner included — with the
    // whole gate green, because nothing else watches this map.
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(pkg['exports'] as Record<string, unknown>)).toEqual(['.'])
  })

  it('never imports @skanl/panda-contracts from kernel sources (AD-1)', () => {
    // `test` is scanned too: a kernel TEST importing the contracts package is the
    // same violation, and only eslint would have noticed. The scan reads IMPORT
    // SPECIFIERS rather than raw text, so naming the package in a comment or a
    // test title is not a violation — and this file names it in both.
    const sources = [...collectSourceFiles(join(packageDir, 'src')), ...collectSourceFiles(join(packageDir, 'test'))]
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        expect(specifier.startsWith('@skanl/panda-contracts'), `${file} imports '${specifier}'`).toBe(false)
      }
    }
  })

  it('never imports outside the kernel package through relative paths (AD-1)', () => {
    const sources = [...collectSourceFiles(join(packageDir, 'src')), ...collectSourceFiles(join(packageDir, 'test'))]
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      for (const specifier of relativeImportsOf(readFileSync(file, 'utf8'))) {
        const resolvedPath = resolve(dirname(file), specifier)
        const escapesPackage = !resolvedPath.startsWith(packageDir + sep)
        expect(escapesPackage, `${file} imports '${specifier}' which resolves outside @skanl/panda-kernel`).toBe(false)
      }
    }
  })

  it('captures static, dynamic, and re-export import forms in the escape scan', () => {
    // The bare-specifier scan shares this extractor, so this covers both clauses.
    // The package name is interpolated so this fixture is not itself an import the
    // scan above would flag — the extractor is deliberately naive about context.
    const banned = `@skanl/panda-${'contracts'}`
    expect(importsOf(`import { PandaError } from '${banned}'`)).toEqual([banned])
    expect(relativeImportsOf(`import x from '../outside/a'`)).toEqual(['../outside/a'])
    expect(relativeImportsOf(`const m = await import('../outside/b')`)).toEqual(['../outside/b'])
    expect(relativeImportsOf(`export * from '../outside/c'`)).toEqual(['../outside/c'])
  })
})
