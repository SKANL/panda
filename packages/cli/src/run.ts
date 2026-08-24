import { join } from 'node:path'
import { PandaError } from '@panda/contracts'
import type { ExecutorAdapter, WorkspaceHandle, WorkspaceProvider } from '@panda/contracts'
import { ClaudeCodeAdapter } from '@panda/adapter-claude'
import { LocalWorkspaceProvider } from '@panda/workspace-local'

// Exit codes (documented in the package README):
//   0 — run completed with an ok envelope
//   1 — run returned a failed or cancelled envelope
//   2 — usage error, invalid request, or environment failure

export interface RunCommandOptions {
  readonly cwd?: string
  readonly stdout?: (line: string) => void
  readonly stderr?: (line: string) => void
  /** Adapter seam; tests inject fakes, production defaults to Claude Code. */
  readonly createAdapter?: () => ExecutorAdapter
  /** Workspace provider seam; production defaults to the local-dir provider. */
  readonly createProvider?: () => WorkspaceProvider
  /**
   * Signal-registration seam: register a handler for interrupt/termination and
   * return its disposer. Tests inject a manual trigger; production wires
   * SIGINT/SIGTERM so Ctrl+C aborts the run instead of killing the CLI raw.
   */
  readonly onInterrupt?: (handler: () => void) => () => void
}

export const USAGE = [
  'usage: panda run "<prompt>"',
  '       panda --help',
  '',
  'Runs <prompt> through the Claude Code adapter inside a workspace under .panda/workspaces.',
  'Exit codes: 0 ok · 1 failed/cancelled · 2 usage/environment error.',
].join('\n')

const DEFAULT_USAGE = USAGE.split('\n')[0] ?? USAGE

async function contained(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch {
    // Cleanup must never mask the primary envelope/error or crash the exit path.
  }
}

function defaultInterruptRegistration(handler: () => void): () => void {
  process.once('SIGINT', handler)
  process.once('SIGTERM', handler)
  return () => {
    process.off('SIGINT', handler)
    process.off('SIGTERM', handler)
  }
}
void defaultInterruptRegistration

export async function runPanda(argv: readonly string[], options: RunCommandOptions = {}): Promise<number> {
  const out = options.stdout ?? ((line: string) => console.log(line))
  const err = options.stderr ?? ((line: string) => console.error(line))
  const cwd = options.cwd ?? process.cwd()

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

  const provider = options.createProvider?.() ?? new LocalWorkspaceProvider({ rootDir: join(cwd, '.panda', 'workspaces') })
  let handle: WorkspaceHandle
  try {
    handle = await provider.create()
  } catch (error) {
    await contained(() => provider.dispose())
    err(describe(error))
    return 2
  }

  const controller = new AbortController()
  const disposeSignals = options.onInterrupt ?? defaultInterruptRegistration
  const removeSignalHandler = disposeSignals(() => controller.abort())

  try {
    const adapter = options.createAdapter?.() ?? new ClaudeCodeAdapter()
    const envelope = await adapter.run({ prompt, workspace: handle, signal: controller.signal })
    out(JSON.stringify(envelope, null, 2))
    return envelope.status === 'ok' ? 0 : 1
  } catch (error) {
    err(describe(error))
    return 2
  } finally {
    removeSignalHandler()
    await contained(() => provider.release(handle))
    await contained(() => provider.dispose())
  }
}
function describe(error: unknown): string {
  return error instanceof PandaError
    ? `${error.code}: ${error.message}`
    : String(error instanceof Error ? error.message : error)
}
