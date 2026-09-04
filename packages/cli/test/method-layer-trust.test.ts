import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExecutorAdapter } from '@panda/contracts'
import { runPanda } from '../src'
import type { RunCommandOptions } from '../src'

/**
 * THE ORDERING IS THE GUARANTEE, AND ONLY A DRIVEN RUN CAN PIN IT.
 *
 * `panda run` imported and EXECUTED a module named by the `.panda/config.json`
 * of the directory it was run in — clone a repository, run panda inside it, and
 * you have run its author's code. A module cannot be inspected without being
 * LOADED, so `validateMethodPlugin` refusing the manifest afterwards prevents
 * nothing: measured, the refusal fired AND the module's side effect existed.
 *
 * `assertMethodMayMount` is unit-tested beside `resolveMethod`, and those unit
 * tests DO NOT PIN THIS. Measured, not assumed: moving the guard to after
 * `resolveMethod` leaves all twelve of them green while the hostile module runs
 * again. A guard in the wrong place passes its own test and prevents nothing.
 *
 * So this file exists to assert a SIDE EFFECT that only the real ordering can
 * suppress — a file the imported module writes at its top level. The executor is
 * stubbed, so nothing here spawns a vendor; the import is the only thing under
 * test.
 */

function capture(): RunCommandOptions & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { stdout: (line) => out.push(line), stderr: (line) => err.push(line), out, err }
}

/** A stub, so the run reaches the method mount without touching a vendor. */
function stubAdapter(): ExecutorAdapter {
  return {
    id: 'stub',
    async run() {
      return { status: 'ok', output: { text: 'stubbed' }, data: {}, errors: [] }
    },
  } as unknown as ExecutorAdapter
}

/**
 * A "cloned repository": a project directory carrying its own panda config and
 * its own module. The module's ONLY top-level statement is a write, so the file
 * it creates is proof the import happened and nothing else could have made it.
 */
async function clonedProject(document: unknown): Promise<{ readonly dir: string; readonly marker: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'panda-cloned-project-'))
  const marker = join(dir, 'IMPORT-RAN.txt')
  await mkdir(join(dir, '.panda'), { recursive: true })
  await writeFile(
    join(dir, 'arrived.mjs'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'top-level code ran')\nexport default { id: 'arrived' }\n`,
    'utf8',
  )
  await writeFile(join(dir, '.panda', 'config.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  return { dir, marker }
}

describe('a method the project layer named is never imported', () => {
  it('refuses before the import, and the module does not run', async () => {
    const { dir, marker } = await clonedProject({ method: './arrived.mjs' })
    const io = capture()

    const code = await runPanda(['run', 'hi'], { ...io, cwd: dir, createAdapter: stubAdapter })

    // The assertion that matters is the SIDE EFFECT, not the exit code: a run
    // that refused after importing would exit 2 as well.
    expect(existsSync(marker), 'the project-named module was imported and its top-level code ran').toBe(false)
    expect(code).toBe(2)
    // Actionable, per panda's own principle — but see the note below for what
    // "actionable" turned out to require, and why the first version of these
    // assertions did not deliver it.
    const said = io.err.join('\n')
    expect(said).toContain('./arrived.mjs')
    expect(said).toContain('project')
    // THIS LINE USED TO READ `toContain('panda swap method')`, AND THAT IS THE
    // FINDING. Driven end to end, the command it demanded is a CLOSED LOOP: exit
    // 0, writes the machine document, changes nothing — layer precedence keeps
    // `project` deciding and this same guard fires again, byte-identically. The
    // user could run the recommended command forever, and their only real exit
    // was hand-editing the JSON that `config-write.ts` says the product exists
    // to stop asking for.
    //
    // A clause asserting a message CONTAINS a command pins that panda gives
    // ADVICE. Nothing here can pin that the advice WORKS. It now names the two
    // facts a user can act on: which file holds the key, and that a machine
    // selection must be ABSOLUTE.
    expect(said).toContain('.panda/config.json')
    expect(said).toContain('ABSOLUTE')
  })

  it('CONTROL: the same run with no method key reaches the executor', async () => {
    // Without this the clause above is satisfied by any run that fails early for
    // any reason — a broken fixture would look exactly like a working guard.
    const { dir, marker } = await clonedProject({})
    const io = capture()

    const code = await runPanda(['run', 'hi'], { ...io, cwd: dir, createAdapter: stubAdapter })

    expect(code).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })
})
