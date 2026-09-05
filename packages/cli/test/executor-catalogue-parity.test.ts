import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { EXECUTOR_PROFILES } from '@skanl/panda-environment'
// From `@skanl/panda-session`, not `@skanl/panda-adapter-cli` — the rule
// `executor-selection.test.ts` states: the CLI does not depend on the
// implementation packages, and the session re-exports the seam's vocabulary so a
// consumer that installed only it can name these. The runnable ids therefore
// arrive as `ExecutorSelection.available`, which is how the PRODUCT surfaces
// them, rather than as an internal constant read behind the product's back.
import { resolveExecutor } from '@skanl/panda-session'

// THE PARALLEL NAME LIST THIS PROJECT HAS ALREADY SHIPPED A DEFECT FROM.
//
// `packages/adapter-cli/src/catalogue.ts` records it in its own words: "Keyed
// from the traits, never from a list of string literals written beside them:
// Story 2.7a shipped an executor that was never once exercised because a
// parallel name list drifted from the thing it named."
// `packages/session/src/workspaces.ts` cites that lesson again when choosing the
// workspace catalogue's shape.
//
// `packages/environment/src/executors.ts` IS that parallel name list. It
// hand-writes `claude-code`, `codex` and `opencode` as string literals, in a
// different package from the traits, and drives DETECTION and PROJECTION while
// the catalogue drives RUNNING. Nothing derives one from the other, and
// `@skanl/panda-environment` structurally cannot ask: its `package.json` does not
// declare `@skanl/panda-adapter-cli` and its own `test/guard.test.ts` pins that
// dependency set by exact equality.
//
// WHY A GATE AND NOT A DOCTOR FINDING. Both lists are compiled in; a user cannot
// add an executor. The lists can only disagree because a panda author made them
// disagree, so a `panda doctor` finding here would report panda's own build
// defect to someone with no way to act on it — and spend one of `FINDING_EXITS`'
// remediations on a state that has no user-side exit. This fails in CI instead,
// before the disagreement can ship.
//
// ponytail: set equality over ids, not a derivation. Deriving the id from the
// trait record is the catalogue's own fix and is the better shape, but it would
// make `@skanl/panda-environment` import `@skanl/panda-adapter-cli` and force an edit to a
// guard test that pins its dependencies exactly. Upgrade path: if `environment`
// ever legitimately gains that dependency, replace this with the derivation and
// delete the gate.

const temporaryRoots: string[] = []
afterAll(async () => {
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * The ids panda can RUN, read the way the product reads them.
 *
 * Resolved against a throwaway HOME with no panda configuration in it, so the
 * answer is the shipped catalogue and not whatever this machine happens to have
 * selected. `available` is documented as "every id a selection may name".
 */
async function runnableIds(): Promise<readonly string[]> {
  const home = await mkdtemp(join(tmpdir(), 'panda-parity-'))
  temporaryRoots.push(home)
  const selection = await resolveExecutor({ homeDir: home, projectDir: home })
  return selection.available
}

/** The ids panda DETECTS and PROJECTS INTO. */
function projectedIds(): readonly string[] {
  return EXECUTOR_PROFILES.map((profile) => profile.executorId)
}

describe('the detection list and the adapter catalogue cannot drift', () => {
  it('declares the same executors in both directions', async () => {
    const projected = [...projectedIds()].sort()
    const runnable = [...(await runnableIds())].sort()

    // BOTH directions, because they are different defects and only one is loud.
    //
    // An id panda PROJECTS into but cannot RUN: `panda init` writes that
    // executor's config and `panda doctor` calls the environment clean, while
    // `panda run --executor <id>` fails `PANDA_EXECUTOR_NOT_FOUND` — doctor
    // certifying exactly what run refuses.
    //
    // An id panda can RUN but never PROJECTS into: the run succeeds and the
    // executor simply never receives a skill or an mcp-server panda holds. That
    // one is SILENT, which makes it the worse of the two.
    expect(
      projected.filter((id) => !runnable.includes(id)),
      'projected into but not runnable: `panda init` would configure an executor `panda run` cannot start',
    ).toEqual([])
    expect(
      runnable.filter((id) => !projected.includes(id)),
      'runnable but never projected into: `panda run` would start an executor that never receives what the registry holds',
    ).toEqual([])
    expect(runnable).toEqual(projected)
  })

  it('would not pass on a repository that ships no executors at all', async () => {
    // THE CONTROL for the clause above. Two empty sets are equal, so set
    // equality ALONE passes on a panda that ships nothing — which would make
    // that clause a decoration rather than a gate.
    const projected = projectedIds()
    const runnable = await runnableIds()
    expect(projected.length, 'no executor profiles ship at all').toBeGreaterThan(0)
    expect(runnable.length, 'no executor adapters ship at all').toBeGreaterThan(0)
  })

  it('would not hide a duplicated id behind the set comparison', async () => {
    // Two profiles claiming one id, or two adapters keyed the same, is a
    // different defect that a sorted-array comparison can smooth away entirely.
    const projected = projectedIds()
    const runnable = await runnableIds()
    expect(new Set(projected).size, `duplicate executor id among the profiles: ${projected.join(', ')}`).toBe(
      projected.length,
    )
    expect(new Set(runnable).size, `duplicate executor id in the catalogue: ${runnable.join(', ')}`).toBe(
      runnable.length,
    )
  })
})
