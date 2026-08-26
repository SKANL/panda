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
      if (specifier.startsWith('@panda/')) found.add(specifier)
    }
  }
  return found
}

const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
const declaredDependencies = Object.keys((packageJson['dependencies'] ?? {}) as Record<string, unknown>)
const sourceFiles = collectSourceFiles(join(packageDir, 'src'))

/**
 * AD-2's topology is strictly downward. `@panda/environment` is CONSUMER tier,
 * exactly like `@panda/session`: it may depend on the kernel, the contracts and
 * the implementations it wires, and on no other consumer. These pins are the
 * mechanism behind that sentence — without them the tier is a claim in a
 * comment, and pnpm would happily resolve an import of `@panda/cli` from the
 * very package whose reason to exist is that a third party does not need it.
 *
 * These clauses read IMPORT SPECIFIERS, so they see `@panda/x` and not a
 * relative path out of the package. That second route is closed repo-wide by the
 * `no-restricted-imports` regex in `eslint.config.js`.
 */
describe('@panda/environment dependency direction (AD-2)', () => {
  it('declares exactly the packages it composes', () => {
    expect([...declaredDependencies].sort()).toEqual([
      '@panda/contracts',
      '@panda/kernel',
      '@panda/projection',
      '@panda/registry',
    ])
  })

  it('imports nothing it has not declared, and declares nothing it does not import', () => {
    expect([...workspaceImportsOf(sourceFiles)].sort()).toEqual([...declaredDependencies].sort())
  })

  it('never reaches for @panda/cli or @panda/session, from src or from its own tests', () => {
    // The acceptance criterion is "a project that has NOT installed @panda/cli",
    // so a test importing the CLI would exercise the wrong claim; the scan
    // therefore covers `test` as well as `src`. `@panda/session` is barred for
    // the tier reason rather than the FR-29 one: two consumer packages that
    // import each other are one god package with two names.
    const files = [...sourceFiles, ...collectSourceFiles(join(packageDir, 'test'))]
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        expect(
          specifier.startsWith('@panda/cli') || specifier.startsWith('@panda/session'),
          `${file} imports '${specifier}'`,
        ).toBe(false)
      }
    }
  })

  it('keeps the diagnosis composed from init.ts, never from its own engine call', () => {
    // "Doctor is `project init` with application switched off, not a second
    // implementation" is the whole story, and it is worth nothing as a sentence.
    // `src/doctor.ts` may not reach the projection engine or the registry: its
    // only route to a projection is `runScope` in `src/init.ts`, the identical
    // call `initProject` makes. A second engine call here could classify drift
    // differently from the one that writes — and would differ exactly when a
    // user is trying to fix something.
    //
    // WHAT THIS DOES NOT COVER, said plainly rather than implied: it is a scan
    // of ONE file, not of a reachability set. A transitive scan cannot carry
    // the claim either, because `init.ts` legitimately calls the engine and
    // `doctor.ts` legitimately imports it. So the LOCAL import list is pinned
    // exactly instead: a new sibling module that reached the engine on doctor's
    // behalf has to be imported here, and adding it turns this red.
    const doctor = join(packageDir, 'src', 'doctor.ts')
    expect(sourceFiles).toContain(doctor)
    const specifiers = importsOf(readFileSync(doctor, 'utf8'))
    expect(specifiers.filter((specifier) => specifier.startsWith('.')).sort()).toEqual([
      './executors.ts',
      './init.ts',
      './init.ts',
    ])
    for (const specifier of specifiers) {
      expect(
        specifier === '@panda/projection' || specifier === '@panda/registry',
        `src/doctor.ts imports '${specifier}'`,
      ).toBe(false)
    }
  })

  it('exports exactly one entry point, so the surface stays the one the pins watch', () => {
    expect(Object.keys(packageJson['exports'] as Record<string, unknown>)).toEqual(['.'])
  })

  it('keeps the FR-29 consumer test importing NOTHING but this package', () => {
    // Without this the positive proof proves the wrong thing. A reviewer rewrote
    // `consumer.test.ts` to take `RegistryStore` from `@panda/registry` and
    // `createMemoryLogSink` from `@panda/kernel` directly: every clause passed,
    // lint and typecheck were clean, and the re-export closure — the only reason
    // the SDK promise holds for someone who installed just this package — was
    // undefended. So the import list itself is the assertion.
    const source = readFileSync(join(packageDir, 'test', 'consumer.test.ts'), 'utf8')
    // Node builtins and the test harness itself are not part of the surface a
    // consumer installs; every OTHER specifier is, and there may be exactly one.
    const surface = importsOf(source).filter(
      (specifier) => !specifier.startsWith('node:') && specifier !== 'vitest',
    )
    expect(surface).toEqual(['../src/index.ts'])
  })
})

/**
 * "Projection goes through the Story 2.8 engine and its ownership ledger, and
 * NOTHING ELSE writes to a vendor's file." That sentence is worth nothing as a
 * comment, so here is its mechanism: the only filesystem verbs this package may
 * import are the two it needs for its own state and for detection. A write verb
 * appearing in `src/` — `writeFile`, `rename`, `rm`, `appendFile`, a raw
 * `node:fs` handle — turns this red, whether or not the author remembered that
 * the ledger is the sole authority for what panda may modify.
 *
 * `access` and `constants` are the two `panda doctor` added, and both are pure
 * interrogation: `access(W_OK)` ASKS whether a write would be permitted, so a
 * diagnosis can stop promising a write panda could not perform without trying
 * one — which is the thing this command may not do.
 */
const PERMITTED_FS_IMPORTS = ['access', 'constants', 'mkdir', 'stat']

/**
 * Every spelling of the filesystem module, not just the prefixed one: a reviewer
 * evaded the first version of this clause with `import { writeFile } from
 * 'fs/promises'`, which carries no `node:` and passed green.
 */
const FS_SPECIFIER = String.raw`(?:node:)?fs(?:\/promises)?`

describe('@panda/environment writes no vendor file itself', () => {
  it('cannot reach the atomic writer that lands a vendor file', () => {
    // The other evasion a reviewer found: `import { atomicWriteText } from
    // '@panda/projection'` — a package this one already depends on, so no
    // dependency clause moved. The fix is upstream (that symbol is no longer
    // exported from the projection index, since nothing outside it needed one),
    // and this is the clause that notices if it comes back.
    for (const file of sourceFiles) {
      expect(readFileSync(file, 'utf8').includes('atomicWriteText'), file).toBe(false)
    }
  })

  it('imports only mkdir and stat from the filesystem, across the whole package source', () => {
    const imported = new Set<string>()
    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8')
      const named = [
        ...source.matchAll(
          new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]${FS_SPECIFIER}['"]`, 'g'),
        ),
      ]
      for (const match of named) {
        for (const name of match[1]!.split(',')) {
          const trimmed = name.trim()
          if (trimmed !== '') imported.add(trimmed)
        }
      }
      // Every OTHER way to reach the module is rejected rather than parsed: a
      // namespace import, a default import, `await import('node:fs')` and
      // `createRequire` all hand over every verb at once, and a clause that only
      // reads named-import lists would not see any of them. Counting mentions is
      // what makes that exhaustive instead of a list of the forms remembered.
      const mentions = [...source.matchAll(new RegExp(String.raw`['"]${FS_SPECIFIER}['"]`, 'g'))]
      expect(mentions.length, `${file} reaches the filesystem module outside a named import`).toBe(
        named.length,
      )
    }
    expect([...imported].sort()).toEqual(PERMITTED_FS_IMPORTS)
  })
})
