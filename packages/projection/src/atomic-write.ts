import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { PANDA_ERROR_CODES, PandaError } from '@skanl/panda-contracts'

// Atomic persistence for target files: temp file in the same directory, then
// rename over the target. Atomicity here means reader visibility (readers only
// ever observe a complete document) and crash-safe replacement — NOT
// durability: like the Registry store, there is a power-loss window after
// rename with no fsync; that deferral is tracked as deferred work.
//
// The previous file's permissions are copied onto the temp file before the
// rename so a projection never widens or narrows the target's mode.
//
// SYMLINKS ARE FOLLOWED, NEVER REPLACED. `~/.claude.json -> ~/dotfiles/claude.json`
// is the ordinary way people keep these files in a repo, and rename() over a
// symlink destroys the link and orphans the source: every later edit in the
// dotfiles repo goes nowhere, `git status` there shows nothing, and panda exits
// 0. So the link is resolved first and the rename lands on the real file. A link
// that cannot be resolved — dangling, a cycle — is a coded refusal, because the
// only alternative is to materialise a regular file where the user put a link.

async function priorMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * The real file the write must land on. Identity for a regular file or an
 * absent one; the link's destination for a symlink.
 */
async function writeTargetOf(path: string): Promise<string> {
  let link: boolean
  try {
    link = (await lstat(path)).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return path
    throw error
  }
  if (!link) return path
  try {
    return await realpath(path)
  } catch (error) {
    const detail = (error as NodeJS.ErrnoException)?.code ?? String(error)
    throw new PandaError(
      PANDA_ERROR_CODES.projectionNativeUnclaimable,
      `native config file '${path}' is a symlink panda cannot resolve (${detail}); refusing to replace the link with a regular file`,
      { cause: error },
    )
  }
}

async function atomicWrite(path: string, contents: string | Uint8Array): Promise<void> {
  const target = await writeTargetOf(path)
  const dir = dirname(target)
  await mkdir(dir, { recursive: true })
  const mode = await priorMode(target)
  const tempPath = join(dir, `${basename(target)}.${randomUUID()}.tmp`)
  try {
    // `utf8` applies to the string form alone; a Uint8Array is written verbatim,
    // which is what a materialised file needs — panda copies bytes it did not
    // author and must not re-encode them.
    await writeFile(tempPath, contents, typeof contents === 'string' ? 'utf8' : undefined)
    if (mode !== undefined) await chmod(tempPath, mode)
    await rename(tempPath, target)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    // Rethrown RAW, deliberately. `toTargetFailure` in `engine.ts` wraps a raw
    // error as `PANDA_PROJECTION_TARGET_FAILED` and passes a `PandaError`
    // through unchanged, so every projection caller already receives a coded
    // failure and `doctor` classifies this state from that code. Coding it here
    // was tried and reverted: it changed the code doctor sees, and the "bare
    // errno reaches a caller" defect it was meant to fix does not exist for any
    // caller that goes through the engine. A caller that does NOT — panda's own
    // config writer — codes it at its own boundary, where the right vocabulary
    // is a configuration one rather than a projection one.
    throw error
  }
}

export async function atomicWriteText(path: string, contents: string): Promise<void> {
  await atomicWrite(path, contents)
}

/** The same discipline for a file panda COPIES rather than renders. */
export async function atomicWriteBytes(path: string, contents: Uint8Array): Promise<void> {
  await atomicWrite(path, contents)
}
