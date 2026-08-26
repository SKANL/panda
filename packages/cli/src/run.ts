import { initMachine, initProject, noExecutorsDetected, type InitMachineOptions, type InitResult } from '@panda/environment'
import { runSession, type SessionOptions } from '@panda/session'

// Exit codes (documented in the package README):
//   0 — run completed with an ok envelope / init completed with no failed target
//   1 — run returned a failed or cancelled envelope / a target failed to project
//   2 — usage error, invalid request, or environment failure (including
//       "no executor was detected", which is the environment lacking anything
//       for panda to configure)

/**
 * The seams are PICKED from the capability packages rather than redeclared: this
 * package forwards them and owns none of them, so naming their types here would
 * be the first step back towards composing sessions in the CLI (see the
 * thin-binding pin in `test/run.test.ts`). What the CLI owns is where the output
 * goes.
 */
export interface RunCommandOptions
  extends Pick<SessionOptions, 'cwd' | 'createAdapter' | 'createProvider' | 'onInterrupt'>,
    Pick<InitMachineOptions, 'homeDir'> {
  readonly stdout?: (line: string) => void
  readonly stderr?: (line: string) => void
}

export const USAGE = [
  'usage: panda run "<prompt>"',
  '       panda init',
  '       panda project init [directory]',
  '       panda --help',
  '',
  'run           Runs <prompt> through the Claude Code adapter inside a workspace under .panda/workspaces.',
  "init          Prepares this machine and projects the registry into every detected executor's own config.",
  'project init  Binds a project and projects into every detected executor that has a project-scope config.',
  '',
  'Exit codes: 0 ok · 1 failed/cancelled · 2 usage/environment error.',
  'For init, a target that failed to project exits 1; detecting no executor at all exits 2.',
].join('\n')

const DEFAULT_USAGE = USAGE.split('\n').slice(0, 4).join('\n')

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
  if (argv[0] === 'project') {
    if (isHelp(argv[1])) {
      out(USAGE)
      return 0
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
  const flagToken = argv.slice(1).find((token) => token.startsWith('--'))
  if (flagToken !== undefined) {
    err(`unrecognized option '${flagToken}'`)
    err(DEFAULT_USAGE)
    return 2
  }
  const prompt = argv.slice(1).join(' ').trim()
  if (prompt.length === 0) {
    err(DEFAULT_USAGE)
    return 2
  }

  try {
    const envelope = await runSession({
      prompt,
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
      const undetermined = evidence.filter((item) => item.exists === undefined)
      if (undetermined.length > 0) {
        err(
          `panda could not determine whether these exist, so this is not evidence that nothing is installed: ${undetermined
            .map((item) => `${item.path} (${item.error ?? 'unknown error'})`)
            .join(', ')}`,
        )
      }
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
