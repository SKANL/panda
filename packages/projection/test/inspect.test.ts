import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProjectionLedgerRecord, ProjectionTarget, RegistryEntry } from '@skanl/panda-contracts'
import { ProjectionLedger } from '../src/ledger.ts'
import type { ProjectionLedgerScope } from '../src/ledger.ts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'
import { groupByKind, runProjection } from '../src/engine.ts'

// Inspection mode: the same merge, the same drift classification, the same
// ledger READ — and neither of the two writes a projection performs.
//
// Both skips are proven by a MECHANISM rather than by a claim. The vendor file
// is a byte hash of everything under the scope, taken before and after; the
// ledger is a subclass that counts `update` calls, because a ledger that was
// never written and a ledger that was written back with identical bytes are
// indistinguishable on disk and only one of them is this mode.
//
// What makes this red: delete `&& apply` from the write branch in `engine.ts`
// and the snapshot clause fails; delete `!apply ||` from the ledger branch and
// the call counter fails. Neither failure can be papered over by the other.

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'panda-projection-inspect-'))
  tempRoots.push(homeDir)
  return homeDir
}

const ENTRIES = [
  { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
] satisfies RegistryEntry[]

/** Every byte under `root`, keyed by relative path. Directories count too. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const bytes = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const key = relative(root, path).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        bytes.set(`${key}/`, '<directory>')
        await walk(path)
      } else if (entry.isFile()) {
        bytes.set(key, createHash('sha256').update(await readFile(path)).digest('hex'))
      } else {
        bytes.set(key, '<other>')
      }
    }
  }
  await walk(root)
  return bytes
}

/** Counts ledger writes; a write that lands identical bytes still counts. */
class CountingLedger extends ProjectionLedger {
  updates = 0
  override async update(scope: ProjectionLedgerScope, records: readonly ProjectionLedgerRecord[]): Promise<void> {
    this.updates += 1
    await super.update(scope, records)
  }
}

function claudeIn(homeDir: string): string {
  return join(homeDir, '.claude.json')
}

describe('runProjection under mode: inspect', () => {
  it('predicts the write, performs neither write, and applying lands exactly what it predicted', async () => {
    const homeDir = await makeHome()
    const filePath = claudeIn(homeDir)
    await writeFile(filePath, '{\n  "numStartups": 7\n}\n', 'utf8')
    const before = await snapshot(homeDir)

    const inspecting = new CountingLedger({ homeDir })
    const inspected = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: inspecting,
      mode: 'inspect',
    })

    // It computed a real outcome, not an empty one.
    expect(inspected.failures).toEqual([])
    expect(inspected.results[0]).toMatchObject({ targetId: 'claude-mcp', written: true })
    expect(inspected.results[0]!.byteDelta).toBeGreaterThan(0)
    // And landed nothing: no ledger write attempted, no byte moved anywhere.
    expect(inspecting.updates).toBe(0)
    expect(await snapshot(homeDir)).toEqual(before)

    const applying = new CountingLedger({ homeDir })
    const applied = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: applying,
      mode: 'apply',
    })

    // The two modes cannot disagree: same results, from the same computation.
    expect(applied.results).toEqual(inspected.results)
    expect(applied.warnings).toEqual(inspected.warnings)
    expect(applying.updates).toBe(1)
    // The baseline for the clauses above: this state really does write BOTH.
    const after = await snapshot(homeDir)
    expect(after.get('.claude.json')).not.toBe(before.get('.claude.json'))
    expect(after.has('.panda/projection-ledger.json')).toBe(true)
    expect(before.has('.panda/projection-ledger.json')).toBe(false)
  })

  it('creates no file for a target whose native config does not exist yet', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, 'nested', '.claude.json')
    const before = await snapshot(homeDir)

    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: new ProjectionLedger({ homeDir }),
      mode: 'inspect',
    })

    expect(run.results[0]).toMatchObject({ written: true })
    // The tempting write: panda would have to build `nested/` to place the file.
    expect(await snapshot(homeDir)).toEqual(before)
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('classifies drift over an applied projection exactly as applying again would', async () => {
    const homeDir = await makeHome()
    const filePath = claudeIn(homeDir)
    await writeFile(filePath, '{}\n', 'utf8')
    const target = (): ReturnType<typeof createClaudeMcpTarget> => createClaudeMcpTarget({ filePath })
    await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [target()],
      ledger: new ProjectionLedger({ homeDir }),
      mode: 'apply',
    })

    // The user edits what panda wrote.
    await writeFile(filePath, (await readFile(filePath, 'utf8')).replace('"npx"', '"npx-edited"'), 'utf8')
    const before = await snapshot(homeDir)

    const inspecting = new CountingLedger({ homeDir })
    const inspected = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [target()],
      ledger: inspecting,
      mode: 'inspect',
    })

    expect(inspected.results[0]?.drift).toEqual([
      expect.objectContaining({ kind: 'edited', entryId: 'context7', location: 'mcpServers.context7' }),
    ])
    expect(inspecting.updates).toBe(0)
    expect(await snapshot(homeDir)).toEqual(before)

    const applied = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [target()],
      ledger: new ProjectionLedger({ homeDir }),
      mode: 'apply',
    })
    expect(applied.results).toEqual(inspected.results)
  })

  it('agrees with apply about a file that moved under the merge, instead of predicting a write apply refuses', async () => {
    // The read-write race check is a WRITE defence, but the PREDICTION is
    // doctor's whole artifact: a mode that skipped it would answer "this file
    // would be rewritten" for a target where applying returns no result row and
    // a failure. `~/.claude.json` is rewritten by Claude Code itself, so this is
    // the machine doctor gets run on.
    const homeDir = await makeHome()
    const filePath = claudeIn(homeDir)
    // A target whose merge has the side effect the vendor CLI has: the file on
    // disk changes between panda's read and panda's decision.
    const racing = (): ProjectionTarget => ({
      targetId: 'claude-mcp',
      filePath,
      async merge({ nativeText }) {
        await writeFile(filePath, '{ "numStartups": 8 }\n', 'utf8')
        return { text: `${nativeText}// panda\n`, drift: [], records: [], ownedSpans: [[0, 1]] }
      },
    })
    await writeFile(filePath, '{ "numStartups": 7 }\n', 'utf8')

    const inspected = await runProjection({
      entries: groupByKind([]),
      targets: [racing()],
      ledger: new ProjectionLedger({ homeDir }),
      mode: 'inspect',
    })
    await writeFile(filePath, '{ "numStartups": 7 }\n', 'utf8')
    const applied = await runProjection({
      entries: groupByKind([]),
      targets: [racing()],
      ledger: new ProjectionLedger({ homeDir }),
      mode: 'apply',
    })

    expect(inspected.results).toEqual([])
    expect(inspected.failures.map((failure) => failure.error.code)).toEqual(['PANDA_PROJECTION_TARGET_FAILED'])
    expect(applied.results).toEqual(inspected.results)
    expect(applied.failures.map((failure) => failure.error.code)).toEqual(
      inspected.failures.map((failure) => failure.error.code),
    )
  })

  it('rejects a mode it does not recognise instead of defaulting to writing', async () => {
    // Fail CLOSED. `mode !== 'inspect'` wrote for every one of these, and
    // `runProjection` is on the FR-29 surface, so an untyped consumer reaches
    // it. A no-op init is visible in its own output; a write into a user's
    // config on the say-so of a typo is not.
    const homeDir = await makeHome()
    const filePath = claudeIn(homeDir)
    await writeFile(filePath, '{}\n', 'utf8')
    const before = await snapshot(homeDir)

    for (const mode of ['Inspect', 'inspect ', 'dry-run', null, 0]) {
      const ledger = new CountingLedger({ homeDir })
      await expect(
        runProjection({
          entries: groupByKind(ENTRIES),
          targets: [createClaudeMcpTarget({ filePath })],
          ledger,
          mode: mode as never,
        }),
        String(mode),
      ).rejects.toMatchObject({ code: 'PANDA_PROJECTION_MODE_INVALID' })
      expect(ledger.updates, String(mode)).toBe(0)
    }
    expect(await snapshot(homeDir)).toEqual(before)

    // And the two it does recognise still work, so the guard is not a wall.
    expect(
      (
        await runProjection({
          entries: groupByKind(ENTRIES),
          targets: [createClaudeMcpTarget({ filePath })],
          ledger: new ProjectionLedger({ homeDir }),
          mode: 'inspect',
        })
      ).results[0],
    ).toMatchObject({ written: true })
  })

  it('surfaces an unreadable ledger without repairing, replacing or writing it', async () => {
    const homeDir = await makeHome()
    const filePath = claudeIn(homeDir)
    await writeFile(filePath, '{}\n', 'utf8')
    const ledger = new ProjectionLedger({ homeDir })
    // The state where writing is most tempting: panda cannot claim what it would
    // place, and an "obviously safe" reseed would orphan every claim it holds.
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(ledger.filePath, '{ broken', 'utf8')
    const before = await snapshot(homeDir)

    const inspecting = new CountingLedger({ homeDir })
    const run = await runProjection({
      entries: groupByKind(ENTRIES),
      targets: [createClaudeMcpTarget({ filePath })],
      ledger: inspecting,
      mode: 'inspect',
    })

    expect(run.warnings.map((warning) => warning.code)).toEqual(['PANDA_PROJECTION_LEDGER_UNAVAILABLE'])
    expect(inspecting.updates).toBe(0)
    expect(await snapshot(homeDir)).toEqual(before)
  })
})
