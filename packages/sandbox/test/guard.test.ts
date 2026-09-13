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

function workspaceImportsOf(files: readonly string[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)]
          .map((match) => match[1])
          .filter((specifier): specifier is string => specifier?.startsWith('@skanl/panda-') ?? false),
      ),
    ),
  ].sort()
}

describe('@skanl/panda-sandbox dependency boundary', () => {
  it('declares and imports only @skanl/panda-contracts at runtime', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['@skanl/panda-contracts'])
    expect(workspaceImportsOf(collectSourceFiles(join(packageDir, 'src')))).toEqual(['@skanl/panda-contracts'])
  })
})
