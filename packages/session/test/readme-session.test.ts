import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The root README teaches a host how to embed panda. Its claim is equivalence:
 *
 *   "a host composes the SAME session directly and brings its own executor"
 *
 * Driven, the block under that sentence did not compose the same session. With
 * `~/.panda/config.json` holding `{"executor":"codex"}`, written by
 * `panda swap executor codex`:
 *
 *     CLI  `panda run "..."`       -> executor: codex (selected by the 'global' layer)
 *     SDK  the README's own block  -> executor: claude-code (selected by 'defaults')
 *
 * A different vendor runs, and a different account is billed. The resolver is
 * not at fault — `resolveExecutor()` with zero options returns codex/global on
 * that same machine. The block simply never reads the user's documents, because
 * `runSession` reads no files by design (`run-session.ts:88-98`: "a session
 * primitive that read files under the running user's home would be unusable from
 * a host that already knows what it wants"). That design is right, and it is
 * gated by `executors.test.ts` 'reads no configuration of its own'. What was
 * wrong was a README telling a host the one-call shape is the same thing.
 *
 * WHY THIS CLAUSE IS A TEXT SCAN AND NOT AN EXECUTION. `packages/contracts`'s
 * README blocks ARE extracted and run by `consumer-install.proof.ts`, and that is
 * the better shape — but this block calls `runSession`, which spawns a real
 * vendor binary, and the proof runs offline against packed tarballs. So the
 * enforceable part is the one that actually broke: the block must hand the
 * session the documents, or it must stop claiming to be the same session.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..')

async function sdkBlock(): Promise<string> {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  const from = readme.indexOf('```ts')
  // THROWS rather than returning empty, the same reason `fencedBlock` in
  // `consumer-install.proof.ts` does: a clause that silently scans nothing is
  // the shape this repository has already been bitten by.
  if (from === -1) throw new Error('README.md carries no `ts` block for this clause to check')
  const to = readme.indexOf('```', from + 5)
  if (to === -1) throw new Error('the `ts` block in README.md is unterminated')
  return readme.slice(from + 5, to)
}

describe('the README block a host copies composes the session the CLI composes', () => {
  it('hands the session the user\'s own configuration documents', async () => {
    const block = await sdkBlock()
    // CONTROL: the extractor found the real block, not an empty string.
    expect(block, 'the extracted block is empty').toContain('runSession')
    expect(
      block,
      "the README says a host composes the SAME session; without the user's config layers it composes one that runs a different executor than `panda run` does, and bills a different account",
    ).toContain('configLayers')
    expect(block, 'the layers have to be read from somewhere').toContain('readExecutorConfigLayers')
  })

  it('CONTROL: the claim this clause defends is still the one the README makes', async () => {
    // If the README stops promising equivalence, this clause is defending a
    // sentence nobody wrote, and it should be re-decided rather than kept green.
    const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('composes the same session')
  })
})
