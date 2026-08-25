import { runSession, type SessionOptions } from '@panda/session'

// Exit codes (documented in the package README):
//   0 — run completed with an ok envelope
//   1 — run returned a failed or cancelled envelope
//   2 — usage error, invalid request, or environment failure

/**
 * The seams are PICKED from `SessionOptions` rather than redeclared: this package
 * forwards them and owns none of them, so naming their types here would be the
 * first step back towards composing sessions in the CLI (see the thin-binding pin
 * in `test/run.test.ts`). What the CLI owns is where the output goes.
 */
export interface RunCommandOptions
  extends Pick<SessionOptions, 'cwd' | 'createAdapter' | 'createProvider' | 'onInterrupt'> {
  readonly stdout?: (line: string) => void
  readonly stderr?: (line: string) => void
}

export const USAGE = [
  'usage: panda run "<prompt>"',
  '       panda --help',
  '',
  'Runs <prompt> through the Claude Code adapter inside a workspace under .panda/workspaces.',
  'Exit codes: 0 ok · 1 failed/cancelled · 2 usage/environment error.',
].join('\n')

const DEFAULT_USAGE = USAGE.split('\n')[0] ?? USAGE

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

export async function runPanda(argv: readonly string[], options: RunCommandOptions = {}): Promise<number> {
  const out = options.stdout ?? ((line: string) => console.log(line))
  const err = options.stderr ?? ((line: string) => console.error(line))

  if (argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE)
    return 0
  }
  if (argv[0] !== 'run') {
    err(DEFAULT_USAGE)
    return 2
  }
  // Recognized flags are handled above; any other --token is a usage error, never prompt text.
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

function describe(error: unknown): string {
  // Duck-typed on `code` rather than `instanceof PandaError`: AD-1 forbids the
  // kernel from importing the contracts package, so `PandaKernelError` is a
  // DISJOINT hierarchy — an instanceof check against either one silently drops
  // the other's code, and a budget refusal is precisely the case whose code the
  // user needs. It also leaves this package importing nothing but the session.
  const code: unknown = (error as { code?: unknown } | null | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  return typeof code === 'string' && code.length > 0 ? `${code}: ${message}` : message
}
