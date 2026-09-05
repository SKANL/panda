import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@skanl/panda-contracts'
import type { StaleLockBreak } from '@skanl/panda-lock'
import { ProjectionLedger, serialiseLedgerDocument } from '../src/ledger.ts'

// The ledger's OUTER boundary: `<ledger>.lock`, taken across the whole
// read-modify-write so a sibling PROCESS cannot read the document, be
// overtaken, and persist a set that never saw the other's claim.
//
// Both clauses FORCE their interleaving rather than betting on one. A lock is
// exactly the kind of thing where a test that waits and hopes passes when it
// should not: the contended clause writes the holder document itself, and the
// stale clause takes a pid from a child that has provably exited.

const rootDir = await mkdtemp(join(tmpdir(), 'panda-ledger-lock-'))
afterAll(() => rm(rootDir, { recursive: true, force: true }))

const SCOPE = { targetId: 'claude-mcp', filePath: join(rootDir, '.claude.json') }

function recordFor(entryId: string): {
  entryId: string
  targetId: string
  filePath: string
  nativeLocation: string
  contentHash: string
} {
  return {
    entryId,
    targetId: SCOPE.targetId,
    filePath: SCOPE.filePath,
    nativeLocation: `mcpServers.${entryId}`,
    contentHash: 'h'.repeat(64),
  }
}

/** A pid that is PROVABLY dead: the process has exited before we read it. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid!
}

async function homeWith(name: string, entryIds: readonly string[]): Promise<string> {
  const home = join(rootDir, name)
  await mkdir(join(home, '.panda'), { recursive: true })
  await writeFile(
    join(home, '.panda', 'projection-ledger.json'),
    serialiseLedgerDocument(entryIds.map(recordFor)),
    'utf8',
  )
  return home
}

const ledgerPath = (home: string): string => join(home, '.panda', 'projection-ledger.json')

describe('the ownership ledger is serialised across PROCESSES, not just within one', () => {
  it('refuses a write held by a live foreign holder, and leaves the document byte-identical', async () => {
    const home = await homeWith('contended', ['already-here'])
    const before = await readFile(ledgerPath(home), 'utf8')
    // FORCED: our own pid, alive by definition for the length of this clause,
    // written straight into the lockfile. No child to race, no window to miss.
    await writeFile(
      `${ledgerPath(home)}.lock`,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        token: 'a-holder-that-is-not-us',
      }),
      'utf8',
    )

    const ledger = new ProjectionLedger({ homeDir: home, lockTimeoutMs: 60 })
    try {
      await ledger.updateEntry(SCOPE, 'newcomer', recordFor('newcomer'))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PandaError)
      // Its OWN code. A caller told the LEDGER was unavailable goes looking at a
      // healthy document for a fault that is not there.
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.projectionLedgerContention)
      expect((error as PandaError).message).toContain(`${process.pid}@${hostname()}`)
    }

    // The loser writes NOTHING. Not a merge, not a truncation, not a temp file
    // left behind — the existing claim is exactly as it was.
    expect(await readFile(ledgerPath(home), 'utf8')).toBe(before)
    const read = await ledger.read()
    expect(read.state).toBe('readable')
    expect(read.records.map((record) => record.entryId)).toEqual(['already-here'])
  })

  it('breaks a lock stranded by a dead process, and REPORTS the break rather than doing it silently', async () => {
    const home = await homeWith('stranded', ['already-here'])
    const pid = await deadPid()
    await writeFile(
      `${ledgerPath(home)}.lock`,
      JSON.stringify({
        pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        token: 'left-behind-by-a-process-that-died',
      }),
      'utf8',
    )

    const breaks: StaleLockBreak[] = []
    const ledger = new ProjectionLedger({
      homeDir: home,
      lockTimeoutMs: 500,
      onStaleLockBreak: (broken) => breaks.push(broken),
    })
    await ledger.updateEntry(SCOPE, 'newcomer', recordFor('newcomer'))

    // Stepping aside from the outer boundary is the one moment worth saying out
    // loud, so the observer is asserted before the outcome is.
    expect(breaks).toHaveLength(1)
    expect(breaks[0]!.evidence).toContain(String(pid))
    expect(breaks[0]!.evidence).toContain('ESRCH')
    expect(breaks[0]!.holder?.token).toBe('left-behind-by-a-process-that-died')

    // And the write went through, merging rather than replacing.
    const read = await ledger.read()
    expect(read.records.map((record) => record.entryId).sort()).toEqual(['already-here', 'newcomer'])
  })

  it('writes into a home that does not exist yet, lockfile and all', async () => {
    // The lockfile is created in the same directory as the document, and on a
    // fresh machine nothing has made `~/.panda`. An exclusive create into a
    // missing directory is an ENOENT the lock would report as a broken medium,
    // so the directory is made before the lock is taken, not before the write.
    const home = join(rootDir, 'fresh-machine')
    const ledger = new ProjectionLedger({ homeDir: home })
    await ledger.updateEntry(SCOPE, 'first', recordFor('first'))
    const read = await ledger.read()
    expect(read.records.map((record) => record.entryId)).toEqual(['first'])
  })
})
