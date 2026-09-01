import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import { describe, expect, it } from 'vitest'
import { WRITABLE_CONFIG_KEYS, setConfigValue } from '../src/config-write.ts'

async function fixture(): Promise<{ homeDir: string; projectDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'panda-config-write-'))
  const homeDir = join(root, 'home')
  const projectDir = join(root, 'project')
  await mkdir(homeDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  return { homeDir, projectDir }
}

function configPath(root: string): string {
  return join(root, '.panda', 'config.json')
}

async function writeConfig(root: string, text: string): Promise<string> {
  const path = configPath(root)
  await mkdir(join(root, '.panda'), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

async function readConfig(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath(root), 'utf8')) as Record<string, unknown>
}

describe('M5.C row 1: a machine scope with no document at all', () => {
  it('creates the directory and the document, holding exactly the one key', async () => {
    const { homeDir } = await fixture()
    const result = await setConfigValue({ scope: 'machine', homeDir, key: 'executor', value: 'codex' })

    expect(result.created).toBe(true)
    expect(result.previous).toBeUndefined()
    expect(result.filePath).toBe(configPath(homeDir))
    expect(await readConfig(homeDir)).toEqual({ executor: 'codex' })
  })
})

describe('M5.C row 2: a document that holds other keys', () => {
  // THE SILENT ONE. A writer that serialises only the key it was handed deletes
  // `workspace.rootDir`, panda exits 0, and the next run silently uses a
  // different workspace root. Measured to coexist in one document: `panda run`
  // reads both from `~/.panda/config.json`.
  it('sets the one key and leaves every other key exactly as it was', async () => {
    const { homeDir } = await fixture()
    await writeConfig(
      homeDir,
      JSON.stringify({ executor: 'claude-code', workspace: { rootDir: '/somewhere/else' }, future: [1, 2] }),
    )

    const result = await setConfigValue({ scope: 'machine', homeDir, key: 'executor', value: 'codex' })

    expect(result.created).toBe(false)
    expect(result.previous).toBe('claude-code')
    expect(await readConfig(homeDir)).toEqual({
      executor: 'codex',
      workspace: { rootDir: '/somewhere/else' },
      future: [1, 2],
    })
  })
})

describe('M5.C row 3: the value is already the one asked for', () => {
  it('reports the previous value and leaves the document saying the same thing', async () => {
    const { homeDir } = await fixture()
    await writeConfig(homeDir, JSON.stringify({ executor: 'codex' }))

    const result = await setConfigValue({ scope: 'machine', homeDir, key: 'executor', value: 'codex' })

    expect(result.previous).toBe('codex')
    expect(result.created).toBe(false)
    expect(await readConfig(homeDir)).toEqual({ executor: 'codex' })
  })
})

describe('M5.C rows 7 and 8: a document panda cannot use is never replaced', () => {
  // THE SECOND SILENT ONE. Overwriting here destroys whatever the user had —
  // including a document that is merely mid-edit — and panda would exit 0.
  it('refuses a document that is not valid JSON, and leaves the bytes untouched', async () => {
    const { homeDir } = await fixture()
    const original = '{ "executor": "codex", oops'
    const path = await writeConfig(homeDir, original)

    await expect(
      setConfigValue({ scope: 'machine', homeDir, key: 'executor', value: 'claude-code' }),
    ).rejects.toMatchObject({ code: PANDA_ERROR_CODES.configurationUnusable })
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it.each([
    ['an array', '[1, 2, 3]'],
    ['a string', '"codex"'],
    ['null', 'null'],
  ])('refuses %s, because a document that is not an object is not a document', async (_label, text) => {
    const { homeDir } = await fixture()
    const path = await writeConfig(homeDir, text)

    await expect(
      setConfigValue({ scope: 'machine', homeDir, key: 'executor', value: 'codex' }),
    ).rejects.toBeInstanceOf(PandaError)
    expect(await readFile(path, 'utf8')).toBe(text)
  })
})

describe('M5.C rows 9 and 10: the document is a symlink into a dotfiles repo', () => {
  // THE THIRD SILENT ONE, and the reason `atomic-write.ts` is imported rather
  // than reimplemented: `executors.ts` documents that stow/chezmoi/dotbot
  // materialise this exact file as a link. A rename over it orphans the source,
  // every later edit in the dotfiles repo goes nowhere, and panda exits 0.
  it('follows the link and rewrites the real file, leaving the link a link', async () => {
    const { homeDir, projectDir } = await fixture()
    const real = join(projectDir, 'dotfiles-config.json')
    await writeFile(real, JSON.stringify({ executor: 'claude-code', keep: true }), 'utf8')
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await symlink(real, configPath(homeDir))

    await setConfigValue({ scope: 'machine', homeDir, key: 'executor', value: 'codex' })

    expect((await lstat(configPath(homeDir))).isSymbolicLink()).toBe(true)
    expect(await readlink(configPath(homeDir))).toBe(real)
    expect(JSON.parse(await readFile(real, 'utf8'))).toEqual({ executor: 'codex', keep: true })
  })

  it('refuses a dangling link instead of materialising a regular file over it', async () => {
    const { homeDir, projectDir } = await fixture()
    await mkdir(join(homeDir, '.panda'), { recursive: true })
    await symlink(join(projectDir, 'gone.json'), configPath(homeDir))

    await expect(
      setConfigValue({ scope: 'machine', homeDir, key: 'executor', value: 'codex' }),
    ).rejects.toBeInstanceOf(PandaError)
    expect((await lstat(configPath(homeDir))).isSymbolicLink()).toBe(true)
  })
})

describe('M5.C row 11: the document has a mode panda did not choose', () => {
  // 0o444 rather than 0o600 DELIBERATELY. Measured on this repository's Windows
  // host: `chmod(path, 0o600)` is a no-op there (the mode stays 0o666), so the
  // obvious version of this test asserts 0o666 === 0o666 and proves nothing on
  // half the machines that run it. 0o444 maps to the read-only attribute and
  // takes on both platforms, so the assertion is real everywhere.
  //
  // What this measured, and it was a real defect: on Windows `rename` over a
  // 0o444 target fails EPERM, and the failure escaped as a BARE Node errno —
  // no `PandaError`, no code, nothing a caller could classify (AD-7), while
  // `doctor` has reported this exact state as `not-writable` all along. Fixed
  // at the root in `@panda/projection`, not here: every projection target
  // writes through the same function, so patching only this caller would have
  // left a vendor config in the same state throwing an unclassifiable error.
  it('refuses coded rather than widening the mode to get the write through', async () => {
    const { homeDir } = await fixture()
    const path = await writeConfig(homeDir, JSON.stringify({ executor: 'claude-code' }))
    await chmod(path, 0o444)
    const before = (await stat(path)).mode & 0o777

    const attempt = setConfigValue({ scope: 'machine', homeDir, key: 'executor', value: 'codex' })
    let refused = false
    try {
      await attempt
    } catch (error) {
      refused = true
      expect(error).toBeInstanceOf(PandaError)
      // CONFIGURATION vocabulary, not projection's. Coding this inside
      // `atomicWriteText` was tried and reverted: every other caller of that
      // writer reaches it through the projection engine, which already codes a
      // raw failure, and `doctor` classifies from that code.
      expect((error as PandaError).code).toBe(PANDA_ERROR_CODES.configurationUnusable)
    }

    // POSIX may let the owner replace a 0o444 file, so both outcomes are legal
    // here — but neither may change the mode, and a refusal must be coded.
    expect((await stat(path)).mode & 0o777).toBe(before)
    if (!refused) expect(await readConfig(homeDir)).toEqual({ executor: 'codex' })
  })
})

describe('M5.C rows 13 and 14: the project scope', () => {
  it('writes the project document and leaves the machine one alone', async () => {
    const { homeDir, projectDir } = await fixture()
    await writeConfig(homeDir, JSON.stringify({ executor: 'claude-code' }))

    const result = await setConfigValue({ scope: 'project', homeDir, projectDir, key: 'executor', value: 'codex' })

    expect(result.filePath).toBe(configPath(projectDir))
    expect(await readConfig(projectDir)).toEqual({ executor: 'codex' })
    expect(await readConfig(homeDir)).toEqual({ executor: 'claude-code' })
  })
})

describe('M5.C: the key allowlist', () => {
  it('publishes the keys panda will persist', () => {
    expect([...WRITABLE_CONFIG_KEYS]).toEqual(['executor'])
  })

  it('refuses a key panda does not read, rather than writing one nothing will ever use', async () => {
    const { homeDir } = await fixture()

    await expect(
      // @ts-expect-error — the type is the guard for a TypeScript caller; this
      // asserts the runtime guard that a JavaScript one still meets.
      setConfigValue({ scope: 'machine', homeDir, key: 'colour', value: 'blue' }),
    ).rejects.toMatchObject({ code: PANDA_ERROR_CODES.configurationUnusable })
  })
})
