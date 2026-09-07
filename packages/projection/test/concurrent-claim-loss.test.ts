import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RegistryEntry } from '@skanl/panda-contracts'
import { ProjectionLedger } from '../src/ledger.ts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { groupByKind, runProjection } from '../src/engine.ts'

// Two `panda init` runs over one home lose claims the second run never examined.
//
// MEASURED ON THE BINARY FIRST, not inferred: ten rounds of two concurrent
// `panda init` over one home lost 20 of 40 codex-config claims, with 20 of 20
// processes exiting 0 and no stderr line naming foreign, skip, collision or
// ledger. The control — the same ten rounds, one process — lost 0 of 40.
//
// THE MECHANISM, captured rather than guessed. Process B reads the ledger before
// A persists, so B's snapshot holds none of A's claims. B then reads the vendor
// file, which by now DOES hold A's entries, and classifies them as foreign —
// correctly, because nothing in B's snapshot claims them. Being foreign, they
// are dropped from `projected.records` (`formats.ts:1336-1341`), and B ends the
// target with an empty set. `store.update(scope, [])` replaces the scope, and
// A's claims are gone. The entry is a foreign collision from then on, for good:
// panda wrote those bytes and no longer admits it.
//
// So the defect is not the lock and not the read. It is that the merge decision
// is made PER ENTRY while the ledger write is made PER SCOPE. B decides "not
// mine, leave the bytes alone" and then erases the claim anyway.
//
// WHY THE INTERLEAVING IS FORCED AND NOT WAGERED. `engine.test.ts:463` already
// runs two projections concurrently and asserts both claims survive; it passes,
// and it proves nothing here — its two runs take DIFFERENT scopes, and it bets
// on winning a race rather than forcing one. This repository has already paid
// for a wagered race test once (`remediate-race.test.ts` explains the bill). The
// wrapper below only decides WHEN A runs relative to B's read. Every read, every
// write, every merge and the whole ledger document are the real ones.

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'panda-concurrent-'))
  tempRoots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

const ENTRIES = [
  { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
] satisfies RegistryEntry[]

/**
 * The real ledger, with a one-shot hook fired AFTER its first read resolves.
 *
 * Not a production seam: `runProjection` already takes its store as a parameter,
 * so this injects nothing the published API does not already accept. It cannot
 * skip a guard, because it overrides no write path — the hook's only power is to
 * let the competing run finish inside a window that would otherwise be a
 * scheduling accident.
 */
class ReadHookedLedger extends ProjectionLedger {
  #hook: (() => Promise<void>) | undefined

  constructor(options: { homeDir: string }, hook: () => Promise<void>) {
    super(options)
    this.#hook = hook
  }

  override async read(): ReturnType<ProjectionLedger['read']> {
    const snapshot = await super.read()
    const hook = this.#hook
    this.#hook = undefined
    if (hook !== undefined) await hook()
    return snapshot
  }
}

describe('a projection run cannot drop a claim it never examined', () => {
  it('keeps the other run\'s claim when its own snapshot predates it', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    let hookFired = false

    // A runs to completion INSIDE B's window: after B has read the ledger and
    // before B decides anything.
    const runA = async (): Promise<void> => {
      hookFired = true
      const run = await runProjection({
        entries: groupByKind(ENTRIES),
        targets: [createClaudeMcpTarget({ filePath })],
        ledger: new ProjectionLedger({ homeDir }),
        mode: 'apply',
      })
      expect(run.failures, 'the competing run must succeed, or B is not racing anything').toEqual([])
    }

    const runB = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: new ReadHookedLedger({ homeDir }, runA),
      mode: 'apply',
    })

    // CONTROL: the window was actually entered. Without this the assertions
    // below are satisfied by a hook that never ran and a race that never happened.
    expect(hookFired, 'the interleaving hook never fired — this clause raced nothing').toBe(true)
    expect(runB.failures).toEqual([])

    // A wrote the bytes and B left them alone, which is correct: B had no claim
    // on them, and panda never adopts foreign bytes.
    const written = JSON.parse(await readFile(filePath, 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    expect(Object.keys(written.mcpServers ?? {})).toContain('context7')

    // THE DEFECT. B must not erase what it decided was not its own.
    const ledger = await new ProjectionLedger({ homeDir }).read()
    expect(ledger.state).toBe('readable')
    expect(
      ledger.records.map((record) => record.entryId),
      'panda wrote context7 into the vendor file and then stopped claiming it: the next run sees its own bytes as a foreign collision, permanently',
    ).toContain('context7')
  })
})
