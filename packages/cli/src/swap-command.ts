import { homedir } from 'node:os'

import { setConfigValue } from '@panda/environment'
import { resolveExecutor } from '@panda/session'

// `panda swap <noun> <id>` — the verb that WRITES a selection.
//
// Everything panda selects has been readable and unwritable: `panda run --help`
// names the two documents the executor selection comes from and the product had
// no way to put a value in either. `swap` is the PRD's own word for changing an
// active thing (§6.1's CLI list, and FR-28's `panda swap method`), so this is a
// verb Story 5.4 extends with a second NOUN rather than a second verb.
//
// Thin, like every other binding here: the write is `@panda/environment`'s, the
// id check and the effective selection are `@panda/session`'s. This file parses
// argv, orders the two calls and prints. It decides nothing.

/** The nouns `swap` takes. Story 5.4 adds `method` here when panda can read one. */
export const SWAP_NOUNS = ['executor'] as const

export type SwapNoun = (typeof SWAP_NOUNS)[number]

/** The layer each scope's document composes into, for the override report below. */
const LAYER_FOR_SCOPE = { machine: 'global', project: 'project' } as const

export interface SwapCommandOptions {
  readonly homeDir?: string
  readonly cwd?: string
}

function describe(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' ? `${code}: ${message}` : message
}

/**
 * `panda swap executor <id>` and `panda project swap executor <id> [directory]`.
 *
 * The order is deliberate: VALIDATE, then write, then re-resolve. Validation
 * goes through `resolveExecutor`, so an unknown id gets the identical coded
 * refusal and identical id list that `panda run --executor` gives — one
 * vocabulary for one question, rather than a second list here that drifts.
 */
export async function runSwap(
  tokens: readonly string[],
  scope: 'machine' | 'project',
  err: (line: string) => void,
  usage: string,
  options: SwapCommandOptions = {},
): Promise<number> {
  const noun = tokens[0]
  if (noun === undefined || !(SWAP_NOUNS as readonly string[]).includes(noun)) {
    err(`panda swap needs one of: ${SWAP_NOUNS.join(', ')}`)
    err(usage)
    return 2
  }
  const requested = tokens[1]
  if (requested === undefined || requested.trim().length === 0) {
    err(`panda swap ${noun} needs the id to select`)
    err(usage)
    return 2
  }
  // The machine scope has no positional after the id; the project scope has
  // exactly one, its directory — the same shape every other `project` verb has.
  const extra = tokens.slice(2)
  if (extra.length > (scope === 'project' ? 1 : 0)) {
    err(usage)
    return 2
  }
  const id = requested.trim()
  // Defaulted HERE rather than left to each callee: `resolveExecutor` falls back
  // to `homedir()` on its own and `setConfigValue` does not, so leaving it
  // undefined would validate against one home directory and write into another.
  const homeDir = options.homeDir ?? homedir()
  // `process.cwd()` for the same reason `homeDir` is defaulted above, and it is
  // not hypothetical: `resolveExecutor` falls back to it and `setConfigValue`
  // refuses without one, so leaving it undefined made `panda project swap` exit
  // 2 for every real user while the suite — which always passes a `cwd` — stayed
  // green. Defaulted HERE so the validation and the write see one directory.
  const projectDir = (scope === 'project' ? extra[0] : undefined) ?? options.cwd ?? process.cwd()

  try {
    // Throws PANDA_EXECUTOR_NOT_FOUND naming every available id. Nothing is
    // written before this returns: an id panda has no adapter for must cost no
    // byte on disk, the same rule `runSession` applies before it makes a
    // workspace directory.
    await resolveExecutor({ executorId: id, homeDir, projectDir })
  } catch (error) {
    err(describe(error))
    return 2
  }

  let written
  try {
    written = await setConfigValue({
      scope,
      homeDir,
      projectDir,
      key: 'executor',
      value: id,
    })
  } catch (error) {
    err(describe(error))
    return 2
  }

  err(
    written.previous === id
      ? `already selected: '${id}' in '${written.filePath}'`
      : `selected: '${id}' in '${written.filePath}'${written.previous === undefined ? '' : ` (was '${written.previous}')`}`,
  )

  // THE HALF THAT IS NOT THE FILE WRITE. Writing the machine document while the
  // project one names something else changes nothing a run will do, and a
  // command that stopped at "selected" would be telling the user it had done
  // something it had not. So the effective selection is resolved again, with no
  // override, and reported whenever it is not what was just written.
  try {
    const effective = await resolveExecutor({ homeDir, projectDir })
    if (effective.executorId !== id || effective.layer !== LAYER_FOR_SCOPE[scope]) {
      err(
        `the effective selection is still '${effective.executorId}', decided by the '${effective.layer}' layer, which is narrower than the '${LAYER_FOR_SCOPE[scope]}' layer just written`,
      )
    }
  } catch (error) {
    // The write DID happen and is reported above. This is a second, separate
    // fact: panda can no longer say what a run would select, which is a problem
    // even though the requested change landed.
    err(`the selection was written, but panda could not resolve what a run would now use: ${describe(error)}`)
    return 2
  }
  return 0
}
