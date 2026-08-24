import { execFile, spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'node:child_process'
import type { ChildProcessSpawner, SpawnedChild, SpawnOutcome } from './spawn-seam.ts'

// stdout/stderr capture cap per stream; beyond it we truncate and flag, so a
// chatty executor can never grow the parent's memory without bound.
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

// win32 cannot exec .cmd/.bat shims directly (Node refuses them since the
// shell-injection hardening, raising EINVAL); route those through cmd.exe
// explicitly. The tracked pid is whatever we spawned (cmd.exe on a reroute),
// so taskkill tree semantics are unchanged.
function requiresCmdShim(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
}

interface AttachedChild {
  readonly source: ChildProcess
  writeStdin(chunk: string): void
  endStdin(): void
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
            if (bytes + chunk.length > STREAM_CAPTURE_CAP_BYTES) {
              const remaining = STREAM_CAPTURE_CAP_BYTES - bytes
              if (remaining > 0) targetChunks.push(chunk.subarray(0, remaining))
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

      let attached: AttachedChild | undefined
      let routedThroughCmd = requiresCmdShim(command)
      const cmdArgs = (): readonly string[] => ['/d', '/s', '/c', command, ...args]

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
        attached = {
          source,
          writeStdin(chunk) {
            if (settled || streamErrorMessage !== undefined) return
            try {
              source.stdin?.write(chunk)
            } catch (error) {
              streamErrorMessage = error instanceof Error ? error.message : String(error)
            }
          },
          endStdin() {
            if (settled || streamErrorMessage !== undefined) return
            try {
              source.stdin?.end()
            } catch (error) {
              streamErrorMessage = error instanceof Error ? error.message : String(error)
            }
          },
        }
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
          return attached?.source.pid
        },
        writeStdin(chunk) {
          attached?.writeStdin(chunk)
        },
        endStdin() {
          attached?.endStdin()
        },
        killTree() {
          if (attached !== undefined) killTreeOf(attached.source)
        },
        done,
      }
    },
  }
}

function failedChild(done: Promise<SpawnOutcome>): SpawnedChild {
  return {
    pid: undefined,
    writeStdin() {},
    endStdin() {},
    killTree() {},
    done,
  }
}
