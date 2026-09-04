import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The `ExperimentalWarning` confinement, proven in a CHILD process, because the
 * warning is emitted once per process and this one has already loaded
 * `node:sqlite` through the sibling suites.
 *
 * Every assertion of an ABSENCE here carries a control in the same file: a child
 * that imports `node:sqlite` directly MEASURES whether this Node build warns at
 * all, and the confined case must still let an unrelated `ExperimentalWarning`
 * through. Without both, "stderr was clean" would be indistinguishable from
 * "the child printed nothing at all".
 *
 * The first control measures rather than demands, and that is not a softening:
 * `node:sqlite` warns on Node 24 and does NOT on Node 26.8.1, the exact pair CI
 * runs. A control that wrote one platform's behaviour down as a law went red on
 * the platform where the feature graduated, while the thing it was controlling
 * for stayed correct on both.
 */

const SQLITE_WARNING = 'SQLite is an experimental feature'
const CONTROL_WARNING = 'control warning must survive the confinement'
const loadSqliteUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'load-sqlite.ts')).href

interface Ran {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function runNode(source: string): Promise<Ran> {
  return new Promise((resolve) => {
    // `--conditions=panda-source` for the same reason `vitest.config.ts` sets it:
    // inside this repository `@panda/*` resolves to SOURCE, and the development
    // loop deliberately ships no build for the child to import.
    const child = spawn(process.execPath, ['--conditions=panda-source', '--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('node:sqlite is loaded lazily and its experimental warning never reaches panda output', () => {
  it('CONTROL: measures whether THIS Node build warns at all, because the confinement clause is only meaningful if it does', async () => {
    // The negative control, and it MEASURES the platform rather than demanding a
    // behaviour of it. `node:sqlite` prints `ExperimentalWarning` on Node 24 and
    // does NOT on Node 26.8.1 — measured on both, which is exactly the pair CI
    // runs — because the feature graduated between them.
    //
    // Asserting the warning unconditionally made this clause red on Node 26
    // while every other clause stayed green: a control that encodes one
    // platform's behaviour as a law fails on the platform that improved.
    //
    // The honest shape is to record what the platform does and say out loud when
    // there is nothing to confine, rather than skipping silently — a `skipIf`
    // nobody wrote down becomes a clause everyone believes still runs.
    const ran = await runNode("await import('node:sqlite'); console.log('CONTROL-LOADED')")
    expect(ran.code, ran.stderr).toBe(0)
    expect(ran.stdout, 'the control child must actually load node:sqlite, or it measures nothing').toContain(
      'CONTROL-LOADED',
    )
    const warns = ran.stderr.includes(SQLITE_WARNING)
    process.stdout.write(
      warns
        ? `[memory-sqlite] ${process.version} warns on a plain node:sqlite import, so the confinement clause is live
`
        : `[memory-sqlite] ${process.version} does NOT warn on a plain node:sqlite import (the feature graduated), so the confinement clause has nothing to confine and proves only that the loader adds no warning of its own
`,
    )
  })

  it('loads through loadSqlite() with the SQLite warning confined and an unrelated one intact', async () => {
    const ran = await runNode(
      [
        `const { loadSqlite } = await import(${JSON.stringify(loadSqliteUrl)})`,
        `const sqlite = await loadSqlite()`,
        `const database = new sqlite.DatabaseSync(':memory:')`,
        `database.exec('CREATE TABLE probe (value TEXT)')`,
        `database.close()`,
        `process.emitWarning(${JSON.stringify(CONTROL_WARNING)}, 'ExperimentalWarning')`,
        `console.log('CONFINED-LOADED')`,
      ].join('\n'),
    )
    expect(ran.code, ran.stderr).toBe(0)
    expect(ran.stdout, 'the confined child must actually open a database, or it proves nothing').toContain(
      'CONFINED-LOADED',
    )
    expect(ran.stderr).not.toContain(SQLITE_WARNING)
    // The patch is narrow: any OTHER warning still reaches the user. This is the
    // second control, and it is what separates confinement from a global mute.
    expect(ran.stderr).toContain(CONTROL_WARNING)
  })

  it('imports nothing until a consumer opens a store', async () => {
    // Importing the package must be silent AND must not have loaded node:sqlite.
    // `process.moduleLoadList` is Node's own record, so this is not an inference
    // from the absence of a warning.
    const indexUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'sqlite-memory-provider.ts')).href
    const ran = await runNode(
      [
        `await import(${JSON.stringify(indexUrl)})`,
        `console.log(process.moduleLoadList.some((entry) => entry.includes('sqlite')) ? 'SQLITE-LOADED' : 'SQLITE-NOT-LOADED')`,
      ].join('\n'),
    )
    expect(ran.code, ran.stderr).toBe(0)
    expect(ran.stdout).toContain('SQLITE-NOT-LOADED')
    expect(ran.stderr).not.toContain(SQLITE_WARNING)
  })
})
