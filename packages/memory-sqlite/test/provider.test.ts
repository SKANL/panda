import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PandaError, PANDA_ERROR_CODES } from '@skanl/panda-contracts'
import { SqliteMemoryProvider } from '../src/index.ts'
// See the note in `contract.test.ts`: the raw connections this file needs come
// through the package's own confined loader so the suite prints no warning.
import { loadSqlite } from '../src/load-sqlite.ts'

const { DatabaseSync } = await loadSqlite()

const temporaryRoot = await mkdtemp(join(tmpdir(), 'panda-memory-sqlite-unit-'))
afterAll(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }))

let media = 0
function freshPath(label: string): string {
  media += 1
  return join(temporaryRoot, `${label}-${String(media)}.db`)
}

const PROVENANCE = {
  agentId: 'agent-unit',
  workspaceId: 'workspace-unit',
  recordedAt: new Date().toISOString(),
}

async function expectCode(attempt: Promise<unknown>, code: string): Promise<PandaError> {
  const error = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error, 'expected a rejection, got a resolved promise').toBeInstanceOf(PandaError)
  expect((error as PandaError).code).toBe(code)
  return error as PandaError
}

describe('SqliteMemoryProvider, beyond the shared suite', () => {
  it('treats an ABSENT database as empty and an UNOPENABLE one as a coded failure (AD-5, E11)', async () => {
    const absent = freshPath('absent')
    const provider = await SqliteMemoryProvider.open({ databasePath: absent })
    expect((await provider.describe()).entryCount).toBe(0)
    await provider.dispose()

    // A path under a directory that does not exist: SQLite cannot create it, and
    // the refusal has to name the path or nobody can act on it.
    const unopenable = join(temporaryRoot, 'no-such-directory', 'store.db')
    const error = await expectCode(
      SqliteMemoryProvider.open({ databasePath: unopenable }),
      PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
    )
    expect(error.message).toContain(unopenable)

    await expectCode(
      SqliteMemoryProvider.open({ databasePath: '' }),
      PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
    )
  })

  it('leaves the row it wrote untouched when a later entry supersedes it (RD-1, at the medium)', async () => {
    // Read back through a RAW connection, not through the provider: the claim is
    // about what is in the database, and a provider that hid an UPDATE behind its
    // own read path would pass every in-process clause.
    const databasePath = freshPath('append-only')
    const provider = await SqliteMemoryProvider.open({ databasePath })
    const first = await provider.save({ payload: 'first', provenance: PROVENANCE })
    await provider.save({ payload: 'second', provenance: PROVENANCE, supersedes: first.id })
    await expectCode(provider.overwrite(first.id), PANDA_ERROR_CODES.contractMemoryOverwriteUnsupported)
    await provider.dispose()

    const raw = new DatabaseSync(databasePath)
    try {
      expect(raw.prepare('SELECT COUNT(*) AS n FROM entries').get()?.['n']).toBe(2)
      expect(raw.prepare('SELECT payload, supersedes FROM entries WHERE id = ?').get(first.id)).toEqual({
        payload: 'first',
        supersedes: null,
      })
      expect(raw.prepare("SELECT COUNT(*) AS n FROM entries WHERE payload = 'replacement'").get()?.['n']).toBe(0)
      expect(raw.prepare('PRAGMA user_version').get()?.['user_version']).toBe(1)
    } finally {
      raw.close()
    }
  })

  it('refuses a database stamped with another format version and leaves no connection behind', async () => {
    const databasePath = freshPath('divergent')
    const seeded = new DatabaseSync(databasePath)
    seeded.exec('PRAGMA user_version = 99')
    seeded.close()

    const error = await expectCode(
      SqliteMemoryProvider.open({ databasePath }),
      PANDA_ERROR_CODES.contractMemoryStoreVersionMismatch,
    )
    expect(error.message).toContain('99')
    expect(error.message).toContain('1')
    // The refused open must not have created the table, or a "refusal" that
    // half-initialised the store would be the partial migration RD-1's
    // version-by-reject rule exists to avoid.
    const raw = new DatabaseSync(databasePath)
    try {
      expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'entries'").get()?.['n']).toBe(0)
    } finally {
      raw.close()
    }
  })

  it('does not destroy the store when a provider is disposed', async () => {
    const databasePath = freshPath('durable')
    const first = await SqliteMemoryProvider.open({ databasePath })
    const saved = await first.save({ payload: 'survives', provenance: PROVENANCE })
    await first.dispose()
    await first.dispose()

    const second = await SqliteMemoryProvider.open({ databasePath })
    expect((await second.timeline()).entries.map((entry) => entry.id)).toEqual([saved.id])
    await second.dispose()
  })
})
