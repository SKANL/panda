import { execFile, spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'node:child_process'
import type { ChildProcessSpawner, SpawnedChild, SpawnOutcome } from './spawn-seam.ts'

// stdout/stderr capture cap per stream; beyond it we truncate and flag, so a
// chatty executor can never grow the parent's memory without bound. JSONL
// executors emit an event per token, so this cap is reached in practice, not
// only in theory — the truncation flag is what stops a chopped stream from
// being read as a complete answer.
const STREAM_CAPTURE_CAP_BYTES = 1024 * 1024

// Real spawner backed by node:child_process.
//
// Tree-kill semantics per platform:
// - win32: `taskkill /pid <pid> /T /F` walks and force-terminates the whole tree;
//   Node signals cannot reach grandchildren on Windows, so taskkill is the only
//   reliable option for spawned .exe/.cmd trees. If taskkill itself fails, the
//   child gets a direct kill fallback so `done` always settles.
// - posix: the child is spawned detached into its own process group; killing
//   -pid takes down every descendant in one signal.
function killTreeOf(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (error) => {
      if (error) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already exited.
        }
      }
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group may already be gone; fall through to the direct kill below.
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Already exited.
  }
}

/**
 * True when this command can only be started by rerouting through `cmd.exe`.
 *
 * win32 cannot exec .cmd/.bat shims directly (Node refuses them since the
 * shell-injection hardening, raising EINVAL), so the spawner reroutes them.
 * That reroute hands the argv to a SHELL, which interprets `&`, `|`, `>`, `^`,
 * `%VAR%` and newlines — Node's CRT-style quoting does not neutralise any of
 * them. Callers that would put untrusted text in argv must consult this and
 * refuse rather than let the shell see it.
 */
export function routesThroughCmdShim(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
}

export function createNodeChildSpawner(): ChildProcessSpawner {
  return {
    spawn(command, args, options) {
      const nodeOptions: NodeSpawnOptions = {
        cwd: options.cwd,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      }

      // Resolving twice is a no-op: whichever settle path lands first wins.
      let resolveDone!: (outcome: SpawnOutcome) => void
      const done = new Promise<SpawnOutcome>((resolve) => {
        resolveDone = resolve
      })
      let settled = false
      const settle = (outcome: SpawnOutcome) => {
        if (settled) return
        settled = true
        resolveDone(outcome)
      }

      let stdoutTruncated = false
      let stderrTruncated = false
      function createCapture(markTruncated: () => void) {
        const targetChunks: Buffer[] = []
        let bytes = 0
        return {
          push(chunk: Buffer): void {
            // Once at the cap nothing more is retained — and discarding is
            // itself truncation, including when an earlier chunk filled the cap
            // exactly. Failing to advance `bytes` here would let every later
            // chunk append another cap-sized slice, i.e. no cap at all.
            if (bytes >= STREAM_CAPTURE_CAP_BYTES) {
              markTruncated()
              return
            }
            const remaining = STREAM_CAPTURE_CAP_BYTES - bytes
            if (chunk.length > remaining) {
              targetChunks.push(chunk.subarray(0, remaining))
              bytes = STREAM_CAPTURE_CAP_BYTES
              markTruncated()
              return
            }
            bytes += chunk.length
            targetChunks.push(chunk)
          },
          text(): string {
            return Buffer.concat(targetChunks).toString('utf8')
          },
        }
      }
      const stdout = createCapture(() => {
        stdoutTruncated = true
      })
      const stderr = createCapture(() => {
        stderrTruncated = true
      })

      // No-op error listeners keep async pipe failures (EPIPE etc.) from crashing
      // the parent as unhandled 'error' events; stdin breakage is recorded so the
      // adapter can classify the run as failed instead of trusting the outcome.
      let streamErrorMessage: string | undefined

      // Everything written to stdin is BUFFERED, because the cmd.exe reroute
      // below arrives asynchronously — by then the caller has usually already
      // written the prompt and closed stdin on the first child. Without replay
      // the rerouted child waits on stdin forever and the run hangs.
      const stdinChunks: string[] = []
      let stdinEnded = false
      let flushedChunks = 0
      let flushedEnd = false
      let currentSource: ChildProcess | undefined
      let routedThroughCmd = routesThroughCmdShim(command)
      const cmdArgs = (): readonly string[] => ['/d', '/s', '/c', command, ...args]

      function flushStdin(): void {
        const source = currentSource
        if (source === undefined || settled || streamErrorMessage !== undefined) return
        try {
          while (flushedChunks < stdinChunks.length) {
            source.stdin?.write(stdinChunks[flushedChunks]!)
            flushedChunks++
          }
          if (stdinEnded && !flushedEnd) {
            source.stdin?.end()
            flushedEnd = true
          }
        } catch (error) {
          streamErrorMessage = error instanceof Error ? error.message : String(error)
        }
      }

      const settleFatal = (message: string) => {
        settle({ exitCode: null, stdout: '', stderr: '', spawnErrorMessage: message })
      }

      function attach(source: ChildProcess): void {
        source.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
        source.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
        source.stdin?.on('error', (error) => {
          streamErrorMessage ??= error instanceof Error ? error.message : String(error)
        })
        source.stdout?.on('error', () => {})
        source.stderr?.on('error', () => {})
        source.on('error', (error) => {
          // Node raises EINVAL asynchronously for shell-restricted commands;
          // reroute once through cmd.exe while keeping tree-kill semantics.
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'EINVAL' && process.platform === 'win32' && !routedThroughCmd) {
            routedThroughCmd = true
            launch('cmd.exe', cmdArgs())
            return
          }
          // Spawn failures (ENOENT etc.) may never be followed by 'close', so the
          // error settles the child on its own.
          settle({
            exitCode: null,
            stdout: '',
            stderr: '',
            spawnErrorMessage: error instanceof Error ? error.message : String(error),
          })
        })
        source.on('close', (exitCode) => {
          settle({
            exitCode,
            stdout: stdout.text(),
            stderr: stderr.text(),
            ...(streamErrorMessage !== undefined ? { streamErrorMessage } : {}),
            ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
            ...(stderrTruncated ? { stderrTruncated: true } : {}),
          })
        })
        // A rerouted child has received nothing yet: replay from the start.
        currentSource = source
        flushedChunks = 0
        flushedEnd = false
        flushStdin()
      }

      function launch(executable: string, launchArgs: readonly string[]): boolean {
        try {
          attach(spawn(executable, [...launchArgs], nodeOptions))
          return true
        } catch (error) {
          settleFatal(error instanceof Error ? error.message : String(error))
          return false
        }
      }

      if (routedThroughCmd) launch('cmd.exe', cmdArgs())
      else if (!launch(command, args)) return failedChild(done)

      return {
        get pid() {
          return currentSource?.pid
        },
        get settled() {
          return settled
        },
        writeStdin(chunk) {
          if (stdinEnded) return
          stdinChunks.push(chunk)
          flushStdin()
        },
        endStdin() {
          stdinEnded = true
          flushStdin()
        },
        killTree() {
          // Signalling after the child settled could hit a RECYCLED pid, which
          // on win32 means taskkill /T /F on somebody else's process tree.
          if (settled || currentSource === undefined) return
          killTreeOf(currentSource)
        },
        done,
      }
    },
  }
}

function failedChild(done: Promise<SpawnOutcome>): SpawnedChild {
  return {
    pid: undefined,
    settled: true,
    writeStdin() {},
    endStdin() {},
    killTree() {},
    done,
  }
}
