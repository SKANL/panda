import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PandaError, PANDA_ERROR_CODES } from '@skanl/panda-contracts'

const run = promisify(execFile)

/**
 * Every git invocation this package makes.
 *
 * `execFile` with an argument ARRAY, never a shell string: a worktree path is
 * user-supplied data and a shell would give a path containing a space, a quote
 * or a `;` a second meaning. There is no shell here, so there is nothing to
 * quote.
 *
 * `GIT_TERMINAL_PROMPT=0` is not cosmetic. Without it a repository whose remote
 * wants credentials makes git block on a prompt nobody is there to answer, and
 * `create()` hangs forever instead of failing. Panda reports; it does not wait.
 */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
      // A worktree listing on a large repository is the biggest thing read here;
      // the default 1 MiB has no headroom worth betting on.
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    throw gitFailure(args, error)
  }
}

/**
 * A git failure is a workspace that is UNAVAILABLE, never a workspace that is
 * unknown: the caller asked for something reasonable and the environment could
 * not deliver it. Confusing the two sends a user looking for a missing worktree
 * when what is missing is git itself.
 *
 * The stderr git wrote is carried verbatim into the message, because the useful
 * half of a git failure is always git's own sentence ("not a git repository",
 * "already exists", "is already checked out"), not our summary of it.
 */
function gitFailure(args: readonly string[], error: unknown): PandaError {
  const detail = error as NodeJS.ErrnoException & { stderr?: string | Buffer }
  const stderr = typeof detail?.stderr === 'string' ? detail.stderr : detail?.stderr?.toString('utf8')
  const reason =
    detail?.code === 'ENOENT'
      ? 'git was not found on PATH'
      : (stderr ?? '').trim() || (error instanceof Error ? error.message : String(error))
  return new PandaError(
    PANDA_ERROR_CODES.contractWorkspaceUnavailable,
    `git ${args.join(' ')} failed: ${reason}`,
    { cause: error },
  )
}
