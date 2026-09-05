import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PandaError, PANDA_ERROR_CODES } from '@skanl/panda-contracts'
import { FilesystemMemoryProvider } from '../src/index.ts'

const temporaryRoot = await mkdtemp(join(tmpdir(), 'panda-memory-filesystem-unit-'))
afterAll(() => rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }))

let media = 0
function freshDir(label: string): string {
  media += 1
  return join(temporaryRoot, `${label}-${String(media)}`)
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

describe('FilesystemMemoryProvider, beyond the shared suite', () => {
  it('treats an ABSENT store as empty and an UNOPENABLE one as a coded failure (AD-5, E11)', async () => {
    // The two halves of AD-5 in one test, because the whole point is that they
    // are different: absence is a measurement, failure is not.
    const absent = join(freshDir('absent'), 'nested', 'deeper')
    const provider = await FilesystemMemoryProvider.open({ storeDir: absent })
    expect((await provider.describe()).entryCount).toBe(0)

    const occupied = freshDir('occupied')
    await writeFile(occupied, 'this path is a file, not a store directory', 'utf8')
    const error = await expectCode(
      FilesystemMemoryProvider.open({ storeDir: occupied }),
      PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
    )
    expect(error.message, 'a store failure that does not name the path is a dead end').toContain(occupied)

    await expectCode(
      FilesystemMemoryProvider.open({ storeDir: '' }),
      PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
    )
  })

  it('appends to the log and never rewrites what is already there (RD-1, at the medium)', async () => {
    // The class refuses destructive writes; this asserts the FILE agrees. A
    // provider that rewrote the log on every save would pass every in-process
    // clause and fail here.
    const storeDir = freshDir('append-only')
    const provider = await FilesystemMemoryProvider.open({ storeDir })
    const logPath = join(storeDir, 'entries.ndjson')

    const first = await provider.save({ payload: 'first', provenance: PROVENANCE })
    const afterFirst = await readFile(logPath, 'utf8')

    const second = await provider.save({ payload: 'second', provenance: PROVENANCE, supersedes: first.id })
    const afterSecond = await readFile(logPath, 'utf8')

    expect(afterSecond.startsWith(afterFirst), 'the second save rewrote bytes the first save had written').toBe(true)
    expect(afterSecond.trimEnd().split('\n')).toHaveLength(2)
    expect(second.sequence).toBe(first.sequence + 1)

    // And a refused overwrite writes nothing at all.
    await expectCode(provider.overwrite(first.id), PANDA_ERROR_CODES.contractMemoryOverwriteUnsupported)
    expect(await readFile(logPath, 'utf8')).toBe(afterSecond)
  })

  it('refuses a log line that is not a valid entry rather than serving half a store', async () => {
    const storeDir = freshDir('corrupt')
    const provider = await FilesystemMemoryProvider.open({ storeDir })
    await provider.save({ payload: 'good', provenance: PROVENANCE })
    const logPath = join(storeDir, 'entries.ndjson')
    await writeFile(logPath, `${await readFile(logPath, 'utf8')}{"id":"x"}\n`, 'utf8')

    const error = await expectCode(
      FilesystemMemoryProvider.open({ storeDir }),
      PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
    )
    expect(error.message).toContain('line 2')
  })

  it('refuses metadata that is present and unreadable, and stamps metadata that is absent', async () => {
    const stamped = freshDir('stamped')
    await FilesystemMemoryProvider.open({ storeDir: stamped })
    expect(JSON.parse(await readFile(join(stamped, 'meta.json'), 'utf8'))).toEqual({ formatVersion: 1 })

    const broken = freshDir('broken-meta')
    await FilesystemMemoryProvider.open({ storeDir: broken })
    await writeFile(join(broken, 'meta.json'), '{ not json', 'utf8')
    await expectCode(
      FilesystemMemoryProvider.open({ storeDir: broken }),
      PANDA_ERROR_CODES.contractMemoryStoreUnavailable,
    )
  })
})
