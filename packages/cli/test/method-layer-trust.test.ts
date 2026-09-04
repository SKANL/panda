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
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'top-level code ran')\nexport default { id: 'arrived', version: '1.0.0', phases: [], artifacts: [], commands: [] }\n`,
    'utf8',
  )
  await writeFile(join(dir, '.panda', 'config.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  return { dir, marker }
}

/** A valid MethodPlugin whose top-level statement proves it was imported. */
function machineMethod(marker: string): string {
  return [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(marker)}, 'machine method ran')`,
    "export default { id: 'mine', version: '1.0.0', phases: [], artifacts: [], commands: [] }",
    '',
  ].join(String.fromCharCode(10))
}

describe('a method the project layer named is never imported', () => {
  it('refuses before the import, and the module does not run', async () => {
    const { dir, marker } = await clonedProject({ method: './arrived.mjs' })
    const io = capture()

    const homeDir = await mkdtemp(join(tmpdir(), 'panda-declining-home-'))
    const code = await runPanda(['run', 'hi'], { ...io, cwd: dir, homeDir, createAdapter: stubAdapter })

    // The assertion that matters is the SIDE EFFECT, not the exit code: a run
    // that refused after importing would exit 2 as well.
    expect(existsSync(marker), 'the project-named module was imported and its top-level code ran').toBe(false)
    // M30.D CHANGED THIS LINE FROM `toBe(2)`, AND THE CHANGE IS THE POINT.
    // M25.A froze `exit 2` here (row E1) and that refusal was wider than the
    // threat: driven, a project `method` key stopped the run whatever else was
    // configured, so a clone denied service to a method the MACHINE's owner had
    // selected, with hand-editing JSON as the only exit. The key is now declined
    // at admission and SAID out loud; what it must never do is decide the exit.
    expect(code).toBe(0)
    // Actionable, per panda's own principle — but see the note below for what
    // "actionable" turned out to require, and why the first version of these
    // assertions did not deliver it.
    const said = io.err.join('\n')
    expect(said).toContain('configuration ignored')
    expect(said).toContain('./arrived.mjs')
    expect(said).toContain('recommendation, not a selection')
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
    // The advice is ONE step now, because the project key no longer has to be
    // deleted first: it is declined at admission, so the machine document is
    // free to decide. The clause after next RUNS it and asserts the mount.
    expect(said).toContain('panda swap method ./arrived.mjs')
    expect(said).toContain(join('.panda', 'config.json'))
  })

  it('E2: the machine own method mounts, and the notice names what it declined', async () => {
    // THE DENIAL OF SERVICE THIS STORY EXISTS FOR. Before M30.D this run exited
    // 2 with the machine method configured and untouched: a cloned repository
    // could stop panda using a selection its owner had made for themselves.
    const { dir, marker } = await clonedProject({ method: './arrived.mjs' })
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-machine-home-'))
    const mine = join(homeDir, 'mine.mjs')
    const ran = join(homeDir, 'MINE-RAN.txt')
    await writeFile(mine, machineMethod(ran), 'utf8')
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(join(homeDir, '.panda', 'config.json'), JSON.stringify({ method: mine }), 'utf8')
    const io = capture()

    const code = await runPanda(['run', 'hi'], { ...io, cwd: dir, homeDir, createAdapter: stubAdapter })

    expect(code, io.err.join(' ')).toBe(0)
    // BOTH markers, because either one alone is satisfied by the wrong thing: a
    // run that mounted nothing leaves both unwritten, and a run that mounted the
    // project's leaves both written.
    expect(existsSync(ran), 'the machine own method did not mount').toBe(true)
    expect(existsSync(marker), 'the project-named module was imported').toBe(false)
    const said = io.err.join(' ')
    expect(said).toContain('configuration ignored')
    expect(said).toContain(mine)
  })

  it('and the command that refusal names ACTUALLY WORKS, which no toContain can say', async () => {
    // THE CLAUSE ABOVE USED TO END AT `toContain`, AND THAT WAS THE DEFECT.
    // A first version of this guard advised `panda swap method <spec>` and the
    // command was a CLOSED LOOP: exit 0, wrote the machine document, changed
    // nothing, because layer precedence kept `project` deciding and the same
    // refusal fired byte for byte. Every assertion about the message stayed
    // green the whole time. Asserting that panda gives ADVICE cannot assert
    // that the advice is a way out -- only running it can.
    const { dir, marker } = await clonedProject({ method: './arrived.mjs' })
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-adopting-home-'))
    const io = capture()

    // BOTH STEPS THE REFUSAL NAMES, IN ITS ORDER, AND THE FIRST ONE IS THE
    // FINDING. A draft of this clause ran only the swap, and it FAILED: the
    // project key still decides, so the machine document changed nothing and the
    // same refusal fired again. That draft is the closed loop reappearing in the
    // one place able to see it — which is the whole reason this clause runs the
    // advice instead of asserting the message contains it.
    await writeFile(join(dir, '.panda', 'config.json'), JSON.stringify({}), 'utf8')
    const adopted = await runPanda(['swap', 'method', './arrived.mjs'], { ...io, cwd: dir, homeDir })
    expect(adopted, io.err.join(' ')).toBe(0)

    const after = await runPanda(['run', 'hi'], { ...capture(), cwd: dir, homeDir, createAdapter: stubAdapter })

    // The module runs NOW, and that is the correct outcome rather than a
    // regression: the machine's owner typed the command, which is the consent a
    // file that arrived with a clone could never give.
    expect(existsSync(marker), 'the adopted method was still not mounted').toBe(true)
    expect(after).toBe(0)
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
