// A NUL byte in a source file makes git and grep treat it as BINARY: no diff,
// no blame, and a grep over it silently returns nothing instead of failing.
// That is how a defect hides. It has happened twice, both times from writing a
// field separator as a literal NUL instead of the `\u0000` escape — which
// produces the identical string at runtime and stays reviewable.
//
// ponytail: a byte scan, not a linter. ESLint has no rule for this, and a
// custom rule costs more than the whole check.

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', '.codegraph', '.gitnexus', 'graphify-out', '.scratch'])
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md|yaml|yml)$/

async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (SOURCE.test(entry.name)) yield path
  }
}

const offenders = []
for await (const path of sourceFiles(ROOT)) {
  const buffer = await readFile(path)
  const at = buffer.indexOf(0)
  if (at >= 0) {
    const line = buffer.subarray(0, at).toString('utf8').split('\n').length
    offenders.push(`${relative(ROOT, path)}:${line}`)
  }
}

if (offenders.length > 0) {
  console.error('NUL byte in source (write it as the \\u0000 escape instead):')
  for (const offender of offenders) console.error(`  ${offender}`)
  process.exit(1)
}
