import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLayeredConfig } from '@panda/kernel'
import { readExecutorConfigLayers, seedExecutorConfig } from '../src/executors.ts'

/**
 * M30.D — A PROJECT RECOMMENDS A METHOD; IT DOES NOT SELECT ONE.
 *
 * M25.A stopped `panda run` from importing a module a cloned repository named,
 * with a FATAL refusal on the deciding LAYER. Driven at `220f288`, that refusal
 * is wider than the threat: a project `method` key stops the run whatever else
 * is configured, INCLUDING a method the machine's owner selected for themselves.
 *
 *     project doc names a method, machine method set  ->  exit 2
 *     CONTROL: project doc removed, same machine one  ->  exit 0, runs
 *
 * So a cloned repository denies service to the machine's own configuration, and
 * the only exit was hand-editing JSON — the one answer `config-write.ts:10-12`
 * says the product exists to remove.
 *
 * THE FIX IS AT ADMISSION, NOT AT SELECTION, and that was a measurement rather
 * than a preference. The obvious shape — have `selectMethod` fall back by
 * reading `snapshot('global')` — was rejected because `snapshot()` has ZERO
 * production consumers outside the kernel's own definition, so it would have
 * made the method selection the product's only layer-by-layer reader. Dropping
 * the key before it becomes a layer costs no new resolution rule at all:
 * composition alone yields the next layer, and `selectMethod` is untouched.
 */

/** A project and a home, with whatever documents a row needs. */
async function documents(project: unknown, machine?: unknown): Promise<{ projectDir: string; homeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'panda-admission-'))
  const projectDir = join(root, 'project')
  const homeDir = join(root, 'home')
  for (const [dir, document] of [
    [projectDir, project],
    [homeDir, machine],
  ] as const) {
    await mkdir(join(dir, '.panda'), { recursive: true })
    if (document !== undefined) {
      await writeFile(join(dir, '.panda', 'config.json'), JSON.stringify(document), 'utf8')
    }
  }
  return { projectDir, homeDir }
}

/** Reads the real documents and composes them, exactly as `runSession` does. */
async function compose(project: unknown, machine?: unknown) {
  const { projectDir, homeDir } = await documents(project, machine)
  const layers = await readExecutorConfigLayers({ projectDir, homeDir })
  const config = createLayeredConfig()
  const declined = seedExecutorConfig(config, layers)
  return { config, declined, projectDir, homeDir }
}

/** Every composed leaf at `method`, which is at most one — see the gate below. */
function methodEntries(config: { dump(): readonly { path: readonly string[]; value: unknown; layer: string }[] }) {
  return config.dump().filter((entry) => entry.path.length === 1 && entry.path[0] === 'method')
}

describe('M30.D: a method a project names never becomes part of the project layer', () => {
  it('leaves the machine own selection deciding, instead of failing the run', async () => {
    const { config } = await compose({ method: './clone.mjs' }, { method: '/abs/mine.mjs' })

    // The assertion that matters is WHICH layer decides, not that nothing threw:
    // a composition that dropped BOTH keys would also not throw.
    expect(methodEntries(config)).toEqual([{ path: ['method'], value: '/abs/mine.mjs', layer: 'global' }])
  })

  it('names what it declined, and the file that recommended it', async () => {
    const { declined, projectDir } = await compose({ method: './clone.mjs' }, { method: '/abs/mine.mjs' })

    // AD-5 is "typed absence over silence", and this is the typed half. The
    // guard it replaces read AD-5 as a binary — "REFUSED rather than ignored" —
    // when its actual opposite of ignored is TYPED AND REPORTED, not FATAL.
    expect(declined).toEqual({
      key: 'method',
      specifier: './clone.mjs',
      filePath: join(projectDir, '.panda', 'config.json'),
      using: '/abs/mine.mjs',
    })
  })

  it('says so even when nothing else selects a method, because silence would be the other wrong answer', async () => {
    const { config, declined } = await compose({ method: './clone.mjs' })

    expect(methodEntries(config)).toEqual([])
    expect(declined?.using).toBeUndefined()
    expect(declined?.specifier).toBe('./clone.mjs')
  })

  it('D4: says NOTHING when the machine already selects the module the project recommends', async () => {
    // Advice that keeps nagging after it has been followed is the same defect
    // class as advice that does nothing, and this milestone has now found that
    // one twice. Following `panda swap method ./clone.mjs` from the project
    // stores the RESOLVED absolute path, so this comparison is what makes the
    // notice stop.
    const { projectDir, homeDir } = await documents({ method: './clone.mjs' })
    await writeFile(
      join(homeDir, '.panda', 'config.json'),
      JSON.stringify({ method: join(projectDir, 'clone.mjs') }),
      'utf8',
    )
    const layers = await readExecutorConfigLayers({ projectDir, homeDir })
    const config = createLayeredConfig()

    const declined = seedExecutorConfig(config, layers)

    expect(declined).toBeUndefined()
    // The DROP still happens; only the report is suppressed. Anything else would
    // make `dump()` disagree with what panda acted on.
    expect(methodEntries(config)).toEqual([
      { path: ['method'], value: join(projectDir, 'clone.mjs'), layer: 'global' },
    ])
  })

  it('CONTROL: a project document with no method key composes untouched', async () => {
    // Without this the clauses above are satisfied by a composition that drops
    // the project layer wholesale, which would remove the feature rather than
    // the danger.
    const { config, declined } = await compose({ executor: 'codex' }, { executor: 'claude-code' })

    expect(declined).toBeUndefined()
    expect(config.dump().find((entry) => entry.path[0] === 'executor')).toEqual({
      path: ['executor'],
      value: 'codex',
      layer: 'project',
    })
  })

  /**
   * THE GATE THE DESIGN NEEDS, AND IT IS NOT OPTIONAL.
   *
   * Dropping at admission is what keeps `dump()` honest: the composed document
   * says what panda ACTED ON. If a later simplification moves the drop into
   * `selectMethod`, `dump()` starts reporting `method` decided by `project` for a
   * value nothing will ever mount — and no other assertion in this repository
   * would notice, because a lying dump passes every assertion about the run.
   *
   * `dump()` has exactly three production consumers today (the three selections
   * in `executors.ts`, `methods.ts` and `workspaces.ts`) and no diagnostic reads
   * it — which is precisely why this has to be pinned rather than trusted to a
   * report that would have shown it.
   */
  it('NO composed entry ever reports `method` as decided by the project layer', async () => {
    for (const machine of [undefined, { method: '/abs/mine.mjs' }]) {
      const { config } = await compose({ method: './clone.mjs' }, machine)

      expect(config.dump().filter((entry) => entry.path[0] === 'method' && entry.layer === 'project')).toEqual([])
    }
  })
})
