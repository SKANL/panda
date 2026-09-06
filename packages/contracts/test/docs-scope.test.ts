import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packagesDir = join(import.meta.dirname, '..', '..')
const repoRoot = join(packagesDir, '..')

/**
 * The npm SCOPE a reader is told to type must be the scope the manifests
 * publish under.
 *
 * WHY THIS EXISTS. `M37.D` moved every package from `@panda/*` to
 * `@skanl/panda-*` because the `@panda` scope belongs to someone else. The
 * manifests moved; one sentence in the root README did not, and it read
 * "Thirteen packages ship under the `@panda` scope" two lines below install
 * commands that already said `@skanl`. Nothing failed, because the claim lived
 * in prose — this repository's own defect class, in the one file a stranger
 * reads first.
 *
 * It is not a documentation nicety: npm ships `README.md` inside every tarball
 * regardless of `files` (verified: `tar -tzf` lists `package/README.md` for a
 * package whose `files` names only `dist`), so this prose IS the page
 * npmjs.com renders. A published wrong scope cannot be edited; it can only be
 * superseded by another release.
 *
 * DERIVED, never spelled. The expected scope comes from the manifests
 * themselves, so the day the scope moves again this gate follows it and every
 * document that lagged reddens by name. A gate holding its own copy of the
 * answer is one more place for the answer to be wrong — the same reason
 * `versions.test.ts` refuses a thirteenth file holding the version.
 */

/** Every directory under `packages/` that actually holds sources. */
function packagesWithSource(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'src')))
    .map((entry) => entry.name)
    .sort()
}

/**
 * The scope every package publishes under, read off the manifests.
 *
 * More than one is itself a failure: `pnpm publish -r` would claim two
 * namespaces, and no document could name "the" scope correctly.
 */
function declaredScopes(): readonly string[] {
  const scopes = packagesWithSource().map((dir) => {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'),
    ) as { readonly name?: unknown }
    const name = typeof manifest.name === 'string' ? manifest.name : ''
    return name.startsWith('@') ? name.slice(0, name.indexOf('/')) : ''
  })
  return [...new Set(scopes)].sort()
}

/**
 * `@`-tokens a shipped document may carry that are NOT a package scope, each
 * with the reason it is here. An allowlist rather than a cleverer pattern: the
 * two exceptions are known and named, and a third one arriving should be a
 * decision somebody takes, not a regex that quietly swallows it.
 */
const NON_SCOPE_TOKENS: ReadonlyMap<string, string> = new Map([
  ['@ts-expect-error', 'a TypeScript directive inside a fenced example, not an npm scope'],
  ['@modelcontextprotocol', "a third party's real npm scope, referenced as an example server"],
])

/** Every document that ships to a registry consumer. */
function shippedDocs(): readonly string[] {
  const docs = [join(repoRoot, 'README.md'), join(packagesDir, 'contracts', 'METHOD-PLUGIN.md')]
  for (const dir of packagesWithSource()) {
    const readme = join(packagesDir, dir, 'README.md')
    if (existsSync(readme)) docs.push(readme)
  }
  return docs
}

/**
 * The rule itself, over `[label, text]` pairs.
 *
 * Extracted so the clauses below can DRIVE it with known-bad input. A checker
 * only ever run against the real tree passes for a reason nobody has tested,
 * which is this repository's lesson about a measurement instrument needing its
 * own control.
 */
function foreignScopeUses(
  documents: readonly (readonly [string, string])[],
  scopes: readonly string[],
): string[] {
  const problems: string[] = []
  for (const [label, text] of documents) {
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(/@[A-Za-z0-9._-]+/g)) {
        const token = match[0]
        if (scopes.includes(token)) continue
        if (NON_SCOPE_TOKENS.has(token)) continue
        problems.push(
          `${label}:${String(index + 1)}: names '${token}', but the manifests publish under ${scopes.join(', ')}`,
        )
      }
    }
  }
  return problems
}

describe('the documentation names the scope the manifests publish under', () => {
  it('declares exactly one scope across every package', () => {
    // Two scopes is unfixable prose: no sentence could name "the" scope, and
    // `pnpm publish -r` would claim both namespaces in one irreversible step.
    expect(declaredScopes()).toHaveLength(1)
  })

  it('carries no foreign scope in any document that ships to a consumer', () => {
    const scopes = declaredScopes()
    const documents = shippedDocs().map(
      (path) => [path.slice(repoRoot.length + 1).replaceAll('\\', '/'), readFileSync(path, 'utf8')] as const,
    )
    const problems = foreignScopeUses(documents, scopes)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('REDDENS on the exact sentence M37.D left behind', () => {
    // The real historical defect, driven rather than described.
    const problems = foreignScopeUses(
      [['README.md', 'Thirteen packages ship under the `@panda` scope at one shared version.']],
      ['@skanl'],
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("names '@panda'")
  })

  it('CONTROL: says nothing about a document that only names the declared scope', () => {
    // Without this the clause above is satisfied by a checker that complains
    // about everything, which is the same green as one that checks nothing.
    expect(
      foreignScopeUses(
        [['README.md', 'Install `@skanl/panda-cli`, then `@skanl/panda-contracts` to implement a port.']],
        ['@skanl'],
      ),
    ).toEqual([])
  })

  it('CONTROL: the scan reaches the real documents', () => {
    // A zero from the clause above would otherwise be indistinguishable from a
    // glob that matched no files at all.
    const docs = shippedDocs()
    expect(docs.length).toBeGreaterThan(10)
    for (const path of docs) expect(existsSync(path)).toBe(true)
  })
})
