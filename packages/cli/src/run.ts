import {
  REGISTRY_ENTRY_TYPES,
  REMEDIATION_KINDS,
  REMOVABLE_ENTRY_TYPES,
  diagnose,
  hasProblem,
  initMachine,
  initProject,
  noExecutorsDetected,
  remediate,
  type Diagnosis,
  type DiagnosisFinding,
  type ExecutorDetection,
  type InitMachineOptions,
  type InitResult,
  type RemediationKind,
  type RemediationReport,
  type WorktreeLeftover,
} from '@panda/environment'
import {
  createLogSink,
  inspectWorktrees,
  readExecutorConfigLayers,
  readUsageReports,
  recordUsageObservation,
  removeWorktree,
  runSession,
  worktreeStateDir,
  type LogRecord,
  type SessionOptions,
  type UsageReport,
  type WorktreeInspection,
  type WorktreeOutcome,
} from '@panda/session'
import {
  isRegistryVerb,
  runExportCommand,
  runImportCommand,
  runIngestCommand,
  runRegistryCommand,
  type RegistryVerb,
} from './registry-commands.ts'
import { SWAP_NOUNS, runSwap } from './swap-command.ts'

// Exit codes (documented in the package README):
//   0 — run completed with an ok envelope / init completed with no failed target
//   1 — run returned a failed or cancelled envelope / a target failed to project
//   2 — usage error, invalid request, or environment failure (including
//       "no executor was detected", which is the environment lacking anything
//       for panda to configure)
//
// For `remove` the 1 is TYPED ABSENCE (AD-5): the entry named was not registered
// at that scope, so the command did nothing and says so. A silent 0 there would
// tell a script the entry is gone when the id was simply misspelled.
//
// For `doctor` the same three carry a narrower sentence: 0 is a clean
// environment, 1 is at least one finding that is a PROBLEM, 2 is doctor being
// unable to produce a diagnosis at all. A script branches on that, so "found
// problems" must never share an exit code with "could not run".

/**
 * The seams are PICKED from the capability packages rather than redeclared: this
 * package forwards them and owns none of them, so naming their types here would
 * be the first step back towards composing sessions in the CLI (see the
 * thin-binding pin in `test/run.test.ts`). What the CLI owns is where the output
 * goes.
 */
export interface RunCommandOptions
  extends Pick<SessionOptions, 'cwd' | 'adapterOptions' | 'createAdapter' | 'createProvider' | 'onInterrupt'>,
    Pick<InitMachineOptions, 'homeDir'> {
  readonly stdout?: (line: string) => void
  readonly stderr?: (line: string) => void
}

// The synopsis' type lists are DERIVED, never typed out. They were four literal
// `<tool|skill|mcp-server|profile>` spellings, and retiring `tool` left every one
// of them advertising a word the binary refuses — the exact CLI-side table M4.D
// forbade, hiding in help text. `panda remove` also takes a retired type, which
// is why its list is the removable vocabulary and `add`'s is the declared one.
const ADD_TYPES = `<${REGISTRY_ENTRY_TYPES.join('|')}>`
const REMOVE_TYPES = `<${REMOVABLE_ENTRY_TYPES.join('|')}>`

export const USAGE = [
  'usage: panda run [--executor <id>] [--trace] "<prompt>"',
  `       panda add ${ADD_TYPES} <id> [--command <c>] [--entry-path <p>] [--arg <a>]...`,
  `       panda project add ${ADD_TYPES} <id> [directory] [--command <c>] [--entry-path <p>] [--arg <a>]...`,
  `       panda remove ${REMOVE_TYPES} <id>`,
  `       panda project remove ${REMOVE_TYPES} <id> [directory]`,
  '       panda list',
  '       panda project list [directory]',
  '       panda export <path>',
  '       panda import <path>',
  '       panda ingest [--dry-run]',
  '       panda init',
  '       panda project init [directory]',
  '       panda doctor',
  '       panda project doctor [directory]',
  '       panda status',
  '       panda workspace remove [<id>]',
  '       panda remediate <adopt|release|repair|discard> [--executor <id>] [--entry <id>] [--apply]',
  '       panda project remediate <adopt|release|repair|discard> [directory] [--executor <id>] [--entry <id>] [--apply]',
  `       panda swap <${SWAP_NOUNS.join('|')}> <id>`,
  `       panda project swap <${SWAP_NOUNS.join('|')}> <id> [directory]`,
  '       panda --help',
  '',
  'run           Runs <prompt> through the selected executor inside a workspace under .panda/workspaces.',
  '  --executor <id>  Overrides the configured selection; --executor=<id> also works.',
  '                   Without it the selection comes from <project>/.panda/config.json, then',
  '                   ~/.panda/config.json, then the built-in default. The selection and the layer',
  '                   that decided it are reported on stderr.',
  '                   It overrides a configuration panda can READ; a document that exists and',
  '                   cannot be used still fails, because running a different agent than the one',
  '                   configured is the failure this selection exists to remove.',
  '  --trace          Writes the action waterfall to stderr as it happens: one line per',
  '                   intercepted action, with its cost when the pipeline estimated one.',
  '                   stdout stays the result envelope, so a piped run is unaffected.',
  'add           Puts ONE entry in the registry and projects nothing; it names the command that does.',
  '  --command <c>    The executable an mcp-server runs.',
  '  --entry-path <p> A skill entry file, or the directory holding one.',
  '  --arg <a>        One argument for an mcp-server, repeatable, order preserved.',
  '  --              Ends the options, so an id that begins with a dash can still be named.',
  '                   Which of these a type accepts is the registry contract\'s answer, not this',
  '                   binding\'s: a field that does not belong on the type is refused coded.',
  'remove        Takes ONE entry out of the registry by type and id. An entry that was not there',
  '              is said out loud and exits non-zero. It also takes a type panda has RETIRED, so an',
  '              entry written by an older build has an exit through the product rather than by hand.',
  'list          Every registered entry with its type, id and the scope it came from. An empty',
  '              registry is a result, not a failure, and exits 0.',
  'export        Writes the machine registry to <path> as a portable artifact, so an environment can',
  '              move to another device. Machine scope only: an agent entry dies with its process and',
  '              a project entry names a directory the destination does not have.',
  '              An entry carrying anything that looks like a credential is LEFT OUT rather than',
  '              redacted, and each one is named in the output with the field that stopped it, so what',
  '              did not travel is a task you can see instead of a gap you discover later.',
  'import        Installs a bundle from <path> into this machine and re-projects into every detected',
  '              executor, so a new device is set up by one command. An entry whose type and id are',
  '              already registered here is TAKEN OVER and said out loud; entries the bundle could not',
  '              carry are listed as work left for you. A bundle written by a newer panda is refused',
  '              by name, and nothing is written until the whole document has been read and checked.',
  'ingest        Puts the skills AND the MCP servers already on this machine into the registry, so it holds',
  '              something without one command per entry. It reads only the skills roots and the executor',
  '              configs panda has VERIFIED each executor reads, and never a skill or a server panda wrote',
  '              there itself: re-ingesting its own output would make the registry a copy of its own',
  '              projection. Purely ADDITIVE: an entry whose source is gone is left exactly where it is,',
  '              and nothing is ever removed. A directory that holds no skill, a server with no command to',
  '              run, and a name that cannot be a registry id are each named and skipped, never renamed.',
  '              A server carrying more than an mcp-server entry can hold is ingested for its command and',
  '              arguments, and the keys that stayed behind are named with the file they stayed in.',
  '  --dry-run   Report exactly what would be ingested and write nothing. Same call, same answer.',
  "init          Prepares this machine and projects the registry into every detected executor's own config.",
  'project init  Binds a project and projects into every detected executor that has a project-scope config.',
  'doctor        Reports what init would change and every problem panda can see. Writes nothing.',
  'project doctor  The same report for a project, matching what project init would do.',
  'status        Reports the usage each executor published the last time panda ran it: the windows',
  '              that executor NAMES, with its own utilisation and reset values, and the instant the',
  '              reading was taken. It invokes no executor and writes nothing — a report that spent',
  '              the quota it reports on would be unusable on the day you most need it, so the run',
  '              that already paid for the reading is the one that records it. An executor that',
  '              publishes no usage surface, and one panda has not run yet, each say so with their',
  '              own reason; neither is ever shown as a zero.',
  "swap          Writes the selection into panda's own config so later runs use it, and reports the",
  '              layer that actually decides. Writing the machine document while the project one',
  '              names something else changes nothing a run will do, and swap says so rather than',
  '              reporting a success it did not deliver. A selection panda cannot honour is refused',
  '              before a byte is written.',
  '  executor <id>  One of the adapter ids; the refusal lists the ids there are.',
  '  method <spec>  A MODULE SPECIFIER — a relative path or a package name — not an id into a store,',
  '                 because panda has no installed-methods list. It is LOADED and validated before',
  '                 it is written, so a broken one fails while you can still fix it. The next',
  '                 session mounts it; a method changed on disk takes effect on the next run, never',
  '                 inside a running one.',
  'workspace remove  Takes back a worktree panda made, in the project it is run in. With an <id>',
  '              it removes that one; with none it FINISHES the removals an interrupted run left',
  '              half-done and reports everything else it found, removing none of it.',
  '              It removes only what panda holds an ownership record for: a directory shaped',
  '              exactly like one of pandas own, with no record, is reported and never touched.',
  '              It refuses a tree with modified or untracked files in gits own words, and it',
  '              refuses a tree whose commit no ref contains -- git removes that one silently and',
  '              the work would be reachable from nothing. There is no override: a user who wants',
  '              to destroy unreachable work has git for that. A removed id is retired for good',
  '              and is never issued to another worktree.',
  'remediate     Leaves ONE state doctor reported, named by the user. Describes and writes nothing',
  '              unless --apply is given; nothing is ever remediated automatically or in bulk.',
  "  adopt    Panda claims what is at its own location, exactly as it is. No vendor byte is written;",
  '           `panda init` then converges it. The exit from a foreign collision and from an edit.',
  '  release  Panda stops claiming a location. The file is not read, not written, not looked at.',
  "  repair   Panda rewrites its OWN ownership ledger to hold exactly the records it can read.",
  "  discard  Panda removes its OWN prior output from a vendor file (correction-01 C6).",
  '  --executor <id> / --entry <id>  Narrow the finding; required whenever more than one matches.',
  '  --apply  Perform it. Without this the same call only describes what it would change.',
  '',
  'Exit codes: 0 ok · 1 failed/cancelled · 2 usage/environment error.',
  'For init, a target that failed to project exits 1; detecting no executor at all exits 2.',
  'For doctor, a finding that is a problem exits 1; a clean environment exits 0.',
  'For status, 0 whenever a report could be produced; 2 only when none could be.',
  'For workspace remove, a refusal or an id panda does not own exits 1; nothing to do exits 0.',
].join('\n')

/**
 * The synopsis block: every line up to the first blank one.
 *
 * Derived, not a line COUNT. It was `slice(0, 6)`, and adding two subcommands to
 * the synopsis silently truncated it for six pre-existing usage-error paths —
 * they stopped printing `panda --help` and advertised `panda remediate` without
 * `panda project remediate`. A count is a constant that has to be maintained in
 * a second place every time the block grows; the blank line maintains itself.
 */
const DEFAULT_USAGE = USAGE.split('\n').slice(0, USAGE.split('\n').indexOf('')).join('\n')

/**
 * Process-level signal wiring, which is why it lives in the binary's package and
 * not in the session: a library that registers SIGINT handlers takes them from
 * whatever host embedded it. The session takes the registration as a seam and
 * this is the CLI's answer to it.
 */
function defaultInterruptRegistration(handler: () => void): () => void {
  process.once('SIGINT', handler)
  process.once('SIGTERM', handler)
  return () => {
    process.off('SIGINT', handler)
    process.off('SIGTERM', handler)
  }
}

/**
 * The first option-looking token, recognized or not. Matching on a single `-`
 * rather than `--` is the point: `panda project init -f` used to fall through as
 * a POSITIONAL and create a directory literally named `-f`.
 */
function optionToken(tokens: readonly string[]): string | undefined {
  return tokens.find((token) => token.startsWith('-'))
}

function isHelp(token: string | undefined): boolean {
  return token === '--help' || token === '-h'
}

/** Index of the `--` option terminator, or the length when there is none. */
function terminatorAt(tokens: readonly string[]): number {
  const at = tokens.indexOf('--')
  return at === -1 ? tokens.length : at
}

export async function runPanda(argv: readonly string[], options: RunCommandOptions = {}): Promise<number> {
  const out = options.stdout ?? ((line: string) => console.log(line))
  const err = options.stderr ?? ((line: string) => console.error(line))

  if (argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE)
    return 0
  }
  if (isRegistryVerb(argv[0])) {
    return await runRegistry(argv[0], argv.slice(1), 'machine', out, err, options)
  }
  if (argv[0] === 'export') {
    if (isHelp(argv[1])) {
      out(USAGE)
      return 0
    }
    return await runExport(argv.slice(1), out, err, options)
  }
  if (argv[0] === 'import') {
    if (isHelp(argv[1])) {
      out(USAGE)
      return 0
    }
    return await runImport(argv.slice(1), out, err, options)
  }
  if (argv[0] === 'ingest') {
    return await runIngest(argv.slice(1), out, err, options)
  }
  if (argv[0] === 'init') {
    return await runInit(argv.slice(1), out, err, 0, options.homeDir, (homeDir) => initMachine({ homeDir }))
  }
  if (argv[0] === 'doctor') {
    // No directory: the machine scope has one, and it is the home directory.
    return await runDoctor(argv.slice(1), out, err, 0, () =>
      diagnose({ homeDir: options.homeDir, scope: 'machine' }),
    )
  }
  if (argv[0] === 'status') {
    return await runStatus(argv.slice(1), out, err, () => readUsageReports({ homeDir: options.homeDir }))
  }
  if (argv[0] === 'workspace') {
    return await runWorkspace(argv.slice(1), out, err, options)
  }
  if (argv[0] === 'remediate') {
    return await runRemediate(argv.slice(1), out, err, 1, (selector) =>
      remediate({ ...selector, homeDir: options.homeDir, scope: 'machine' }),
    )
  }
  if (argv[0] === 'swap') {
    if (isHelp(argv[1])) {
      out(USAGE)
      return 0
    }
    return await runSwap(argv.slice(1), 'machine', err, DEFAULT_USAGE, options)
  }
  if (argv[0] === 'project') {
    if (isHelp(argv[1])) {
      out(USAGE)
      return 0
    }
    if (argv[1] === 'doctor') {
      return await runDoctor(argv.slice(2), out, err, 1, async (directory) => {
        // Worktrees are PROJECT state: `runSession` puts them under the project's
        // own `.panda/workspaces`, so the machine scope has none to report and
        // this is the only doctor that looks. The list is discovered here and
        // handed in because `@panda/environment` may not import a workspace
        // implementation (spec M16.A, D4 and the environment guard test).
        const projectDir = directory ?? options.cwd ?? process.cwd()
        const inspection = await inspectWorktrees(worktreeStateDir(projectDir))
        return await diagnose({
          homeDir: options.homeDir,
          scope: 'project',
          projectDir,
          worktreeLeftovers: inspection.interrupted.map(
            (leftover): WorktreeLeftover => ({
              id: leftover.id,
              path: leftover.path,
              detail: leftover.detail,
            }),
          ),
        })
      })
    }
    if (argv[1] === 'remediate') {
      return await runRemediate(argv.slice(2), out, err, 2, (selector, directory) =>
        remediate({
          ...selector,
          homeDir: options.homeDir,
          scope: 'project',
          projectDir: directory ?? options.cwd,
        }),
      )
    }
    if (argv[1] === 'swap') {
      // Handled HERE and not inside `runSwap`, mirroring the machine branch
      // above. The printed-command invariant dispatches every verb path with a
      // help flag and requires exit 0; without this the flag was read as the
      // NOUN and the project scope exited 2. The invariant caught it, which is
      // the second real defect it has found in this story.
      if (isHelp(argv[2])) {
        out(USAGE)
        return 0
      }
      return await runSwap(argv.slice(2), 'project', err, DEFAULT_USAGE, options)
    }
    if (isRegistryVerb(argv[1])) {
      return await runRegistry(argv[1], argv.slice(2), 'project', out, err, options)
    }
    if (argv[1] !== 'init') {
      err(DEFAULT_USAGE)
      return 2
    }
    return await runInit(argv.slice(2), out, err, 1, options.homeDir, (homeDir, directory) =>
      initProject({ homeDir, projectDir: directory ?? options.cwd }),
    )
  }
  if (argv[0] !== 'run') {
    err(DEFAULT_USAGE)
    return 2
  }
  const runTokens = argv.slice(1)
  // The only help in the binary that used to REFUSE: `panda run --help` exited 2
  // with "unrecognized option", and `panda run -h` spawned a real, billed agent
  // with the prompt `-h`. `run` is now the one subcommand with a flag, so its
  // own usage block is the natural thing to ask for.
  if (isRunHelp(runTokens)) {
    out(USAGE)
    return 0
  }
  const parsed = parseRunTokens(runTokens)
  if ('usageError' in parsed) {
    err(parsed.usageError)
    err(DEFAULT_USAGE)
    return 2
  }
  const { prompt, executorId, trace } = parsed
  if (prompt.length === 0) {
    err(DEFAULT_USAGE)
    return 2
  }

  try {
    // The two capability calls, in order, with nothing between them the CLI
    // decided: reading panda's documents is `@panda/session`'s answer, and so is
    // the run. The layers are handed FORWARD rather than resolved here so the
    // documents are read once and the KERNEL's configuration is the one that
    // decides — the CLI holds no kernel and composes nothing (Story M3.B).
    const configLayers = await readExecutorConfigLayers({
      executorId,
      homeDir: options.homeDir,
      projectDir: options.cwd,
    })
    // Only under `--trace`. `state.dropped` counts failures of the write the
    // CALLER supplied, so with no write there is nothing that can fail and an
    // unconditional sink would carry a counter that is structurally zero.
    const log = trace ? createLogSink((record) => err(renderLogRecord(record))) : undefined
    // What the executor said about its own quota during THIS run (M15.A, D7).
    // Captured rather than written from inside the adapter: the adapter has no
    // business knowing where panda's home directory is, and the write must not
    // happen until the run is over.
    let observed: UsageReport | undefined
    const envelope = await runSession({
      prompt,
      log,
      configLayers,
      adapterOptions: {
        ...options.adapterOptions,
        // CHAINED, not replaced. `adapterOptions` is a caller-supplied seam, and
        // a spread that overwrote one of its callbacks would silently take the
        // reading away from a host that had asked for it — the CLI stealing a
        // hook it does not own.
        onUsageObservation: (report) => {
          observed = report
          options.adapterOptions?.onUsageObservation?.(report)
        },
      },
      cwd: options.cwd,
      createAdapter: options.createAdapter,
      createProvider: options.createProvider,
      onInterrupt: options.onInterrupt ?? defaultInterruptRegistration,
      // Which agent is about to produce the output, said BEFORE anything is
      // constructed, exactly where the old `resolveExecutor` call said it.
      onSelection: (selection) => reportSelection(selection, options.createAdapter !== undefined, err),
      // A configuration key panda read and could not use. Reported, never fatal:
      // one forward-looking key in `~/.panda/config.json` used to fail every run
      // on the machine, and silence would have been the other wrong answer.
      onWarning: (message) => err(message),
    })
    // Before the envelope, and required rather than defensive: `SessionOptions`
    // states the caller owns the sink they pass, DRAINING INCLUDED, so a write
    // still in flight is neither written nor counted until this resolves. It
    // also puts the whole trace on stderr before the result reaches stdout,
    // which is the order a human reads them in.
    if (log !== undefined) {
      await log.drain()
      // A trace the user asked for and did not fully get. Only reachable when
      // stderr itself refused a line (a closed pipe), which is exactly the case
      // where silence would be indistinguishable from a quiet run.
      if (log.state.dropped > 0) err(`trace: ${log.state.dropped} record(s) could not be written`)
    }
    // Printed AFTER cleanup now, where the old inline composition printed before
    // it. Deliberate, and the trade is worth naming: output can no longer be
    // interleaved with a half-torn-down workspace, but a HUNG release or dispose
    // withholds the envelope entirely, where before it had already been written.
    // `contained()` catches throws, not hangs — restoring the old order would
    // mean the CLI holding the workspace lifecycle again, which is the whole
    // thing this story removed. A cleanup timeout belongs in the session, and is
    // filed with the other AbortSignal-policy work in deferred-work.md.
    //
    // The run that produced the reading is the one that records it, so `panda
    // status` never has to spend quota to report on quota (D7). Best-effort by
    // design and said out loud when it fails: a bookkeeping write that could not
    // land must not turn a run that SUCCEEDED into a failed one, and silence
    // would leave `status` reporting a stale reading with nothing to explain it.
    if (observed !== undefined) {
      try {
        await recordUsageObservation(observed, { homeDir: options.homeDir })
      } catch (error) {
        err(`the usage reading from this run could not be recorded: ${describe(error)}`)
      }
    }
    // Inside the try on purpose: a payload that cannot be serialised is an
    // environment failure (exit 2), not an uncaught throw out of the binary.
    out(JSON.stringify(envelope, null, 2))
    return envelope.status === 'ok' ? 0 : 1
  } catch (error) {
    err(describe(error))
    return 2
  }
}

/**
 * Which agent is about to produce the output, and what decided it — a swap you
 * cannot see is not one you can trust. On stderr, so stdout stays exactly the
 * envelope JSON a caller pipes into a parser, and BEFORE the run so it still
 * reaches the user when the run then fails or hangs.
 *
 * Two cases, because they are different claims:
 *   - panda selected and panda ran it: report the selection.
 *   - a host supplied its own adapter: panda selected nothing, so an unqualified
 *     selection line would be false. Silence is right for an IMPLICIT selection
 *     — and wrong for an explicit one, where the user typed `--executor codex`,
 *     panda resolved it, and something else then ran. That gets said out loud.
 *
 * `createAdapter` is an SDK/test seam with no argv spelling, so every actual
 * invocation of the binary takes the first branch.
 */
function reportSelection(
  selection: { executorId: string; layer: string },
  overridden: boolean,
  err: (line: string) => void,
): void {
  const line = `executor: ${selection.executorId} (selected by the '${selection.layer}' layer)`
  if (!overridden) {
    err(line)
    return
  }
  if (selection.layer === 'invocation') err(`${line} — overridden by the host-supplied adapter`)
}

/**
 * Help for `panda run`. `--help` anywhere, because every other `--` token is
 * already a usage error and so cannot be prompt text; `-h` only when it is the
 * WHOLE argument list, because a single dash is legitimate inside a prompt and
 * `panda run explain -h` must stay a prompt.
 */
function isRunHelp(tokens: readonly string[]): boolean {
  return tokens.includes('--help') || (tokens.length === 1 && tokens[0] === '-h')
}

/**
 * `panda run`'s argv: an optional `--executor <id>` (or `--executor=<id>`) and
 * the prompt words. Every other `--` token stays a usage error, and a SINGLE
 * dash still falls through as prompt text, which is what `panda run` has always
 * done — a prompt is free text and `-x` is a legitimate part of one.
 */
function parseRunTokens(
  tokens: readonly string[],
): { prompt: string; executorId: string | undefined; trace: boolean } | { usageError: string } {
  const EXECUTOR_FLAG = '--executor'
  const TRACE_FLAG = '--trace'
  const words: string[] = []
  let executorId: string | undefined
  let trace = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    // Above the `--` refusal below, and it takes NO value: `--trace=verbose`
    // stays `unrecognized option`, because the thing after the `=` would have to
    // mean something, and the session already narrows the stream to `action.*`
    // — a second filter here would be a filter for one event family.
    if (token === TRACE_FLAG) {
      trace = true
      continue
    }
    if (token === EXECUTOR_FLAG) {
      const value = tokens[index + 1]
      // A following option is not a value: `panda run --executor --help` must be
      // a usage error, not a run of an executor named '--help'.
      if (value === undefined || value.length === 0 || value.startsWith('-')) {
        return { usageError: `option '${EXECUTOR_FLAG}' requires an executor id` }
      }
      executorId = value
      index += 1
      continue
    }
    if (token.startsWith(`${EXECUTOR_FLAG}=`)) {
      const value = token.slice(EXECUTOR_FLAG.length + 1)
      // The SAME guard as the two-token form: `--executor=-x` reached the
      // catalogue while `--executor -x` was refused, which is two answers to one
      // question.
      if (value.length === 0 || value.startsWith('-')) {
        return { usageError: `option '${EXECUTOR_FLAG}' requires an executor id` }
      }
      executorId = value
      continue
    }
    if (token.startsWith('--')) return { usageError: `unrecognized option '${token}'` }
    words.push(token)
  }
  return { prompt: words.join(' ').trim(), executorId, trace }
}

/**
 * One record, one line, for a human watching a run happen. Fields in the order
 * the kernel writes them, each present only when the record carries it.
 *
 * It formats and decides nothing — the whole of cordis's `ConsoleExporter` is
 * `console.log(this.render(message))` over a renderer just like this one. `at`
 * is left out on purpose: the record carries a wall clock for whoever PERSISTS
 * the stream, but ordering is `seq`, and a timestamp on a line scrolling past
 * live is noise that carries no order the number does not already carry.
 */
export function renderLogRecord(record: LogRecord): string {
  const parts = [`[${record.seq}]`, record.event, record.subject]
  if (record.service !== undefined) parts.push(`service=${record.service}`)
  if (record.code !== undefined) parts.push(record.code)
  if (record.cost !== undefined) parts.push(`cost=${record.cost}`)
  return parts.join(' ')
}

/**
 * Argv validation shared by every subcommand that takes at most one directory.
 * Returns the exit code when the tokens were help or a usage error, and
 * `undefined` when they are usable — one rule, so `doctor` cannot drift into
 * accepting an option `init` rejects.
 */
function usageOutcome(
  tokens: readonly string[],
  maxPositionals: 0 | 1,
  out: (line: string) => void,
  err: (line: string) => void,
  /** What the one positional IS, so the refusal names the thing that was wrong. */
  positional: 'directory' | 'workspace id' = 'directory',
): number | undefined {
  const flagToken = optionToken(tokens)
  if (isHelp(flagToken)) {
    // The usage block advertises these subcommands, so asking it for help on one
    // of them cannot be the one thing it refuses to do.
    out(USAGE)
    return 0
  }
  if (flagToken !== undefined) {
    err(`unrecognized option '${flagToken}'`)
    err(DEFAULT_USAGE)
    return 2
  }
  if (tokens.length > maxPositionals) {
    err(
      maxPositionals === 0
        ? `unexpected argument '${tokens[0]}'`
        : `unexpected argument '${tokens[maxPositionals]}'; at most one ${positional} may be given`,
    )
    err(DEFAULT_USAGE)
    return 2
  }
  return undefined
}

/**
 * The whole of what `panda workspace remove` is: reject bad argv, call the
 * worktree capability in `@panda/session`, print what it did, map it to an exit
 * code. Every fact printed is the capability's — the CLI removes nothing, checks
 * nothing and classifies nothing.
 *
 * ONE noun, and it is honest about what it will not do (spec M16.A, D6). With an
 * id it removes that worktree; with none it finishes the removals an interrupted
 * run left half-done, through the SAME call — a sweep that resolved a leftover
 * some other way would be a second answer to the question the removal already
 * answers. Everything it will not remove is REPORTED with the reason, never
 * skipped in silence and never counted as a success.
 */
async function runWorkspace(
  tokens: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  options: RunCommandOptions,
): Promise<number> {
  if (isHelp(tokens[0])) {
    out(USAGE)
    return 0
  }
  if (tokens[0] !== 'remove') {
    err(
      tokens[0] === undefined
        ? 'panda workspace needs a noun: remove'
        : `panda workspace has no '${tokens[0]}' noun; it has: remove`,
    )
    err(DEFAULT_USAGE)
    return 2
  }
  const rest = tokens.slice(1)
  const usage = usageOutcome(rest, 1, out, err, 'workspace id')
  if (usage !== undefined) return usage

  // The project the binary is running in, exactly as `panda run` reads it: a
  // worktree lives under that project's own state directory, and the path is
  // asked for rather than spelled here so the remover cannot look somewhere
  // other than where the run wrote.
  const stateDir = worktreeStateDir(options.cwd ?? process.cwd())
  try {
    const named = rest[0]
    const outcomes: WorktreeOutcome[] = []
    let inspection: WorktreeInspection | undefined
    if (named === undefined) {
      inspection = await inspectWorktrees(stateDir)
      for (const leftover of inspection.interrupted) {
        outcomes.push(await removeWorktree(stateDir, leftover.id))
      }
    } else {
      outcomes.push(await removeWorktree(stateDir, named))
    }

    out(
      JSON.stringify(
        {
          stateDir,
          outcomes,
          ...(inspection === undefined
            ? {}
            : { claimed: inspection.claimed, unclaimed: inspection.unclaimed }),
        },
        null,
        2,
      ),
    )
    for (const outcome of outcomes) err(formatWorktreeOutcome(outcome))
    if (inspection !== undefined) {
      // Reported and never removed (D2/E5): what makes a worktree panda's is the
      // ownership record, so a directory without one is somebody else's however
      // exactly it is shaped like panda's.
      for (const directory of inspection.unclaimed) {
        err(
          `unclaimed: ${directory.id} (${directory.path}): panda holds no ownership record for this directory, so it is not panda's to remove and nothing here will remove it`,
        )
      }
      // The healthy claims, said out loud: a sweep that printed nothing about
      // them would look like it had considered and rejected them.
      for (const worktree of inspection.claimed) {
        err(
          `claimed: ${worktree.id} (${worktree.path}): panda claims this worktree and no removal was asked for; name its id to remove it`,
        )
      }
      if (
        outcomes.length === 0 &&
        inspection.unclaimed.length === 0 &&
        inspection.claimed.length === 0
      ) {
        err(`nothing to remove: panda holds no worktrees under '${stateDir}'`)
      } else if (outcomes.length === 0) {
        err('nothing to resolve: no worktree removal was left unfinished in this project')
      }
    }
    // A refusal is not a success, and neither is an id panda does not own —
    // reporting either as 0 would tell a script the tree is gone.
    return outcomes.some((outcome) => outcome.kind === 'refused' || outcome.kind === 'unknown')
      ? 1
      : 0
  } catch (error) {
    err(describe(error))
    return 2
  }
}

/** One outcome on one line, with the coded reason whenever nothing was removed. */
function formatWorktreeOutcome(outcome: WorktreeOutcome): string {
  const about = outcome.path === undefined ? outcome.id : `${outcome.id} (${outcome.path})`
  return `${outcome.kind}: ${about}: ${outcome.error === undefined ? outcome.detail : describe(outcome.error)}`
}

/**
 * The whole of what `panda doctor` and `panda project doctor` are: reject bad
 * argv, call the capability in `@panda/environment`, print its diagnosis, map
 * findings to an exit code. Every fact printed is the capability's — the CLI
 * classifies nothing, decides nothing about drift, and writes nothing.
 */
async function runDoctor(
  tokens: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  maxPositionals: 0 | 1,
  capability: (directory: string | undefined) => Promise<Diagnosis>,
): Promise<number> {
  const usage = usageOutcome(tokens, maxPositionals, out, err)
  if (usage !== undefined) return usage
  try {
    const diagnosis = await capability(tokens[0])
    out(JSON.stringify(diagnosis, null, 2))
    for (const found of diagnosis.findings) err(formatFinding(found))
    // The same two facts `panda init` prints and findings have no room for: an
    // executor with no location for this scope is not a problem, and a path
    // panda could not CHECK is not evidence that nothing is installed.
    for (const skip of diagnosis.skipped) err(`${skip.executorId}: nothing would be projected: ${skip.reason}`)
    const undetermined = undeterminedEvidence(diagnosis.detected)
    if (undetermined !== undefined) err(undetermined)
    // Severity, not count. Every target failing still exits 1 rather than 2:
    // doctor DID look — it enumerated the executors, read the ledger and
    // produced a per-target verdict — and 2 is reserved for the cases where no
    // diagnosis exists to print at all (a scope directory it cannot use).
    return hasProblem(diagnosis) ? 1 : 0
  } catch (error) {
    err(describe(error))
    return 2
  }
}

/**
 * The whole of what `panda status` is: reject bad argv, call the capability,
 * print what it read, exit 0.
 *
 * It takes no directory and no flag because it has no scope to narrow and no
 * work to authorise — every fact in it is a reading some earlier RUN already
 * paid for, and the capability neither invokes an executor nor opens a store for
 * writing (D6/D7). `panda status` on a machine that has never run anything is
 * therefore instant, offline, and free.
 *
 * The exit code follows `doctor`'s convention rather than inventing a third: 0
 * whenever a report could be produced — an all-absence report is still a report,
 * and absence here is an answer — and 2 only when none could be. There is no 1,
 * because a utilisation is not a verdict panda gets to fail on.
 *
 * Said out loud rather than implied: with today's capability there is no input
 * that reaches that 2. Every row is derivable from the shipped catalogue, and a
 * stored reading panda cannot read is reported as absence rather than raised —
 * MEASURED in `test/status.test.ts`, which drives an unreadable home directory
 * and still gets 0. The `catch` is the same uncaught-throw guard every other
 * binding in this file carries, kept so a future capability that CAN fail
 * reaches the user as an exit code instead of a stack trace.
 */
async function runStatus(
  tokens: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  capability: () => Promise<readonly UsageReport[]>,
): Promise<number> {
  const usage = usageOutcome(tokens, 0, out, err)
  if (usage !== undefined) return usage
  try {
    const reports = await capability()
    out(JSON.stringify(reports, null, 2))
    for (const report of reports) err(formatUsageReport(report))
    return 0
  } catch (error) {
    err(describe(error))
    return 2
  }
}

/**
 * One executor per line, for a human reading stderr while stdout is piped.
 *
 * The vendor's own window NAMES and the vendor's own numbers, printed as they
 * were read (D5): no averaging across windows, no "N% remaining", and no reset
 * instant rendered as a countdown that is already wrong by the time it is on
 * screen. `observedAt` is printed beside them because a utilisation is only
 * true as of its reading, and a report that hides its age lies with a straight
 * face — the reader, not panda, decides whether an hour-old reading is stale.
 *
 * An absence prints its CODE next to its sentence, for the same reason findings
 * do: the code is what a script routes on (AD-7), the sentence is for the human.
 */
function formatUsageReport(report: UsageReport): string {
  if (report.kind === 'absent') return `${report.executorId}: ${report.reason}: ${report.detail}`
  const windows = report.windows
    .map((window) => `${window.name} utilization=${window.utilization} resetsAt=${window.resetsAt}`)
    .join(' · ')
  return `${report.executorId}: observed at ${report.observedAt}: ${windows}`
}

/**
 * `panda remediate`'s argv: the verb, and the two narrowing flags.
 *
 * `--apply` is a FLAG rather than the default, and that asymmetry with `panda
 * init` is the point: a projection converges a machine a user asked panda to
 * manage, while a remediation changes who owns what. Describing it first is the
 * frozen requirement, so the plain form describes and the flag performs.
 */
function parseRemediateTokens(
  tokens: readonly string[],
  maxPositionals: 1 | 2,
):
  | { remediation: RemediationKind; executorId?: string; entryId?: string; directory?: string; apply: boolean }
  | { usageError: string } {
  let remediation: RemediationKind | undefined
  let executorId: string | undefined
  let entryId: string | undefined
  let directory: string | undefined
  let apply = false
  const named: Record<string, (value: string) => void> = {
    '--executor': (value) => {
      executorId = value
    },
    '--entry': (value) => {
      entryId = value
    },
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (token === '--apply') {
      apply = true
      continue
    }
    const equals = Object.keys(named).find((flag) => token.startsWith(`${flag}=`))
    if (equals !== undefined) {
      const value = token.slice(equals.length + 1)
      // The SAME guard as the two-token form below: `--entry=-x` reaching the
      // selector while `--entry -x` is refused would be two answers to one
      // question, which is the shape `--executor` was already fixed for.
      if (value.length === 0 || value.startsWith('-')) return { usageError: `option '${equals}' requires a value` }
      named[equals]!(value)
      continue
    }
    if (named[token] !== undefined) {
      const value = tokens[index + 1]
      if (value === undefined || value.length === 0 || value.startsWith('-')) {
        return { usageError: `option '${token}' requires a value` }
      }
      named[token]!(value)
      index += 1
      continue
    }
    if (token.startsWith('-')) return { usageError: `unrecognized option '${token}'` }
    if (remediation === undefined) {
      if (!(REMEDIATION_KINDS as readonly string[]).includes(token)) {
        return { usageError: `unknown remediation '${token}'; panda has ${REMEDIATION_KINDS.join(', ')}` }
      }
      remediation = token as RemediationKind
      continue
    }
    // The project form takes a directory after the verb, exactly like `panda
    // project init [directory]` and `panda project doctor [directory]`; the
    // machine form has one scope and takes none.
    if (maxPositionals === 2 && directory === undefined) {
      directory = token
      continue
    }
    return { usageError: `unexpected argument '${token}'` }
  }
  if (remediation === undefined) {
    return { usageError: `panda remediate needs a remediation: ${REMEDIATION_KINDS.join(', ')}` }
  }
  return { remediation, executorId, entryId, directory, apply }
}

/**
 * The whole of what `panda remediate` is: reject bad argv, call the capability,
 * print what it described or did, map the outcome to an exit code. The CLI
 * selects no finding, classifies no state and writes nothing — even the sentence
 * describing a change is the capability's, computed by the code that performs it.
 */
async function runRemediate(
  tokens: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  maxPositionals: 1 | 2,
  capability: (
    selector: {
      remediation: RemediationKind
      executorId?: string
      entryId?: string
      mode: 'apply' | 'inspect'
    },
    directory: string | undefined,
  ) => Promise<RemediationReport>,
): Promise<number> {
  // `--help` ANYWHERE, like `panda run`: every other `--` token here is already
  // a usage error, so it cannot be anything else. Matching only the FIRST option
  // token made `panda remediate adopt --apply --help` a usage error while
  // `--help --apply` printed help, which is two answers to one question.
  if (tokens.some((token) => isHelp(token))) {
    out(USAGE)
    return 0
  }
  const parsed = parseRemediateTokens(tokens, maxPositionals)
  if ('usageError' in parsed) {
    err(parsed.usageError)
    err(DEFAULT_USAGE)
    return 2
  }
  try {
    const report = await capability(
      {
        remediation: parsed.remediation,
        ...(parsed.executorId === undefined ? {} : { executorId: parsed.executorId }),
        ...(parsed.entryId === undefined ? {} : { entryId: parsed.entryId }),
        mode: parsed.apply ? 'apply' : 'inspect',
      },
      parsed.directory,
    )
    // The full diagnosis is deliberately NOT printed on stdout here: the payload
    // a caller pipes is the remediation, and `panda doctor` is the command whose
    // payload is the diagnosis. Named field by field rather than rest-spread, so
    // this payload's key order is authored and pinned instead of inherited.
    out(
      JSON.stringify(
        {
          scope: report.scope,
          remediation: report.remediation,
          mode: report.mode,
          ...(report.finding === undefined ? {} : { finding: report.finding }),
          ...(report.outcome === undefined ? {} : { outcome: report.outcome }),
          ...(report.refusal === undefined ? {} : { refusal: report.refusal }),
          candidates: report.candidates,
        },
        null,
        2,
      ),
    )
    const refusal = report.refusal ?? report.outcome?.refusal
    if (refusal !== undefined) {
      err(`${refusal.code}: ${refusal.message}`)
      for (const candidate of report.candidates) err(formatFinding(candidate))
      return 1
    }
    const changes = report.outcome?.changes ?? []
    if (changes.length === 0) {
      err(`${parsed.remediation}: nothing to change — the state this resolves is already gone`)
      return 0
    }
    for (const change of changes) {
      err(
        `${report.mode === 'apply' ? 'changed' : 'would change'}: ${change.subject} ${change.action} ${change.path} (${change.byteDelta} byte(s)): ${change.detail}`,
      )
    }
    if (report.mode !== 'apply') err('nothing was written; re-run with --apply to perform it')
    return 0
  } catch (error) {
    err(describe(error))
    return 2
  }
}

/**
 * The registry verbs, bound the same way every other command is: help, then the
 * capability, then an exit code — with the thrown-error case mapped by the same
 * `describe()` the rest of the binding uses, so `PANDA_REGISTRY_CONTENTION` and
 * `PANDA_REGISTRY_INVALID_ENTRY` reach the user carrying their codes.
 *
 * `--help` ANYWHERE, like `panda run` and `panda remediate`: every other `--`
 * token these verbs do not know is already a usage error, so it cannot be
 * anything else — and `panda add skill x --entry-path ./s.md --help` printing
 * usage while `--help --entry-path ./s.md` refuses would be two answers to one
 * question.
 */
/**
 * The import verb: install, then RE-PROJECT, in that order.
 *
 * FR-22 is one sentence with two verbs and the order is not free — projecting
 * before the entries are in place would project the registry the machine had a
 * moment ago. The projection half is `initMachine`, the same capability `init`
 * runs, reported through the same `reportInitOutcome`.
 *
 * One JSON object on stdout, with the projection nested. Two would be two
 * documents for a consumer that reasonably calls JSON.parse on the whole stream.
 */
async function runImport(
  tokens: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  options: RunCommandOptions,
): Promise<number> {
  try {
    const installed = await runImportCommand(tokens, {
      out,
      err,
      defaultUsage: DEFAULT_USAGE,
      homeDir: options.homeDir,
      cwd: options.cwd,
    })
    if (typeof installed === 'number') return installed
    const projection = await initMachine({ homeDir: installed.homeDir })
    out(JSON.stringify({ ...installed, projection }, null, 2))
    // Said on stderr too, because a user who ran a command wants the manual work
    // without parsing JSON for it. An entry that could not travel is absent,
    // named, and theirs to re-add — panda does not guess at what the secret was.
    for (const entry of installed.pending) {
      err(
        // The `id` arm names NO id, because there the id is the credential —
        // and it still has to say what to do, since the entry is intact in the
        // source machine's registry and re-adding it is hand work.
        entry.field === 'id'
          ? `pending: one ${entry.type} was not exported because its own id carried a credential, so panda cannot name it here; the source machine's registry still holds it and it has to be re-added by hand`
          : `pending: ${entry.type} '${entry.id}' was not exported (its ${entry.field} carried a credential)`,
      )
    }
    for (const entry of installed.replaced) {
      err(`replaced: ${entry.type} '${entry.id}' was already registered here`)
    }
    return reportInitOutcome(projection, err)
  } catch (error) {
    err(describe(error))
    return 2
  }
}

/**
 * The export verb. Its own wrapper rather than a RegistryVerb: it takes no
 * entry, no type and no directory, so the registry grammar has nothing to parse
 * for it, and there is no project-scoped spelling to offer — a project's
 * entries name a directory the destination machine does not have.
 */
async function runExport(
  tokens: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  options: RunCommandOptions,
): Promise<number> {
  try {
    return await runExportCommand(tokens, {
      out,
      err,
      defaultUsage: DEFAULT_USAGE,
      homeDir: options.homeDir,
      cwd: options.cwd,
    })
  } catch (error) {
    err(describe(error))
    return 2
  }
}

/**
 * `panda ingest` — the registry filling itself from what is already installed.
 *
 * The same wrapper shape as `runExport`: help, then one capability call, then
 * the coded failure as exit 2. `--help` ANYWHERE, like `panda remediate`, so
 * `panda ingest --dry-run --help` and `--help --dry-run` cannot be two answers
 * to one question.
 */
async function runIngest(
  tokens: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  options: RunCommandOptions,
): Promise<number> {
  if (tokens.some((token) => isHelp(token))) {
    out(USAGE)
    return 0
  }
  try {
    return await runIngestCommand(tokens, {
      out,
      err,
      defaultUsage: DEFAULT_USAGE,
      homeDir: options.homeDir,
      cwd: options.cwd,
    })
  } catch (error) {
    err(describe(error))
    return 2
  }
}

async function runRegistry(
  verb: RegistryVerb,
  tokens: readonly string[],
  scope: 'machine' | 'project',
  out: (line: string) => void,
  err: (line: string) => void,
  options: RunCommandOptions,
): Promise<number> {
  // Help ANYWHERE, but only BEFORE the `--` terminator: past it every token is
  // an id, and an entry may legitimately be called `--help`.
  if (tokens.slice(0, terminatorAt(tokens)).some((token) => isHelp(token))) {
    out(USAGE)
    return 0
  }
  try {
    return await runRegistryCommand(verb, tokens, scope, {
      out,
      err,
      defaultUsage: DEFAULT_USAGE,
      homeDir: options.homeDir,
      cwd: options.cwd,
    })
  } catch (error) {
    err(describe(error))
    return 2
  }
}

/**
 * The paths panda could not check, as one line, or nothing when there are none.
 * Shared with `panda init` because "nothing is installed" and "panda could not
 * look" are different claims in both commands, and only one of them is ever true.
 */
function undeterminedEvidence(detected: readonly ExecutorDetection[]): string | undefined {
  const undetermined = detected
    .flatMap((detection) => detection.evidence)
    .filter((item) => item.exists === undefined)
  if (undetermined.length === 0) return undefined
  const paths = undetermined.map((item) => `${item.path} (${item.error ?? 'unknown error'})`).join(', ')
  // One line, deliberately: a printed string that WRAPS is invisible to the
  // printed-command invariant, which cannot scan across a newline.
  return `panda could not determine whether these exist, so this is not evidence that nothing is installed: ${paths}`
}

/**
 * One finding on one line, naming everything it is about. A finding a user
 * cannot act on is not one, so the executor, the file, the native location and
 * the entry are printed whenever the capability supplied them — and the
 * resolution, which is what re-projecting would do about it.
 */
function formatFinding(found: DiagnosisFinding): string {
  const about = [found.executorId, found.filePath, found.location, found.entryId]
    .filter((part): part is string => part !== undefined)
    .join(' · ')
  // The severity is printed, not only acted on: a reader who sees a line on
  // stderr and an exit code of 0 has to be able to see why the two agree.
  return `${found.severity}: ${found.kind}${about === '' ? '' : ` (${about})`}: ${found.detail} — ${found.resolution}`
}

/**
 * The whole of what `panda init` and `panda project init` are: reject bad argv,
 * call the capability in `@panda/environment`, print its result, map it to an
 * exit code. Every fact printed is produced by the capability — the CLI adds no
 * detection, no projection and no interpretation of its own.
 */
async function runInit(
  tokens: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  maxPositionals: 0 | 1,
  homeDir: string | undefined,
  capability: (homeDir: string | undefined, directory: string | undefined) => Promise<InitResult>,
): Promise<number> {
  const usage = usageOutcome(tokens, maxPositionals, out, err)
  if (usage !== undefined) return usage
  try {
    const result = await capability(homeDir, tokens[0])
    out(JSON.stringify(result, null, 2))
    return reportInitOutcome(result, err)
  } catch (error) {
    err(describe(error))
    return 2
  }
}

/**
 * The stderr and the exit code an `InitResult` implies, SHARED by `init` and by
 * `import`.
 *
 * Import re-projects (FR-22), so it produces the same result object from the
 * same capability — and a second copy of this mapping is how two commands come
 * to disagree about one outcome. A script branching on `panda import` must not
 * have to learn a second meaning for exit 1.
 */
function reportInitOutcome(result: InitResult, err: (line: string) => void): number {
  reportDiagnostics(result, err)
  if (noExecutorsDetected(result)) {
    // The JSON already lists every executor and every path consulted; these
    // lines are the same facts for a human reading stderr — including the paths
    // panda could NOT check, because "nothing is installed" and "panda could not
    // look" are different claims and only one is true here.
    const evidence = result.detected.flatMap((detection) => detection.evidence)
    err(
      `no executor configuration was found under any of: ${evidence
        .filter((item) => item.exists === false)
        .map((item) => item.path)
        .join(', ')}`,
    )
    const undetermined = undeterminedEvidence(result.detected)
    if (undetermined !== undefined) err(undetermined)
    return 2
  }
  const failed = [...result.targets, ...result.skills].filter((target) => target.error !== undefined)
  for (const target of failed) err(`${target.executorId}: ${target.error?.code}: ${target.error?.message}`)
  return failed.length > 0 ? 1 : 0
}

/**
 * Drift, unprojectable entries, executors with no location for this scope, and
 * the ledger's own warnings all leave the exit code at 0, because none of them
 * is a failed run. Printed anyway, because a run where every entry drifted — or
 * where panda LOST its ownership records, which is what a ledger warning says —
 * is otherwise indistinguishable from success in a script that only reads the
 * exit code and stderr.
 */
function reportDiagnostics(result: InitResult, err: (line: string) => void): void {
  for (const warning of result.warnings) err(`${warning.code}: ${warning.detail}`)
  for (const target of [...result.targets, ...result.skills]) {
    for (const entry of target.drift) {
      err(`${target.executorId}: drift (${entry.kind}) at ${entry.location}: ${entry.detail}`)
    }
    for (const entry of target.unprojectable) {
      err(`${target.executorId}: '${entry.entryId}' was not projected: ${entry.reason}`)
    }
  }
  for (const skip of result.skipped) err(`${skip.executorId}: nothing was projected: ${skip.reason}`)
}

function describe(error: unknown): string {
  // Duck-typed on `code` rather than `instanceof PandaError`: AD-1 forbids the
  // kernel from importing the contracts package, so `PandaKernelError` is a
  // DISJOINT hierarchy — an instanceof check against either one silently drops
  // the other's code, and a budget refusal is precisely the case whose code the
  // user needs. It also leaves this package importing nothing but the two
  // consumer-tier capability packages.
  const code: unknown = (error as { code?: unknown } | null | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' && code.length > 0 ? `${code}: ${message}` : message
}
