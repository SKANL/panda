import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// Atomic persistence for target files: temp file in the same directory, then
// rename over the target. Atomicity here means reader visibility (readers only
// ever observe a complete document) and crash-safe replacement — NOT
// durability: like the Registry store, there is a power-loss window after
// rename with no fsync; that deferral is tracked as deferred work.
//
// The previous file's permissions are copied onto the temp file before the
// rename so a projection never widens or narrows the target's mode.

async function priorMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function atomicWriteText(path: string, contents: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const mode = await priorMode(path)
  const tempPath = join(dir, `${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, contents, 'utf8')
    if (mode !== undefined) await chmod(tempPath, mode)
    await rename(tempPath, path)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}
