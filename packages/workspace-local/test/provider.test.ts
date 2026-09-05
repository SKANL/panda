import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES, PandaError } from '@skanl/panda-contracts'
import { LocalWorkspaceProvider } from '../src'

const rootDir = await mkdtemp(join(tmpdir(), 'panda-workspace-local-unit-'))
afterAll(() => rm(rootDir, { recursive: true, force: true }))

function makeProvider(overrides: Partial<{ rootDir: string }> = {}): LocalWorkspaceProvider {
  return new LocalWorkspaceProvider({ rootDir, ...overrides })
}

async function errorCodeOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt
  } catch (error) {
    expect(error).toBeInstanceOf(PandaError)
    return (error as PandaError).code
  }
  throw new Error('expected rejection but resolved')
}

function expectCodedThrow(attempt: () => unknown): string {
  try {
    attempt()
  } catch (error) {
    expect(error).toBeInstanceOf(PandaError)
    return (error as PandaError).code
  }
  throw new Error('expected throw but returned')
}

describe('LocalWorkspaceProvider', () => {
  it('creates a real directory exposing root path and read/write capabilities', async () => {
    const provider = makeProvider()
    const handle = await provider.create()
    const info = await stat(handle.rootPath)
    expect(info.isDirectory()).toBe(true)
    expect(handle.capabilities).toEqual(['read', 'write'])
  })

  it('issues each handle its own frozen capabilities copy', async () => {
    const provider = makeProvider()
    const first = await provider.create()
    const second = await provider.create()
    expect(first.capabilities).not.toBe(second.capabilities)
    expect(() => (first.capabilities as string[]).push('write')).toThrow(TypeError)
    expect(() => ((first as unknown as { rootPath: string }).rootPath = '/elsewhere')).toThrow(TypeError)
  })

  it('keeps state on disk across release and re-acquire', async () => {
    const provider = makeProvider()
    const handle = await provider.create()
    await writeFile(join(handle.rootPath, 'state.json'), '{"kept":true}', 'utf8')
    await provider.release(handle)

    const reacquired = await provider.acquire(handle.id)
    await expect(stat(join(reacquired.rootPath, 'state.json'))).resolves.toBeDefined()
  })

  it('treats handles as independent single-use leases', async () => {
    const provider = makeProvider()
    const created = await provider.create()
    const acquired = await provider.acquire(created.id)

    // Each of the two simultaneously-live handles releases exactly once.
    await expect(provider.release(created)).resolves.toBeUndefined()
    await expect(provider.release(acquired)).resolves.toBeUndefined()

    // Releasing the SAME handle twice is the only double-release rejection.
    await expect(errorCodeOf(provider.release(created))).resolves.toBe(
      PANDA_ERROR_CODES.contractWorkspaceDoubleRelease,
    )
    await expect(errorCodeOf(provider.release(acquired))).resolves.toBe(
      PANDA_ERROR_CODES.contractWorkspaceDoubleRelease,
    )
  })

  it('rejects unknown ids with the canonical code', async () => {
    await expect(errorCodeOf(makeProvider().acquire('no-such-workspace'))).resolves.toBe(
      PANDA_ERROR_CODES.contractWorkspaceUnknownId,
    )
  })

  it('rejects Windows reserved device names as workspace ids', async () => {
    const provider = makeProvider()
    for (const reserved of ['con', 'PRN', 'Aux', 'nul', 'com1', 'COM9', 'lpt4', 'LPT9']) {
      await expect(errorCodeOf(provider.acquire(reserved))).resolves.toBe(
        PANDA_ERROR_CODES.contractWorkspaceUnknownId,
      )
    }
  })

  it('classifies symlinks under rootDir as unknown instead of following them', async (ctx) => {
    const provider = makeProvider()
    const outsideDir = await mkdtemp(join(tmpdir(), 'panda-outside-'))
    try {
      await writeFile(join(outsideDir, 'secret.txt'), 'outside', 'utf8')
      const linkPath = join(rootDir, 'linked-workspace')
      try {
        await symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        ctx.skip((error as Error).message)
      }
      await expect(errorCodeOf(provider.acquire('linked-workspace'))).resolves.toBe(
        PANDA_ERROR_CODES.contractWorkspaceUnknownId,
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('wraps filesystem failures during create into coded errors', async () => {
    // A file used as rootDir makes every mkdir beneath it fail.
    const blockerFile = join(rootDir, 'not-a-directory.txt')
    await writeFile(blockerFile, 'blocker', 'utf8')
    const provider = makeProvider({ rootDir: join(blockerFile, 'workspaces') })
    await expect(errorCodeOf(provider.create())).resolves.toBe(
      PANDA_ERROR_CODES.contractWorkspaceUnavailable,
    )
  })

  it('rejects an empty or non-string rootDir with the canonical code', () => {
    expect(expectCodedThrow(() => makeProvider({ rootDir: '' }))).toBe(
      PANDA_ERROR_CODES.contractWorkspaceInvalidHandle,
    )
    expect(expectCodedThrow(() => new LocalWorkspaceProvider({ rootDir: undefined as unknown as string }))).toBe(
      PANDA_ERROR_CODES.contractWorkspaceInvalidHandle,
    )
  })

  it('stops serving after dispose but keeps workspace state; double dispose is a no-op', async () => {
    const provider = makeProvider()
    const handle = await provider.create()
    await writeFile(join(handle.rootPath, 'state.json'), '{"kept":true}', 'utf8')
    await provider.dispose()
    await provider.dispose()

    await expect(errorCodeOf(provider.create())).resolves.toBe(PANDA_ERROR_CODES.contractProviderDisposed)
    await expect(errorCodeOf(provider.acquire(handle.id))).resolves.toBe(
      PANDA_ERROR_CODES.contractProviderDisposed,
    )
    // Outstanding-handle release() after dispose is also coded, per the port contract.
    await expect(errorCodeOf(provider.release(handle))).resolves.toBe(
      PANDA_ERROR_CODES.contractProviderDisposed,
    )
    await expect(stat(join(handle.rootPath, 'state.json'))).resolves.toBeDefined()
  })
})

describe('workspace-local directory layout', () => {
  it('never lets acquire escape rootDir through traversal-shaped ids', async () => {
    await mkdir(join(rootDir, 'nested'), { recursive: true })
    await expect(errorCodeOf(makeProvider().acquire('../escape'))).resolves.toBe(
      PANDA_ERROR_CODES.contractWorkspaceUnknownId,
    )
  })
})
