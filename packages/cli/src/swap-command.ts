import { homedir } from 'node:os'
import { resolve, sep as SEP } from 'node:path'

import { setConfigValue } from '@panda/environment'
import { resolveExecutor, resolveMethod } from '@panda/session'

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

/**
 * The nouns `swap` takes. Both are selections panda holds about ITSELF, which is
 * why they share a verb: neither is a registry entry, and neither reaches an
 * executor's own configuration.
 *
 * What differs is how an id is CHECKED. An executor id names one of a closed
 * catalogue, so the catalogue answers. A method is named by a module specifier
 * and there is no catalogue to answer with — panda has no installed-methods list
 * in v1 (PRD §6.2 places methodologies post-v1) — so the only honest check is to
 * LOAD it. That is why the branch below exists and why FR-28's "listing
 * available methods" is renegotiated in this story's spec rather than faked.
 */
export const SWAP_NOUNS = ['executor', 'method'] as const

export type SwapNoun = (typeof SWAP_NOUNS)[number]

/**
 * A predicate rather than a cast at the use site. `Array.includes` does not
 * narrow, and the difference matters here: the noun is handed straight to
 * `setConfigValue`, whose `key` is the published allowlist type. A cast would
 * let a third noun added to `SWAP_NOUNS` reach the writer without anybody adding
 * it to that allowlist too — which is the one thing the allowlist exists to stop.
 */
function isSwapNoun(value: string | undefined): value is SwapNoun {
  return value !== undefined && (SWAP_NOUNS as readonly string[]).includes(value)
}

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
 * `panda swap <noun> <id>`, machine scope, and its `project` twin.
 *
 * The order is deliberate: VALIDATE, then write, then re-resolve. Validation
 * goes through the same function the RUN path uses — `resolveExecutor` for an
 * executor, `resolveMethod` for a method — so a refusal here is byte-identical
 * to the one the user would have hit later, rather than a second opinion that
 * drifts from it.
 */
export async function runSwap(
  tokens: readonly string[],
  scope: 'machine' | 'project',
  err: (line: string) => void,
  usage: string,
  options: SwapCommandOptions = {},
): Promise<number> {
  const noun = tokens[0]
  if (!isSwapNoun(noun)) {
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

  // WHAT THIS VALIDATES MUST MEAN THE SAME THING WHERE IT IS STORED.
  //
  // `projectDir` above is cwd for the MACHINE scope too, so `swap method
  // ./mine.mjs` run from a project validated THAT project's file and then wrote
  // the raw './mine.mjs' into the HOME document — where `runSession` resolves it
  // against whatever directory the next run stands in. Driven, with a control: a
  // directory carrying only a `mine.mjs` and NO `.panda` config had that module's
  // top-level code RUN; the same directory with an empty HOME did not. A wildcard
  // over every repository on the machine.
  //
  // THE FIRST FIX HERE WAS A REFUSAL, AND A REFUSAL WAS THE WRONG SHAPE. It made
  // the run-time guard's own advice — "name the module by ABSOLUTE path in your
  // own machine document" — cost the user a path they had to spell themselves,
  // while panda was standing in the directory that resolves it. A refusal that
  // one line of resolution removes is a refusal that spares the implementer.
  //
  // So it is resolved HERE, where the user is standing and can be shown what was
  // kept, and the value validated below is the value that is stored. The RUN-TIME
  // guard stays: a relative specifier can still reach a machine document by hand
  // or from an older build, and there it names no file.
  const RELATIVE_PREFIXES = ['./', '../', '.' + SEP, '..' + SEP]
  const resolvedFrom =
    noun === 'method' && scope === 'machine' && RELATIVE_PREFIXES.some((prefix) => id.startsWith(prefix))
      ? id
      : undefined
  const selection = resolvedFrom === undefined ? id : resolve(projectDir, id)

  try {
    // Nothing is written before this returns, for either noun: a selection panda
    // cannot honour must cost no byte on disk, the same rule `runSession`
    // applies before it makes a workspace directory.
    if (noun === 'executor') {
      // Throws PANDA_EXECUTOR_NOT_FOUND naming every available id.
      await resolveExecutor({ executorId: selection, homeDir, projectDir })
    } else {
      // Loading IS the check. It also means `panda swap method` fails at the
      // moment the user can still fix it, rather than at the next `panda run`
      // when they have moved on — the same reason the executor id is resolved
      // here instead of trusted.
      await resolveMethod(selection, projectDir)
    }
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
      key: noun,
      value: selection,
    })
  } catch (error) {
    err(describe(error))
    return 2
  }

  // A METHOD IN THE PROJECT DOCUMENT IS A RECOMMENDATION, NOT A SELECTION, AND
  // THE VERB HAS TO SAY WHICH. `assertMethodMayMount` refuses the `project`
  // LAYER unconditionally — whatever the specifier, absolute or not — so every
  // `project swap method` wrote a value no run would ever honour while printing
  // `selected:`. Driven with a control: same project, key removed, the run
  // reaches the executor.
  //
  // The WRITE is not the defect and is not removed: row E4 of `spec-m25a…`
  // freezes it and M5.D row 6 designed it. Deleting a designed, frozen behaviour
  // to fix a printed word is the worse trade. The word is what changes.
  //
  // EXECUTOR IS DELIBERATELY UNCHANGED. Nothing refuses a project-layer
  // executor, so `selected:` is true there, and hedging both would trade one
  // false sentence for another.
  const where = `'${selection}' in '${written.filePath}'`
  if (noun === 'method' && scope === 'project') {
    err(
      `recommended: ${where} — a note for whoever clones this project, NOT a selection. panda refuses to mount a method a project names, so while this key is here \`panda run\` REFUSES in this project, even for a method you selected machine-wide. To use it yourself: delete the key and run \`panda swap method ${id}\` from here.`,
    )
  } else {
    const from = resolvedFrom === undefined ? '' : ` (resolved from '${resolvedFrom}' here)`
    err(
      written.previous === selection
        ? `already selected: ${where}${from}`
        : `selected: ${where}${from}${written.previous === undefined ? '' : ` (was '${written.previous}')`}`,
    )
  }

  // THE HALF THAT IS NOT THE FILE WRITE. Writing the machine document while the
  // project one names something else changes nothing a run will do, and a
  // command that stopped at "selected" would be telling the user it had done
  // something it had not. So the effective selection is resolved again, with no
  // override, and reported whenever it is not what was just written.
  // The effective-selection report is EXECUTOR-only, and that asymmetry is
  // deliberate rather than an omission: resolving the effective method would
  // mean importing and ACTIVATING it here, in a process whose whole job is to
  // write a string. A swap that ran a methodology's onActivate as a side effect
  // of being configured is a side effect nobody asked for.
  if (noun !== 'executor') return 0
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
