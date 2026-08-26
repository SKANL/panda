import {
  diagnose,
  hasProblem,
  initMachine,
  initProject,
  noExecutorsDetected,
  type Diagnosis,
  type DiagnosisFinding,
  type ExecutorDetection,
  type InitMachineOptions,
  type InitResult,
} from '@panda/environment'
import { resolveExecutor, runSession, type SessionOptions } from '@panda/session'

// Exit codes (documented in the package README):
//   0 — run completed with an ok envelope / init completed with no failed target
//   1 — run returned a failed or cancelled envelope / a target failed to project
//   2 — usage error, invalid request, or environment failure (including
//       "no executor was detected", which is the environment lacking anything
//       for panda to configure)
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

export const USAGE = [
  'usage: panda run [--executor <id>] "<prompt>"',
  '       panda init',
  '       panda project init [directory]',
  '       panda doctor',
  '       panda project doctor [directory]',
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
  "init          Prepares this machine and projects the registry into every detected executor's own config.",
  'project init  Binds a project and projects into every detected executor that has a project-scope config.',
  'doctor        Reports what init would change and every problem panda can see. Writes nothing.',
  'project doctor  The same report for a project, matching what project init would do.',
  '',
  'Exit codes: 0 ok · 1 failed/cancelled · 2 usage/environment error.',
  'For init, a target that failed to project exits 1; detecting no executor at all exits 2.',
  'For doctor, a finding that is a problem exits 1; a clean environment exits 0.',
].join('\n')

const DEFAULT_USAGE = USAGE.split('\n').slice(0, 6).join('\n')

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

export async function runPanda(argv: readonly string[], options: RunCommandOptions = {}): Promise<number> {
  const out = options.stdout ?? ((line: string) => console.log(line))
  const err = options.stderr ?? ((line: string) => console.error(line))

  if (argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE)
    return 0
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
  if (argv[0] === 'project') {
    if (isHelp(argv[1])) {
      out(USAGE)
      return 0
    }
    if (argv[1] === 'doctor') {
      return await runDoctor(argv.slice(2), out, err, 1, (directory) =>
        diagnose({ homeDir: options.homeDir, scope: 'project', projectDir: directory ?? options.cwd }),
      )
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
  const { prompt, executorId } = parsed
  if (prompt.length === 0) {
    err(DEFAULT_USAGE)
    return 2
  }

  try {
    // The two capability calls, in order, with nothing between them the CLI
    // decided: which executor is `@panda/session`'s answer, and so is the run.
    const selection = await resolveExecutor({
      executorId,
      homeDir: options.homeDir,
      projectDir: options.cwd,
    })
    reportSelection(selection, options.createAdapter !== undefined, err)
    const envelope = await runSession({
      prompt,
      executorId: selection.executorId,
      adapterOptions: options.adapterOptions,
      cwd: options.cwd,
      createAdapter: options.createAdapter,
      createProvider: options.createProvider,
      onInterrupt: options.onInterrupt ?? defaultInterruptRegistration,
    })
    // Printed AFTER cleanup now, where the old inline composition printed before
    // it. Deliberate, and the trade is worth naming: output can no longer be
    // interleaved with a half-torn-down workspace, but a HUNG release or dispose
    // withholds the envelope entirely, where before it had already been written.
    // `contained()` catches throws, not hangs — restoring the old order would
    // mean the CLI holding the workspace lifecycle again, which is the whole
    // thing this story removed. A cleanup timeout belongs in the session, and is
    // filed with the other AbortSignal-policy work in deferred-work.md.
    //
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
): { prompt: string; executorId: string | undefined } | { usageError: string } {
  const EXECUTOR_FLAG = '--executor'
  const words: string[] = []
  let executorId: string | undefined
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
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
  return { prompt: words.join(' ').trim(), executorId }
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
        : `unexpected argument '${tokens[maxPositionals]}'; at most one directory may be given`,
    )
    err(DEFAULT_USAGE)
    return 2
  }
  return undefined
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
 * The paths panda could not check, as one line, or nothing when there are none.
 * Shared with `panda init` because "nothing is installed" and "panda could not
 * look" are different claims in both commands, and only one of them is ever true.
 */
function undeterminedEvidence(detected: readonly ExecutorDetection[]): string | undefined {
  const undetermined = detected
    .flatMap((detection) => detection.evidence)
    .filter((item) => item.exists === undefined)
  if (undetermined.length === 0) return undefined
  return `panda could not determine whether these exist, so this is not evidence that nothing is installed: ${undetermined
    .map((item) => `${item.path} (${item.error ?? 'unknown error'})`)
    .join(', ')}`
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
    reportDiagnostics(result, err)
    if (noExecutorsDetected(result)) {
      // The JSON above already lists every executor and every path consulted;
      // these lines are the same facts for a human reading stderr — including
      // the paths panda could NOT check, because "nothing is installed" and
      // "panda could not look" are different claims and only one is true here.
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
    const failed = result.targets.filter((target) => target.error !== undefined)
    for (const target of failed) err(`${target.executorId}: ${target.error?.code}: ${target.error?.message}`)
    return failed.length > 0 ? 1 : 0
  } catch (error) {
    err(describe(error))
    return 2
  }
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
  for (const target of result.targets) {
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
