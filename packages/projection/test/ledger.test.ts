import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError, PROJECTION_LEDGER_VERSION } from '@panda/contracts'
import type { ProjectionLedgerRecord, RegistryEntriesByKind } from '@panda/contracts'
import { runProjection } from '../src/engine.ts'
import { ProjectionLedger, hashOwnedText } from '../src/ledger.ts'
import { createClaudeMcpTarget } from '../src/targets/claude-mcp.ts'

const tempRoots: string[] = []
afterAll(() => Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true }))))

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'panda-ledger-'))
  tempRoots.push(homeDir)
  return homeDir
}

const ENTRIES: RegistryEntriesByKind = {
  skill: [],
  'mcp-server': [
    { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  ],
  profile: [],
}

function record(overrides: Partial<ProjectionLedgerRecord> = {}): ProjectionLedgerRecord {
  return {
    targetId: 'other-target',
    filePath: join('/elsewhere', 'config.json'),
    nativeLocation: 'mcpServers.context7',
    entryId: 'context7',
    contentHash: hashOwnedText('"context7": {}'),
    ...overrides,
  }
}

describe('the ownership ledger lives in panda’s own directory', () => {
  it('defaults beside the registry store, never inside a vendor file', async () => {
    const homeDir = await makeHome()
    expect(new ProjectionLedger({ homeDir }).filePath).toBe(
      join(homeDir, '.panda', 'projection-ledger.json'),
    )
  })

  it('persists a versioned document atomically and reads it back', async () => {
    const homeDir = await makeHome()
    const ledger = new ProjectionLedger({ homeDir })
    const claim = record()
    await ledger.update({ targetId: claim.targetId, filePath: claim.filePath }, [claim])

    expect(JSON.parse(await readFile(ledger.filePath, 'utf8'))).toEqual({
      version: PROJECTION_LEDGER_VERSION,
      records: [claim],
    })
    expect(await ledger.read()).toEqual({ state: 'readable', records: [claim], warnings: [] })
    expect(await readdir(join(homeDir, '.panda'))).toEqual(['projection-ledger.json'])
  })

  it('MERGES: an update replaces only its own scope', async () => {
    const homeDir = await makeHome()
    const ledger = new ProjectionLedger({ homeDir })
    const mine = record({ targetId: 'a', filePath: '/files/a.json', entryId: 'one' })
    const theirs = record({ targetId: 'b', filePath: '/files/b.json', entryId: 'two' })
    await ledger.update({ targetId: 'a', filePath: '/files/a.json' }, [mine])
    await ledger.update({ targetId: 'b', filePath: '/files/b.json' }, [theirs])

    // Replacing scope a must not touch scope b.
    const replaced = record({ targetId: 'a', filePath: '/files/a.json', entryId: 'three' })
    await ledger.update({ targetId: 'a', filePath: '/files/a.json' }, [replaced])

    const { records } = await ledger.read()
    expect(records.map((entry) => entry.entryId).sort()).toEqual(['three', 'two'])
  })

  it('serialises concurrent updates instead of losing one', async () => {
    const homeDir = await makeHome()
    const ledger = new ProjectionLedger({ homeDir })
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) =>
        ledger.update({ targetId: id, filePath: `/files/${id}.json` }, [
          record({ targetId: id, filePath: `/files/${id}.json`, entryId: id }),
        ]),
      ),
    )
    expect((await ledger.read()).records.map((entry) => entry.entryId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('writes a byte-identical document for the same records in any order', async () => {
    const homeDir = await makeHome()
    const ledger = new ProjectionLedger({ homeDir })
    const scope = { targetId: 'a', filePath: '/files/a.json' }
    const one = record({ ...scope, entryId: 'one' })
    const two = record({ ...scope, entryId: 'two' })

    await ledger.update(scope, [one, two])
    const first = await readFile(ledger.filePath, 'utf8')
    // Reversed order AND a duplicate: normalisation must absorb both.
    await ledger.update(scope, [two, one, two])
    expect(await readFile(ledger.filePath, 'utf8')).toBe(first)
  })
})

describe('a missing or unreadable ledger', () => {
  it('reads as absent on a fresh machine, with no warning', async () => {
    const homeDir = await makeHome()
    expect(await new ProjectionLedger({ homeDir }).read()).toEqual({
      state: 'absent',
      records: [],
      warnings: [],
    })
  })

  it.each([
    ['unparseable JSON', 'not json at all'],
    ['a foreign version', JSON.stringify({ version: 99, records: [] })],
    ['no records array', JSON.stringify({ version: PROJECTION_LEDGER_VERSION })],
  ])('reads %s as UNREADABLE plus a typed warning', async (_label, contents) => {
    const homeDir = await makeHome()
    const ledger = new ProjectionLedger({ homeDir })
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(ledger.filePath, contents, 'utf8')

    const read = await ledger.read()
    expect(read.state).toBe('unreadable')
    expect(read.records).toEqual([])
    expect(read.warnings).toHaveLength(1)
    expect(read.warnings[0]!.code).toBe(PANDA_ERROR_CODES.projectionLedgerUnavailable)
    expect(read.warnings[0]!.detail).toContain('leaving the file untouched')
  })

  it('keeps the VALID records when only some are malformed', async () => {
    const homeDir = await makeHome()
    const ledger = new ProjectionLedger({ homeDir })
    const good = record()
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(
      ledger.filePath,
      JSON.stringify({ version: PROJECTION_LEDGER_VERSION, records: [good, {}, { entryId: '' }] }),
      'utf8',
    )

    const read = await ledger.read()
    expect(read.state).toBe('readable')
    expect(read.records).toEqual([good])
    expect(read.warnings[0]!.detail).toContain('2 malformed record(s)')
  })

  it('REFUSES to write over an unreadable ledger', async () => {
    const homeDir = await makeHome()
    const ledger = new ProjectionLedger({ homeDir })
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await writeFile(ledger.filePath, '{ torn', 'utf8')

    await expect(ledger.update({ targetId: 'a', filePath: '/a.json' }, [])).rejects.toBeInstanceOf(
      PandaError,
    )
    // The damaged bytes are still there to be recovered by hand.
    expect(await readFile(ledger.filePath, 'utf8')).toBe('{ torn')
  })

  it('does not ORPHAN every claim after a single transient read failure', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    const target = createClaudeMcpTarget({ filePath })
    const ledger = new ProjectionLedger({ homeDir })

    await runProjection({ entries: ENTRIES, targets: [target], ledger })
    const projected = await readFile(filePath, 'utf8')
    const claims = await readFile(ledger.filePath, 'utf8')
    await writeFile(ledger.filePath, '{ torn', 'utf8')

    const run = await runProjection({ entries: ENTRIES, targets: [target], ledger })

    expect(run.warnings[0]!.code).toBe(PANDA_ERROR_CODES.projectionLedgerUnavailable)
    expect(run.results[0]!.drift[0]).toMatchObject({ kind: 'foreign-collision', entryId: 'context7' })
    // The user's config is untouched AND the damaged ledger is left alone, so
    // repairing it restores every claim. Overwriting it would be terminal.
    expect(await readFile(filePath, 'utf8')).toBe(projected)
    expect(await readFile(ledger.filePath, 'utf8')).toBe('{ torn')

    await writeFile(ledger.filePath, claims, 'utf8')
    const recovered = await runProjection({ entries: ENTRIES, targets: [target], ledger })
    expect(recovered.results[0]).toMatchObject({ written: false, drift: [] })
  })
})

describe('the ledger records what panda wrote', () => {
  it('records target, resolved file, native location and a content hash', async () => {
    const homeDir = await makeHome()
    const filePath = join(homeDir, '.claude.json')
    const ledger = new ProjectionLedger({ homeDir })
    await runProjection({
      entries: ENTRIES,
      targets: [createClaudeMcpTarget({ filePath })],
      ledger,
    })

    const { records } = await ledger.read()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      targetId: 'claude-mcp',
      filePath,
      nativeLocation: 'mcpServers.context7',
      entryId: 'context7',
    })
    // That the hash tracks the entry's CONTENT — not its mere presence — is
    // what drift.test.ts proves by editing the file and getting 'edited'.
    expect(records[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('carries through records for files this run does not touch', async () => {
    const homeDir = await makeHome()
    const ledger = new ProjectionLedger({ homeDir })
    const foreign = record()
    await ledger.update({ targetId: foreign.targetId, filePath: foreign.filePath }, [foreign])

    await runProjection({
      entries: ENTRIES,
      targets: [createClaudeMcpTarget({ filePath: join(homeDir, 'other.json') })],
      ledger,
    })

    const { records } = await ledger.read()
    expect(records.some((candidate) => candidate.filePath === foreign.filePath)).toBe(true)
    expect(records.some((candidate) => candidate.filePath === join(homeDir, 'other.json'))).toBe(true)
  })

  it('claims one file once, however the caller spelled its path', async () => {
    const homeDir = await makeHome()
    const ledger = new ProjectionLedger({ homeDir })
    const filePath = join(homeDir, '.claude.json')

    await runProjection({
      entries: ENTRIES,
      targets: [createClaudeMcpTarget({ filePath })],
      ledger,
    })
    // The same file reached through a '.' segment: a second claim here would
    // orphan everything written under the other spelling.
    await runProjection({
      entries: ENTRIES,
      targets: [createClaudeMcpTarget({ filePath: join(homeDir, '.', '.claude.json') })],
      ledger,
    })

    expect((await ledger.read()).records).toHaveLength(1)
  })
})
