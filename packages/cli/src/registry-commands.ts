import { homedir } from 'node:os'
import { REGISTRY_ENTRY_TYPES, deliveryFor, scopeDirectory, storeFor } from '@panda/environment'
import type { EntryDelivery, RegistryEntry, RegistryEntryType, RegistryScope } from '@panda/environment'

// `panda add` / `panda remove` / `panda list` — the surface Story 2.1 built a
// store for and never gave a verb, which is why two of `panda doctor`'s own
// exits used to say panda ships no command for removing an entry.
//
// WHAT THIS FILE IS ALLOWED TO DO is narrow, and the narrowness is the design:
// it shapes argv into an entry OBJECT and hands it to the store. It does not
// know which field suits which entry type, does not check an id, and does not
// look at `UNPROJECTABLE_ENTRY_IDS` — every one of those is
// `validateRegistryEntry` in `@panda/contracts`, and a second copy of any of
// them here would be a rule that drifts from the contract it paraphrases.
//
// The one argv fact it DOES own is the entry type, because a missing or
// misspelled type is a usage error about the command line rather than a verdict
// about an entry — and the list it checks against is `REGISTRY_ENTRY_TYPES`
// itself, so there is still no second table.
//
// SCOPE COMES FROM THE GRAMMAR, never from a flag. `panda <verb>` is the machine
// scope and `panda project <verb> [directory]` is a project's, exactly like
// `init`, `doctor` and `remediate`. There is deliberately no `--scope agent`:
// the agent scope is an in-memory Map that dies with the process, so a flag for
// it would accept the flag, exit 0 and persist nothing.

export type RegistryVerb = 'add' | 'remove' | 'list'

/** The verbs `run.ts` dispatches into this file, under both grammars. */
export const REGISTRY_VERBS: readonly RegistryVerb[] = ['add', 'remove', 'list']

export function isRegistryVerb(token: string | undefined): token is RegistryVerb {
  return (REGISTRY_VERBS as readonly string[]).includes(token as string)
}

export interface RegistryCommandContext {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** The synopsis printed after a usage error; `run.ts` owns the text. */
  readonly defaultUsage: string
  /** Defaults to the OS home directory, like every other command's. */
  readonly homeDir: string | undefined
  /** The project directory when no positional one is given. */
  readonly cwd: string | undefined
}

/**
 * The field flags, mapped ONE-TO-ONE onto the envelope field they carry.
 *
 * No entry type appears in this table and none may: the frozen Ask-First clause
 * of this story forbids the CLI holding a per-type table of which flag belongs
 * to which type, because that is a second copy of `REGISTRY_PATH_FIELDS`. A flag
 * that does not suit the type is rejected by the CONTRACT, one layer down.
 */
const FIELD_FLAGS: Readonly<Record<string, 'command' | 'entryPath'>> = {
  '--command': 'command',
  '--entry-path': 'entryPath',
}

/** Repeatable, and order-preserving: `args` is a command line, not a set. */
const ARG_FLAG = '--arg'

interface ParsedTokens {
  readonly positionals: readonly string[]
  readonly fields: Readonly<Partial<Pick<RegistryEntry, 'command' | 'entryPath' | 'args'>>>
}

/**
 * Argv for all three verbs: the field flags, and the positionals each verb then
 * reads for itself. Shared, so `remove` cannot drift into accepting an option
 * `add` rejects.
 */
function parseTokens(tokens: readonly string[]): ParsedTokens | { usageError: string } {
  const positionals: string[] = []
  const args: string[] = []
  let command: string | undefined
  let entryPath: string | undefined
  let terminated = false
  const assign = (field: 'command' | 'entryPath', value: string): void => {
    if (field === 'command') command = value
    else entryPath = value
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    // `--` ends the options, POSIX-style. Without it an id that begins with a
    // dash could be registered — `ingestProviders` accepts one, and nothing in
    // the envelope forbids it — and then never removed, because every spelling
    // of `panda remove mcp-server --fs` is a usage error. `panda doctor` points
    // straight at that command, so the entry had a dispatchable instruction that
    // could not be run for the entry it was about.
    if (!terminated && token === '--') {
      terminated = true
      continue
    }
    if (terminated) {
      positionals.push(token)
      continue
    }
    const named = Object.keys(FIELD_FLAGS).find((flag) => token === flag || token.startsWith(`${flag}=`))
    const flag = named ?? (token === ARG_FLAG || token.startsWith(`${ARG_FLAG}=`) ? ARG_FLAG : undefined)
    if (flag !== undefined) {
      // The SAME guard for both spellings: `--command=-x` reaching the entry
      // while `--command -x` is refused would be two answers to one question,
      // which is the shape `panda run --executor` was already fixed for.
      //
      // `--arg` is the ONE exception, and it is not a relaxation of the rule but
      // the rule applied to a different thing: an mcp-server's arguments are a
      // command line, where `-y` is an ordinary value — `npx -y @mcp/fs` is the
      // documented invocation of half the servers that exist. Refusing it would
      // make the flag unable to express the case it was added for. `--help` can
      // never be eaten by it, because help is answered before this parse runs.
      const inline = token.startsWith(`${flag}=`)
      const value = inline ? token.slice(flag.length + 1) : tokens[index + 1]
      if (value === undefined || value.length === 0 || (value.startsWith('-') && flag !== ARG_FLAG)) {
        return { usageError: `option '${flag}' requires a value` }
      }
      if (!inline) index += 1
      if (flag === ARG_FLAG) args.push(value)
      else assign(FIELD_FLAGS[flag]!, value)
      continue
    }
    if (token.startsWith('-')) return { usageError: `unrecognized option '${token}'` }
    positionals.push(token)
  }
  return {
    positionals,
    fields: {
      ...(command === undefined ? {} : { command }),
      ...(entryPath === undefined ? {} : { entryPath }),
      ...(args.length === 0 ? {} : { args }),
    },
  }
}

function knownTypes(): string {
  return REGISTRY_ENTRY_TYPES.join(', ')
}

/**
 * The entry type, as an argv question. A missing or misspelled type is a usage
 * error about the command line — the user has not named an entry yet — while
 * everything about the entry ITSELF is the contract's to answer.
 */
function readType(verb: RegistryVerb, token: string | undefined): RegistryEntryType | { usageError: string } {
  if (token === undefined) return { usageError: `panda ${verb} needs an entry type: ${knownTypes()}` }
  if (!(REGISTRY_ENTRY_TYPES as readonly string[]).includes(token)) {
    return { usageError: `unknown entry type '${token}'; panda has ${knownTypes()}` }
  }
  return token as RegistryEntryType
}

/** Panda's own two grammars, as the pair of facts every message below needs. */
interface Bound {
  readonly scope: 'machine' | 'project'
  readonly registryScope: Exclude<RegistryScope, 'agent'>
  /** The command that projects THIS scope — printed, so it must be dispatched. */
  readonly projectCommand: string
  readonly registryPath: string
  readonly homeDir: string
  readonly projectDir: string
  readonly store: ReturnType<typeof storeFor>
}

async function bind(
  scope: 'machine' | 'project',
  directory: string | undefined,
  context: RegistryCommandContext,
): Promise<Bound> {
  // The same trust boundary `panda init` applies, and for the same reason: these
  // paths decide where panda creates `.panda`, and `panda project add x y ~/typo`
  // must not build the missing tree. Panda BINDS a directory, never creates one.
  // `homedir()` here and in the capability are the same call: a second spelling
  // of "the home directory" is how `panda add` and `panda init` come to disagree
  // about which registry they are talking about.
  const home = await scopeDirectory('the home directory', context.homeDir ?? homedir())
  const root =
    scope === 'machine'
      ? home
      : await scopeDirectory('the project directory', directory ?? context.cwd ?? process.cwd())
  const store = storeFor(scope, home, root)
  const registryScope = scope === 'machine' ? 'global' : 'project'
  return {
    scope,
    registryScope,
    projectCommand: scope === 'machine' ? 'panda init' : 'panda project init',
    registryPath: store.storePath(registryScope),
    homeDir: home,
    projectDir: root,
    store,
  }
}

/** One entry as the line a human reads: its scope, its type and its id. */
function describeEntry(scope: RegistryScope, entry: RegistryEntry): string {
  const fields = [
    entry.command === undefined ? undefined : `command ${entry.command}`,
    entry.entryPath === undefined ? undefined : `entry-path ${entry.entryPath}`,
    entry.args === undefined ? undefined : `args ${entry.args.join(' ')}`,
  ].filter((part): part is string => part !== undefined)
  return `${scope} · ${entry.type} · ${entry.id}${fields.length === 0 ? '' : ` (${fields.join(' · ')})`}`
}

export async function runRegistryCommand(
  verb: RegistryVerb,
  tokens: readonly string[],
  scope: 'machine' | 'project',
  context: RegistryCommandContext,
): Promise<number> {
  const { out, err } = context
  const parsed = parseTokens(tokens)
  if ('usageError' in parsed) {
    err(parsed.usageError)
    err(context.defaultUsage)
    return 2
  }
  // `add` and `remove` name an entry, `list` names none; the project grammar
  // then takes one optional directory after that, exactly like `panda project
  // init [directory]` and `panda project remediate <verb> [directory]`.
  const named = verb === 'list' ? 0 : 2
  const maxPositionals = named + (scope === 'project' ? 1 : 0)
  if (parsed.positionals.length > maxPositionals) {
    err(`unexpected argument '${parsed.positionals[maxPositionals]}'`)
    err(context.defaultUsage)
    return 2
  }
  if (verb === 'list') {
    if (Object.keys(parsed.fields).length > 0) {
      err("'list' takes no field options; it shows every entry there is")
      err(context.defaultUsage)
      return 2
    }
    return await runList(parsed.positionals[0], scope, context)
  }
  const type = readType(verb, parsed.positionals[0])
  if (typeof type !== 'string') {
    err(type.usageError)
    err(context.defaultUsage)
    return 2
  }
  const id = parsed.positionals[1]
  if (id === undefined) {
    err(`panda ${verb} needs the id of the ${type} entry`)
    err(context.defaultUsage)
    return 2
  }
  if (verb === 'remove' && Object.keys(parsed.fields).length > 0) {
    err("'remove' takes no field options; an entry is removed by its type and id")
    err(context.defaultUsage)
    return 2
  }
  const bound = await bind(scope, parsed.positionals[2], context)
  try {
    return verb === 'add'
      ? await performAdd({ type, id, ...parsed.fields }, bound, out, err)
      : await performRemove(type, id, bound, out, err)
  } finally {
    await bound.store.dispose()
  }
}

/**
 * `add` REGISTERS and does not project — it reports the command that does.
 * Coupling the two would make registration fail for projection reasons, on a
 * machine where the failure has nothing to do with the entry just registered.
 *
 * The next step it reports is DERIVED, by `deliveryFor`, from the same planner
 * `panda init` runs. It used to be a sentence written here — "`panda project
 * init` puts it into every detected executor" — and for a project-scope skill
 * that sentence was false: nothing at that scope takes one, machine-scope
 * projection cannot see a project-scope entry, and the entry was inert forever
 * behind a command that exits 0. This binding therefore holds NO idea of which
 * entry type has a location at which scope; it prints what the planner found.
 */
async function performAdd(
  entry: RegistryEntry,
  bound: Bound,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  // Straight to the store: it validates through `validateRegistryEntry` and
  // throws a coded `PandaError` for a bad type, an empty id, an unprojectable id
  // and a field that does not belong on this type. Nothing is checked here first.
  await bound.store.register(entry, bound.registryScope)
  // AFTER the write, never before: the entry is registered either way, and a
  // planner that cannot answer must not be able to fail the registration.
  const delivery = await deliveryFor(entry, bound.scope, bound.homeDir, bound.projectDir)
  out(
    JSON.stringify(
      { scope: bound.registryScope, registryPath: bound.registryPath, entry, delivery },
      null,
      2,
    ),
  )
  err(`registered: ${describeEntry(bound.registryScope, entry)}`)
  err(`stored in '${bound.registryPath}'`)
  for (const line of deliveryLines(entry, delivery)) err(line)
  return 0
}

/**
 * The derived next step, as the lines a human reads. Every sentence here is a
 * rendering of {@link EntryDelivery} — which executors the planner found for
 * this entry at this scope, the targets' own refusals where it found none, and
 * the other scope when that one would take it.
 */
function deliveryLines(entry: RegistryEntry, delivery: EntryDelivery): string[] {
  const lines: string[] = []
  if (delivery.undetermined !== undefined) {
    // No claim about delivery is made, because none was established. The
    // grammar fact stays true and is all that is said.
    lines.push(`the entry is registered; panda could not work out what would take it (${delivery.undetermined})`)
    lines.push(`\`${delivery.command}\` is the command that projects this scope`)
    return lines
  }
  if (delivery.executorIds.length > 0) {
    lines.push(
      `nothing was projected: \`${delivery.command}\` puts it into ${delivery.executorIds.join(', ')}`,
    )
    return lines
  }
  // The headline says only what was OBSERVED — that no target took it. It used
  // to explain WHY ("no detected executor has a machine-scope location for a
  // skill entry"), which conflated "no target exists for this surface" with
  // "a target existed and refused THIS entry", and printed the first sentence
  // seconds after codex had used exactly such a location.
  lines.push(
    `NOTHING TAKES IT HERE: no detected executor would take this ${entry.type} entry at the ${delivery.scope} scope, so \`${delivery.command}\` would project it nowhere`,
  )
  for (const reason of delivery.reasons) lines.push(`  refused: ${reason}`)
  if (delivery.reasons.length === 0) {
    // Said rather than left blank: a target that skips an entry without a reason
    // has given panda nothing to pass on, and inventing one here is the failure
    // the headline above was just corrected for.
    lines.push(`  no target said why; \`panda doctor\` reports what each one would do`)
  }
  const elsewhere = delivery.elsewhere
  if (elsewhere === undefined) {
    lines.push(
      `no other scope takes it either; it stays in the registry, listed by \`panda list\`, and removable with \`panda remove\``,
    )
    return lines
  }
  // The scope that WOULD deliver it, named as the two commands that get there.
  lines.push(
    elsewhere.scope === 'machine'
      ? `the machine scope takes it (${elsewhere.executorIds.join(', ')}): register it with \`panda add\` and project it with \`${elsewhere.command}\``
      : `the project scope takes it (${elsewhere.executorIds.join(', ')}): register it with \`panda project add\` and project it with \`${elsewhere.command}\``,
  )
  return lines
}

/**
 * `remove` on an entry that is not there is TYPED ABSENCE (AD-5): it says so and
 * exits non-zero. A silent 0 would tell a script the entry is gone when the id
 * was simply misspelled, which is the same class of lie as an empty diagnosis.
 *
 * The existence check reads the ONE scope being written, never the merged view:
 * an entry shadowing from another scope would otherwise report a removal that
 * did not happen — and hide a stale entry in this scope forever.
 */
async function performRemove(
  type: RegistryEntryType,
  id: string,
  bound: Bound,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const present = await bound.store.get(type, id, bound.registryScope)
  if (present === undefined) {
    out(
      JSON.stringify(
        { scope: bound.registryScope, registryPath: bound.registryPath, removed: null, type, id },
        null,
        2,
      ),
    )
    err(
      `nothing was removed: no ${type} entry '${id}' is registered at the ${bound.registryScope} scope in '${bound.registryPath}'`,
    )
    return 1
  }
  await bound.store.remove(type, id, bound.registryScope)
  out(
    JSON.stringify(
      { scope: bound.registryScope, registryPath: bound.registryPath, removed: present },
      null,
      2,
    ),
  )
  err(`removed: ${describeEntry(bound.registryScope, present)}`)
  err(`stored in '${bound.registryPath}'`)
  // NOT "takes it out of every executor panda wrote it into" — that was false,
  // not merely vacuous: over a location the user has edited, `panda init`
  // answers "panda will not remove a tree it no longer recognises" and the
  // content stays. What is true is the rule panda actually applies.
  err(
    `nothing was projected: \`${bound.projectCommand}\` removes it from every location panda still owns, and reports the ones it no longer recognises rather than deleting them`,
  )
  return 0
}

/**
 * Every entry, WITH the scope it came from — which is why each scope is read on
 * its own rather than through the merged view every projection uses: the merge
 * keeps one row per `type:id`, so the scope that produced it is exactly the fact
 * it drops.
 *
 * An empty registry exits 0. An empty list is a result, not a failure; the
 * command did look, and it says what it found.
 */
async function runList(
  directory: string | undefined,
  scope: 'machine' | 'project',
  context: RegistryCommandContext,
): Promise<number> {
  const { out, err } = context
  const bound = await bind(scope, directory, context)
  try {
    // The machine grammar has one scope and can see no other; the project
    // grammar sees the project's entries over the machine's, in that order.
    const scopes: readonly Exclude<RegistryScope, 'agent'>[] =
      scope === 'machine' ? ['global'] : ['global', 'project']
    const rows: { scope: RegistryScope; entry: RegistryEntry }[] = []
    for (const registryScope of scopes) {
      for (const entry of await bound.store.list(registryScope)) rows.push({ scope: registryScope, entry })
    }
    out(
      JSON.stringify(
        {
          scope: bound.registryScope,
          registryPath: bound.registryPath,
          entries: rows.map((row) => ({ scope: row.scope, ...row.entry })),
        },
        null,
        2,
      ),
    )
    if (rows.length === 0) {
      err(`the registry is empty; \`panda add <type> <id>\` puts an entry in it`)
      return 0
    }
    for (const row of rows) err(describeEntry(row.scope, row.entry))
    return 0
  } finally {
    await bound.store.dispose()
  }
}
