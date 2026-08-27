import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectionLedger } from '../src/ledger.ts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { createCodexConfigTarget } from '../src/targets/codex-config.ts'
import { createOpenCodeConfigTarget } from '../src/targets/opencode-config.ts'

const packageDir = join(import.meta.dirname, '..')
const srcDir = join(packageDir, 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__scratch' || entry.name === 'node_modules') return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

const files = sourceFiles(srcDir)

/**
 * Source with comments removed.
 *
 * Both clauses below scan for a SYMBOL, and a symbol named in prose is not a
 * caller: the first version of the ledger pin fired on its own jsdoc, which is
 * the same false positive `packages/cli/test/run.test.ts` records having deleted
 * a whole clause for.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Named imports from `node:fs`/`fs`, with or without `/promises`. */
const FS_SPECIFIER = String.raw`(?:node:)?fs(?:\/promises)?`

function fsImportsOf(source: string): { named: string[]; mentions: number } {
  const matches = [
    ...source.matchAll(
      new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]${FS_SPECIFIER}['"]`, 'g'),
    ),
  ]
  return {
    named: matches
      .flatMap((match) => match[1]!.split(',').map((name) => name.trim()))
      .filter((name) => name !== ''),
    mentions: [...source.matchAll(new RegExp(String.raw`['"]${FS_SPECIFIER}['"]`, 'g'))].length,
  }
}

describe('the projection package guards its two irreversible surfaces', () => {
  it('has sources to scan', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  /**
   * `ProjectionLedger.rewriteAll` replaces the WHOLE ownership document without
   * merging, which is precisely the write `update` refuses to make when the
   * ledger is unreadable — and that refusal is the guarantee Story 2.8's review
   * declared terminal to lose ("under-claiming on READ is recoverable;
   * PERSISTING that under-claim is terminal").
   *
   * It exists for exactly one caller: the user-named `repair` remediation, which
   * is the only exit from a ledger panda carries and cannot read.
   *
   * THREE CLAUSES, because this one alone was mutable to green: a reviewer
   * reached the method as `ledger['rewrite' + 'All']([])` and the symbol scan saw
   * nothing. A static scan cannot read a name assembled at run time, so the two
   * clauses below stop trying — the write now requires a capability that can only
   * be obtained by importing it, and the runtime refuses without it.
   */
  it('lets nothing but the repair remediation rewrite the whole ownership ledger', () => {
    const callers = files.filter((file) => code(file).includes('rewriteAll'))
    expect(callers.map((file) => file.slice(srcDir.length + 1).replaceAll('\\', '/')).sort()).toEqual([
      'ledger.ts',
      'remediate.ts',
    ])
  })

  it('reserves the whole-document write behind a capability a computed name cannot forge', () => {
    // The static clause above is a SPELLING check and a reviewer walked past it
    // with `ledger['rewrite' + 'All']([])`. `LEDGER_REPAIR_AUTHORITY` closes that
    // family rather than that spelling: holding it requires an import, which both
    // this scan and the package's import graph see, and calling without it throws.
    const holders = files.filter((file) => code(file).includes('LEDGER_REPAIR_AUTHORITY'))
    expect(holders.map((file) => file.slice(srcDir.length + 1).replaceAll('\\', '/')).sort()).toEqual([
      'ledger.ts',
      'remediate.ts',
    ])
  })

  it('throws when the whole-document write is reached without that capability', async () => {
    // Under the OS temp directory, not the package: if this clause is ever
    // weakened the call SUCCEEDS, and a write that lands in the repository is
    // how test residue got committed twice before.
    const ledger = new ProjectionLedger({ filePath: join(tmpdir(), 'panda-never-written.json') })
    const reached = ledger as unknown as Record<string, (...args: unknown[]) => Promise<void>>
    await expect(reached['rewrite' + 'All']!(Symbol('forged'), () => [])).rejects.toMatchObject({
      code: 'PANDA_PROJECTION_LEDGER_UNAVAILABLE',
    })
  })

  /**
   * A remediation may not DELETE. `adopt` and `release` change what panda claims;
   * `repair` rewrites panda's own document; `discard` rewrites one vendor file
   * through the same atomic writer every other panda write uses. None of the four
   * removes a path, and a reviewer adding an `rm` here would be adding a delete
   * path with no ledger authority behind it — the exact thing M4.B's removal rule
   * exists to prevent, on the one command a user reaches for while something is
   * already wrong.
   *
   * The MENTION count is what makes this exhaustive rather than a list of the
   * import forms someone remembered: a namespace import, a default import,
   * `await import('node:fs')` and `createRequire` all hand over every verb at
   * once, and `import * as fsp` + `fsp.rm(...)` left the first version green.
   */
  it('gives the remediation engine no filesystem verb that can remove a path', () => {
    const source = code(join(srcDir, 'remediate.ts'))
    const { named, mentions } = fsImportsOf(source)
    expect(named.sort()).toEqual(['readFile', 'realpath', 'stat'])
    expect(mentions, 'remediate.ts reaches the filesystem module outside a named import').toBe(1)
  })
})

/**
 * `ProjectionConfigTarget.claim` is OPTIONAL, and a target without it is
 * refused rather than silently unadoptable — but the refusal only helps if
 * SHIPPED targets have one. Without this clause a fourth trait record compiles,
 * projects, passes every suite, and quietly has no `adopt` while `panda doctor`
 * goes on telling the user to run it.
 */
describe('every shipped config target can say what occupies its location', () => {
  it.each([
    ['claude-mcp', createClaudeMcpTarget({ filePath: '/unused' })],
    ['codex-config', createCodexConfigTarget({ filePath: '/unused' })],
    ['opencode-config', createOpenCodeConfigTarget({ filePath: '/unused' })],
  ])('%s implements claim()', (_id, target) => {
    expect(typeof target.claim).toBe('function')
    // And it answers, rather than throwing, on a document it cannot use.
    expect(target.claim?.({ nativeText: 'not a document', entryId: 'ctx' })?.location).toContain('ctx')
  })
})
