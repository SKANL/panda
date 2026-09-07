import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * NFR-9's FIRST clause, gated by a proxy, because the number itself cannot be.
 *
 * `epics.md:59` states three budgets: "CLI cold start <= 300ms; projection of
 * 50-entry Registry <= 2s; adapter spawn overhead <= 150ms above raw CLI
 * startup". Only the THIRD has ever been enforced —
 * `packages/adapter-cli/test/overhead.test.ts`'s `OVERHEAD_BUDGET_MS`, which
 * measures adapter setup against a raw spawn and explicitly excludes process
 * start. It is a different axis, and the first clause had nothing at all.
 *
 * MEASURED, and the budget is missed. On the machine this was written on, the
 * PUBLISHED path (`dist/bin/panda.js --version`) runs ~1004 ms median over 31
 * interleaved rounds, best-ever 262 ms. The honest, machine-independent figure is
 * panda's delta above bare node — `node --version` is itself 204 ms p50 here —
 * and that delta alone is 196-479 ms across five batches. Panda's own cost
 * reaches or exceeds the whole 300 ms budget. An earlier note reporting 604-657
 * ms measured the DEVELOPMENT path, which is a different product.
 *
 * WHY THIS IS NOT A TIMING ASSERTION. That delta swung 2.4x across five batches
 * on one idle machine; an assertion at 300 ms would flake red about half the
 * time, and loosened past the flake it would stop asserting anything. A gate
 * that has to be tuned until it passes is a gate that checks nothing.
 *
 * WHAT IT ASSERTS INSTEAD, and why the proxy is honest: the cost is the GRAPH.
 * Profiled, the published path spends ~611 ms in module-resolution filesystem
 * probing and ~253 ms compiling `jsonc-parser` — the only third-party runtime
 * dependency in the tree — while executing `--version` itself takes 1.3 ms.
 * Measured against graph size directly: 16 modules load in 61 ms, 96 in 381 ms
 * (minimums). So the module count is not a stand-in chosen for convenience; it
 * is the thing that moves the number.
 *
 * This does NOT claim the budget is met. It claims the graph does not grow
 * silently, which is what nobody would have noticed otherwise — the number moved
 * once already and no run in the repository's life said so.
 */

const CLI_ENTRY = pathToFileURL(join(import.meta.dirname, '..', 'src', 'index.ts')).href
const CHILD = join(import.meta.dirname, 'module-graph.child.mjs')

/** Headroom over the measurement, not a target: 88 modules / 1.21 MB today. */
const MAX_MODULES = 95
const MAX_BYTES = 1_330_000

function graphOf(entry: string): { modules: number; bytes: number } {
  const stdout = execFileSync(process.execPath, ['--conditions=panda-source', CHILD, entry], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
  return JSON.parse(stdout) as { modules: number; bytes: number }
}

describe('what `panda --version` loads before it can answer (NFR-9)', () => {
  it('stays inside the module-graph budget', () => {
    const { modules, bytes } = graphOf(CLI_ENTRY)
    // CONTROL: the counter has to be counting. A child whose hook never fired
    // would report 0 and satisfy both ceilings perfectly.
    expect(modules, 'the loader hook counted nothing — this clause measured an empty graph').toBeGreaterThan(50)
    expect(
      modules,
      `the CLI now loads ${String(modules)} modules to answer --version. If that is deliberate, raise the ceiling in the same commit and say what was added.`,
    ).toBeLessThanOrEqual(MAX_MODULES)
    expect(
      bytes,
      `the CLI now reads ${String(bytes)} bytes of source to answer --version.`,
    ).toBeLessThanOrEqual(MAX_BYTES)
  })

  it('CONTROL: a leaf package loads a far smaller graph than the binding', () => {
    // Without this, the ceilings above are satisfied by a harness that reports
    // the same number whatever it is pointed at.
    const leaf = pathToFileURL(
      join(import.meta.dirname, '..', '..', 'contracts', 'src', 'validation.ts'),
    ).href
    expect(graphOf(leaf).modules).toBeLessThan(graphOf(CLI_ENTRY).modules / 2)
  })
})
