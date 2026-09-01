import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PANDA_ERROR_CODES, PandaError } from '@panda/contracts'
import { atomicWriteText } from './atomic-write.ts'

// The write half of panda's OWN configuration. `panda run --help` has always
// told the user where the executor selection comes from and never how a value
// gets there, because nothing in the product wrote one: `packages/session`
// reads these documents four times and writes them zero. The answer panda gave
// a user who wanted a different default was "edit this JSON", which is the one
// answer the product exists to remove.
//
// KEY-AGNOSTIC ON PURPOSE. This is "set one key in panda's own configuration
// document", not "set the executor". Story 5.4 persists a `method` selection
// into the same documents with the same layer semantics and the same symlink
// hazard, and a second writer is a second place to get the symlink rule wrong.

// `<homeDir>/.panda/config.json` is the `global` layer and
// `<projectDir>/.panda/config.json` is the `project` layer, resolved by
// `readExecutorConfigLayers` in `@panda/session`.
//
// ponytail: `.panda/config.json` is spelled here rather than imported from
// `@panda/session`, which spells it too and carries the same note. AD-2 forbids
// the edge, and it would exist only to share two string literals.
const PANDA_STATE_DIR = '.panda'
const CONFIG_FILE = 'config.json'

/**
 * The keys panda will persist — an ALLOWLIST, not a suggestion.
 *
 * Key-agnostic is not unconstrained. A key panda does not read is a value
 * written once and ignored forever, which is the same defect as a registry type
 * nothing projects: M4.E's rule, applied to configuration. Story 5.4 adds
 * `method` here in the change that teaches panda to read it, never before.
 */
export const WRITABLE_CONFIG_KEYS = ['executor'] as const

export type WritableConfigKey = (typeof WRITABLE_CONFIG_KEYS)[number]

export interface ConfigWriteOptions {
  /** `machine` writes the `global` layer's document; `project` writes the project's. */
  readonly scope: 'machine' | 'project'
  readonly homeDir: string
  /** Required for the project scope; ignored for the machine one. */
  readonly projectDir?: string
  readonly key: WritableConfigKey
  readonly value: string
}

export interface ConfigWriteResult {
  readonly filePath: string
  /** What the key said before, so a caller can tell a change from a no-op. */
  readonly previous: string | undefined
  /** True when the document did not exist and this call created it. */
  readonly created: boolean
}

function unusable(filePath: string, detail: string, cause?: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.configurationUnusable,
    `panda will not write '${filePath}' because ${detail}`,
    cause === undefined ? undefined : { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The document as it is on disk, or `undefined` when there is none.
 *
 * AD-5: absent and unusable are DIFFERENT answers and this is the only place
 * that can tell them apart. Absent means create; unusable means refuse, and
 * refuse without writing — the alternative is destroying a document panda could
 * not understand, including one a user is halfway through editing.
 */
async function readDocument(filePath: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code
    // ENOENT on a DANGLING symlink too — `readFile` follows links. That case is
    // not treated as absent here: `atomicWriteText` resolves the link itself and
    // refuses a dangling one coded, which is the answer that keeps panda from
    // materialising a regular file where the user put a link.
    if (code === 'ENOENT') return undefined
    throw unusable(filePath, `it could not be read (${code ?? 'unknown error'})`, error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw unusable(filePath, 'it is not valid JSON, and panda does not overwrite a document it cannot read', error)
  }
  if (!isRecord(parsed)) {
    throw unusable(filePath, 'it must hold a JSON object, and panda does not replace one that does not')
  }
  return parsed
}

/** `<root>/.panda/config.json` for the scope this call names. */
export function configPathFor(options: Pick<ConfigWriteOptions, 'scope' | 'homeDir' | 'projectDir'>): string {
  const root = options.scope === 'machine' ? options.homeDir : options.projectDir
  if (root === undefined || root.trim().length === 0) {
    throw new PandaError(
      PANDA_ERROR_CODES.environmentScopeUnavailable,
      "a 'project' scope needs the directory of the project whose configuration is being written",
    )
  }
  return join(root, PANDA_STATE_DIR, CONFIG_FILE)
}

/**
 * Sets ONE allowlisted key in panda's own configuration document.
 *
 * Every other key is carried through untouched: these documents hold the
 * workspace root beside the executor selection, and a writer that serialises
 * only what it was handed silently deletes the rest.
 *
 * The write goes through `@panda/projection`'s `atomicWriteText` rather than a
 * local temp-then-rename, because this exact file is the one dotfile managers
 * materialise as a symlink and it is the only writer in this repository that
 * resolves the link instead of replacing it. The cost is that a refusal arrives
 * as a `PANDA_PROJECTION_*` code out of a configuration verb; that is recorded
 * in `deferred-work.md` and it is cheaper than a second copy of the symlink rule.
 */
export async function setConfigValue(options: ConfigWriteOptions): Promise<ConfigWriteResult> {
  const { key, value } = options
  if (!(WRITABLE_CONFIG_KEYS as readonly string[]).includes(key)) {
    // The list is built BEFORE the message rather than interpolated into it: the
    // printed-command scanner reads backtick strings out of shipped source, and
    // a nested template literal reached it as raw `${...}` source text.
    const known = WRITABLE_CONFIG_KEYS.map((writable) => `'${writable}'`).join(', ')
    throw new PandaError(
      PANDA_ERROR_CODES.configurationUnusable,
      `panda does not persist a '${key}' setting; it writes ${known}`,
    )
  }
  const filePath = configPathFor(options)
  const existing = await readDocument(filePath)
  const previous = existing?.[key]

  try {
    await atomicWriteText(filePath, `${JSON.stringify({ ...existing, [key]: value }, undefined, 2)}\n`)
  } catch (error) {
    // Coded HERE rather than inside `atomicWriteText` (AD-7). Every OTHER caller
    // of that writer goes through the projection engine, whose `toTargetFailure`
    // already wraps a raw error as `PANDA_PROJECTION_TARGET_FAILED` and which
    // `doctor` classifies from — coding it upstream was tried and it changed the
    // code doctor sees. This caller does not go through the engine, so it codes
    // its own failure, in configuration vocabulary rather than projection's.
    //
    // The commonest cause is a read-only document, and on Windows it is `rename`
    // that refuses (measured: a 0o444 target gives `EPERM: operation not
    // permitted, rename` while the temp write succeeds). The mode is NOT relaxed
    // to get the write through: a file the user made read-only was made
    // read-only on purpose.
    const detail = (error as NodeJS.ErrnoException | null | undefined)?.code
    // Worded to read after `unusable`'s own "panda will not write '<path>'
    // because" prefix, which is also why it does not start with the word panda:
    // a printed string that does is treated as a COMMAND by
    // `packages/cli/test/printed-commands.test.ts` and has to be declared prose.
    throw unusable(filePath, `it could not be replaced (${detail ?? String(error)}), so it is not writable`, error)
  }

  return {
    filePath,
    previous: typeof previous === 'string' ? previous : undefined,
    created: existing === undefined,
  }
}
