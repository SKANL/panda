import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  PANDA_ERROR_CODES,
  PandaError,
  SANDBOX_ERROR_CODES,
  validateSandboxCapabilities,
  validateSandboxAuditEvent,
  validateSandboxExecutionRequest,
  validateSandboxPolicy,
  validateSandboxSnapshot,
} from '@skanl/panda-contracts'
import type {
  SandboxCapabilityFacts,
  SandboxAuditEvent,
  SandboxAuditEventKind,
  SandboxControlEvidence,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxStdioSession,
  SandboxProvider,
  SandboxSession,
  SandboxSessionRequest,
  SandboxSnapshot,
} from '@skanl/panda-contracts'

const OUTPUT_CAP_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const SENSITIVE_ENVIRONMENT = /(?:token|secret|password|credential|api[_-]?key|authorization|cookie)/i

function abortedStdio(message: string): PandaError {
  return new PandaError(SANDBOX_ERROR_CODES.aborted as never, message)
}

function unavailableStdio(message: string, cause?: unknown): PandaError {
  return new PandaError(SANDBOX_ERROR_CODES.unavailable as never, message, cause === undefined ? {} : { cause })
}

export type LocalPlatform = 'linux' | 'darwin' | 'win32'

export interface LocalSandboxProviderOptions {
  readonly platform?: NodeJS.Platform
  /** Test seam for executable probes. It never establishes full enforcement. */
  readonly inspect?: (argv: readonly [string, ...string[]]) => Promise<boolean>
  readonly timeoutMs?: number
}

export interface LocalDiscovery {
  readonly bubblewrap: boolean
  readonly landlock: boolean
  readonly cgroup: boolean
  readonly seatbelt: boolean
  readonly windowsSandboxBroker: boolean
  readonly jobObjectHelper: boolean
}

export interface LocalSandboxProvider extends SandboxProvider {
  readonly discovery: LocalDiscovery
}

export type LocalSandboxRunner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
export type LocalSandboxAuditCallback = (event: SandboxAuditEvent) => void | PromiseLike<void>

function controls(value: SandboxControlEvidence): SandboxCapabilityFacts['controls'] {
  return Object.freeze({ filesystem: value, network: 'none', process: 'none', resources: 'none' })
}

function unavailable(enforcement: SandboxCapabilityFacts, message: string): SandboxExecutionResult {
  return {
    status: 'unavailable', stdout: '', stderr: '', enforcement,
    error: { code: SANDBOX_ERROR_CODES.unavailable, message },
  }
}

function scrubEnvironment(environment: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const scrubbed = Object.fromEntries(Object.entries(environment).filter(([key]) => !SENSITIVE_ENVIRONMENT.test(key)))
  // Wrapper lookup must not use a PATH supplied by the execution caller.
  scrubbed.PATH = process.env['PATH'] ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin')
  return scrubbed
}

function hasUnsupportedResourceLimits(policy: SandboxSessionRequest['policy']): boolean {
  const limits = policy.resourceLimits
  return limits?.memoryBytes !== undefined || limits?.fileSizeBytes !== undefined || limits?.processCount !== undefined
}

export async function containedWorkspace(cwd: string, workspaceRoot: string): Promise<boolean> {
  try {
    const [physicalCwd, physicalRoot] = await Promise.all([realpath(cwd), realpath(workspaceRoot)])
    const path = relative(physicalRoot, physicalCwd)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  } catch {
    return false
  }
}

function terminate(child: ReturnType<typeof spawn>): boolean {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try { return process.kill(-child.pid, 'SIGKILL') } catch { /* fall through to direct child termination */ }
  }
  return child.kill('SIGKILL')
}

async function runExact(
  request: SandboxExecutionRequest,
  policy: SandboxSessionRequest['policy'],
  enforcement: SandboxCapabilityFacts,
  wallTimeMs: number,
  outputBytes: number,
  cleanupTimeoutMs: number,
  argv: readonly [string, ...string[]],
  runner: LocalSandboxRunner,
  isActive: () => boolean,
  register: (child: ChildProcess, cleanup: Promise<void>, abort: () => void) => void,
): Promise<SandboxExecutionResult> {
  if (request.signal?.aborted) return { status: 'aborted', stdout: '', stderr: '', enforcement, error: { code: SANDBOX_ERROR_CODES.aborted, message: 'sandbox process was aborted before spawn' } }
  if (!(await containedWorkspace(request.cwd, policy.workspaceRoot))) return unavailable(enforcement, 'sandbox cwd cannot be physically proven inside workspace')
  if (!isActive()) return { status: 'aborted', stdout: '', stderr: '', enforcement, error: { code: SANDBOX_ERROR_CODES.aborted, message: 'sandbox session was disposed before spawn' } }
  return new Promise((resolveResult) => {
    const [command, ...args] = argv
    const child = runner(command!, args, {
      cwd: request.cwd,
      env: scrubEnvironment(request.environment),
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let status: 'failed' | 'timed-out' | 'aborted' | undefined
    let disposalTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = new Promise<void>((resolveCleanup, rejectCleanup) => {
      child.once('close', () => resolveCleanup())
      child.once('error', rejectCleanup)
    })
    const abortForDisposal = (): void => {
      status = 'aborted'
      try {
        if (terminate(child)) {
          if (!settled) disposalTimer = setTimeout(() => finish({ status: 'aborted', stdout, stderr, enforcement, error: { code: SANDBOX_ERROR_CODES.aborted, message: 'sandbox process cleanup timed out during disposal' } }), cleanupTimeoutMs)
          return
        }
      } catch (error) {
        finish({ status, stdout, stderr, enforcement, error: { code: SANDBOX_ERROR_CODES.aborted, message: 'sandbox process could not be terminated during disposal' } })
        throw error
      }
      finish({ status, stdout, stderr, enforcement, error: { code: SANDBOX_ERROR_CODES.aborted, message: 'sandbox process could not be terminated during disposal' } })
      throw new Error('child termination was not accepted')
    }
    register(child, cleanup, abortForDisposal)
    const finish = (result: SandboxExecutionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (disposalTimer !== undefined) clearTimeout(disposalTimer)
      request.signal?.removeEventListener('abort', abort)
      resolveResult(result)
    }
    const truncate = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
      const next = target === 'stdout' ? stdout + chunk.toString('utf8') : stderr + chunk.toString('utf8')
      if (Buffer.byteLength(next) > outputBytes) {
        status = 'failed'
        terminate(child)
        return
      }
      if (target === 'stdout') stdout = next
      else stderr = next
    }
    const abort = (): void => { status = 'aborted'; terminate(child) }
    const timer = setTimeout(() => { status = 'timed-out'; terminate(child) }, wallTimeMs)
    request.signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => truncate(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => truncate(chunk, 'stderr'))
    child.on('error', (error) => finish({ status: 'failed', stdout, stderr, enforcement, error: { code: SANDBOX_ERROR_CODES.runnerFailed, message: error.message } }))
    child.on('close', (exitCode) => {
      if (status === 'timed-out') return finish({ status, stdout, stderr, enforcement, error: { code: SANDBOX_ERROR_CODES.timedOut, message: 'sandbox process exceeded its timeout' } })
      if (status === 'aborted') return finish({ status, stdout, stderr, enforcement, error: { code: SANDBOX_ERROR_CODES.aborted, message: 'sandbox process was aborted' } })
      if (status === 'failed') return finish({ status, stdout, stderr, enforcement, error: { code: SANDBOX_ERROR_CODES.runnerFailed, message: 'sandbox process exceeded its output cap' } })
      if (exitCode === 0) return finish({ status: 'ok', stdout, stderr, exitCode, enforcement })
      return finish({ status: 'failed', stdout, stderr, enforcement, error: { code: SANDBOX_ERROR_CODES.runnerFailed, message: `sandbox process exited with code ${exitCode ?? 'unknown'}` } })
    })
  })
}

class Session implements SandboxSession {
  #disposed = false
  #invalidated = false
  #teardownFailure: unknown
  #disposePromise: Promise<void> | undefined
  readonly id: string
  private readonly policy: SandboxSessionRequest['policy']
  private readonly enforcement: SandboxCapabilityFacts
  private readonly timeoutMs: number
  private readonly buildArgv: ((request: SandboxExecutionRequest) => readonly [string, ...string[]]) | undefined
  private readonly runner: LocalSandboxRunner
  readonly snapshots: readonly SandboxSnapshot[]
  private readonly active = new Map<ChildProcess, () => void>()
  private readonly cleanups = new Map<ChildProcess, Promise<void>>()
  private readonly snapshotContent = new Map<string, Buffer>()

  constructor(
    id: string,
    policy: SandboxSessionRequest['policy'],
    enforcement: SandboxCapabilityFacts,
    timeoutMs: number,
    buildArgv: ((request: SandboxExecutionRequest) => readonly [string, ...string[]]) | undefined,
    runner: LocalSandboxRunner,
    audit: LocalSandboxAuditCallback | undefined,
    snapshots: readonly SandboxSnapshot[] = [],
  ) {
    this.id = id
    this.policy = policy
    this.enforcement = enforcement
    this.timeoutMs = timeoutMs
    this.buildArgv = buildArgv
    this.runner = runner
    this.audit = audit
    this.snapshots = Object.freeze(snapshots.map((snapshot) => Object.freeze({ ...snapshot })))
  }

  private readonly audit: LocalSandboxAuditCallback | undefined

  private emitAudit(kind: SandboxAuditEventKind): void {
    if (this.policy.mode !== 'danger-full-access' || this.audit === undefined) return
    try {
      const event = validateSandboxAuditEvent({
        providerId: this.enforcement.providerId,
        sessionId: this.id,
        mode: 'danger-full-access',
        timestamp: new Date().toISOString(),
        kind,
      })
      void Promise.resolve(this.audit(event)).catch(() => undefined)
    } catch {
      // Audit delivery is best effort and must not affect sandbox behavior.
    }
  }

  async execute(value: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    if (this.#disposed || this.#invalidated) return unavailable(this.enforcement, 'sandbox session is unavailable')
    const request = validateSandboxExecutionRequest(value)
    if (!samePolicy(this.policy, request.policy)) {
      throw new PandaError(PANDA_ERROR_CODES.sandboxRequestInvalid, `sandbox execution policy does not match session '${this.id}' policy`)
    }
    validateSandboxCapabilities(this.policy, this.enforcement)
    if (this.buildArgv === undefined && this.policy.mode !== 'danger-full-access') return unavailable(this.enforcement, 'safe sandbox mode has no verified execution backend')
    if (hasUnsupportedResourceLimits(this.policy)) return unavailable(this.enforcement, 'sandbox provider cannot prove all requested resource limits')
    this.emitAudit('execution-started')
    try {
      const limits = this.policy.resourceLimits
      return await runExact(
        request,
        this.policy,
        this.enforcement,
        limits?.wallTimeMs ?? this.timeoutMs,
        limits?.outputBytes ?? OUTPUT_CAP_BYTES,
        this.timeoutMs,
        this.buildArgv?.(request) ?? request.argv,
        this.runner,
        () => !this.#disposed && !this.#invalidated,
        (child, cleanup, abort) => this.registerChild(child, cleanup, abort),
      )
    } finally {
      this.emitAudit('execution-completed')
    }
  }

  async openStdio(value: SandboxExecutionRequest): Promise<SandboxStdioSession> {
    if (this.#disposed || this.#invalidated) throw new PandaError(PANDA_ERROR_CODES.sandboxUnavailable, 'sandbox session is unavailable')
    const request = validateSandboxExecutionRequest(value)
    if (!samePolicy(this.policy, request.policy)) throw new PandaError(PANDA_ERROR_CODES.sandboxRequestInvalid, `sandbox execution policy does not match session '${this.id}' policy`)
    validateSandboxCapabilities(this.policy, this.enforcement)
    if (request.signal?.aborted) throw new PandaError(SANDBOX_ERROR_CODES.aborted as never, 'stdio sandbox process was aborted before spawn')
    if (this.buildArgv === undefined && this.policy.mode !== 'danger-full-access') throw new PandaError(SANDBOX_ERROR_CODES.unavailable, 'safe sandbox mode has no verified execution backend')
    if (hasUnsupportedResourceLimits(this.policy)) throw new PandaError(SANDBOX_ERROR_CODES.unavailable, 'sandbox provider cannot prove all requested resource limits')
    if (!(await containedWorkspace(request.cwd, this.policy.workspaceRoot))) throw new PandaError(SANDBOX_ERROR_CODES.unavailable, 'sandbox cwd cannot be physically proven inside workspace')
    if (request.signal?.aborted) throw abortedStdio('stdio process was aborted before spawn')
    if (!(await containedWorkspace(request.cwd, this.policy.workspaceRoot))) throw unavailableStdio('sandbox cwd cannot be physically proven inside workspace')
    this.emitAudit('execution-started')
    try {
      const [command, ...args] = this.buildArgv?.(request) ?? request.argv
      const child = this.runner(command!, args, { cwd: request.cwd, env: scrubEnvironment(request.environment), shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let buffer = ''
      const frames: string[] = []
      type FrameWaiter = { readonly resolve: (frame: string) => void; readonly reject: (error: unknown) => void; readonly abort: () => void; readonly signal?: AbortSignal }
      const waiters: FrameWaiter[] = []
      const sendWaiters = new Set<(error: PandaError) => void>()
      let processClosed = false
      let terminalError: PandaError | undefined
      let outputBytes = 0
      const timeout = setTimeout(() => stop(new PandaError(SANDBOX_ERROR_CODES.timedOut as never, 'stdio process exceeded its timeout')), this.policy.resourceLimits?.wallTimeMs ?? this.timeoutMs)
      const rejectWaiters = (error: PandaError): void => {
        terminalError ??= error
        while (waiters.length > 0) {
          const waiter = waiters.shift()!
          waiter.signal?.removeEventListener('abort', waiter.abort)
          waiter.reject(error)
        }
        for (const reject of sendWaiters) reject(error)
        sendWaiters.clear()
      }
      const stop = (error: PandaError): void => {
        rejectWaiters(error)
        if (!processClosed && !child.killed && !terminate(child)) {
          this.invalidate(new Error('child termination was not accepted'))
        }
      }
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > Math.min(this.policy.resourceLimits?.outputBytes ?? OUTPUT_CAP_BYTES, OUTPUT_CAP_BYTES)) {
          stop(new PandaError(SANDBOX_ERROR_CODES.runnerFailed as never, 'stdio process exceeded its output cap'))
          return
        }
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const frame = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const waiter = waiters.shift()
          if (waiter) {
            waiter.signal?.removeEventListener('abort', waiter.abort)
            waiter.resolve(frame)
          } else {
            frames.push(frame)
          }
          newline = buffer.indexOf('\n')
        }
      })
      // Always consume stderr so a noisy child cannot block on a full pipe.
      child.stderr?.on('data', (chunk: Buffer | string) => {
        outputBytes += Buffer.byteLength(chunk.toString())
        if (outputBytes > Math.min(this.policy.resourceLimits?.outputBytes ?? OUTPUT_CAP_BYTES, OUTPUT_CAP_BYTES)) {
          stop(new PandaError(SANDBOX_ERROR_CODES.runnerFailed as never, 'stdio process exceeded its output cap'))
        }
      })
      const cleanup = new Promise<void>((resolveCleanup, rejectCleanup) => {
        child.once('close', () => {
          clearTimeout(timeout)
          processClosed = true
          rejectWaiters(terminalError ?? unavailableStdio('stdio process closed before a frame was received'))
          resolveCleanup()
        })
        child.once('error', (error) => {
          clearTimeout(timeout)
          processClosed = true
          rejectWaiters(terminalError ?? unavailableStdio('stdio process failed before a frame was received'))
          rejectCleanup(error)
        })
      })
      const abort = (): void => {
        if (!processClosed && !child.killed && !terminate(child)) throw new Error('child termination was not accepted')
      }
      this.registerChild(child, cleanup, abort)
      let closePromise: Promise<void> | undefined
      const close = (): Promise<void> => {
        if (closePromise !== undefined) return closePromise
        closePromise = (async () => {
          let terminationError: unknown
          try {
            abort()
          } catch (error) {
            terminationError = error
            this.invalidate(error)
          }
          try {
            await this.boundedCleanup(cleanup)
          } catch (error) {
            throw unavailableStdio('stdio process cleanup failed', error)
          }
          if (terminationError !== undefined) throw unavailableStdio('stdio process could not be terminated', terminationError)
        })()
        return closePromise
      }
      return Object.freeze({
        sendFrame: async (frame: string, signal?: AbortSignal): Promise<void> => {
          if (signal?.aborted) throw abortedStdio('stdio send was aborted')
          if (frame.includes('\n') || frame.includes('\r')) throw new PandaError(PANDA_ERROR_CODES.sandboxRequestInvalid, 'stdio frames cannot contain line breaks')
          const stdin = child.stdin
          if (terminalError !== undefined) throw terminalError
          if (stdin === null || processClosed || stdin.destroyed || stdin.writableEnded) throw unavailableStdio('stdio process input is unavailable')
          await new Promise<void>((resolveSend, rejectSend) => {
            let settled = false
            const finish = (error?: unknown): void => {
              if (settled) return
              settled = true
              sendWaiters.delete(onClose)
              signal?.removeEventListener('abort', onAbort)
              stdin.removeListener('drain', onDrain)
              if (error === undefined) resolveSend()
              else rejectSend(error)
            }
            const onAbort = (): void => finish(abortedStdio('stdio send was aborted'))
            const onDrain = (): void => finish()
            const onClose = (error: PandaError): void => finish(error)
            sendWaiters.add(onClose)
            signal?.addEventListener('abort', onAbort, { once: true })
            try {
              if (signal?.aborted) return onAbort()
              if (stdin.write(`${frame}\n`)) finish()
              else stdin.once('drain', onDrain)
            } catch (error) {
              finish(error)
            }
          })
        },
        receiveFrame: async (signal?: AbortSignal): Promise<string> => {
          if (signal?.aborted) throw abortedStdio('stdio receive was aborted')
          if (frames.length > 0) return frames.shift()!
          if (processClosed) throw unavailableStdio('stdio process output is unavailable')
          if (terminalError !== undefined) throw terminalError
          return new Promise<string>((resolveFrame, rejectFrame) => {
            const waiter = {
              resolve: resolveFrame,
              reject: rejectFrame,
              abort: (): void => {
                const index = waiters.indexOf(waiter)
                if (index >= 0) waiters.splice(index, 1)
                signal?.removeEventListener('abort', waiter.abort)
                rejectFrame(abortedStdio('stdio receive was aborted'))
              },
              signal,
            }
            signal?.addEventListener('abort', waiter.abort, { once: true })
            if (signal?.aborted) waiter.abort()
            else waiters.push(waiter)
          })
        },
        close,
      })
    } finally {
      this.emitAudit('execution-completed')
    }
  }

  async snapshot(paths: readonly string[]): Promise<readonly SandboxSnapshot[]> {
    if (this.#disposed || this.#invalidated) throw new PandaError(PANDA_ERROR_CODES.sandboxUnavailable, 'sandbox session is unavailable')
    const snapshots: SandboxSnapshot[] = []
    for (const path of paths) {
      const absolute = resolve(this.policy.workspaceRoot, path)
      if (!(await containedWorkspace(absolute, this.policy.workspaceRoot))) {
        throw new PandaError(SANDBOX_ERROR_CODES.unavailable as never, 'snapshot path is outside the workspace')
      }
      const info = await lstat(absolute)
      const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
      if (kind === undefined || info.isSymbolicLink()) throw new PandaError(SANDBOX_ERROR_CODES.unavailable as never, 'snapshot path is not a regular file or directory')
      const digest = kind === 'file'
        ? createHash('sha256').update(await readFile(absolute)).digest('hex')
        : createHash('sha256').update(`${kind}:${info.size}:${info.mtimeMs}`).digest('hex')
      snapshots.push(validateSandboxSnapshot({ version: 1, path, kind, digest }))
      if (kind === 'file') this.snapshotContent.set(digest, await readFile(absolute))
    }
    return Object.freeze(snapshots)
  }

  async restore(snapshots: readonly SandboxSnapshot[]): Promise<void> {
    if (this.#disposed || this.#invalidated) throw new PandaError(PANDA_ERROR_CODES.sandboxUnavailable, 'sandbox session is unavailable')
    for (const snapshot of snapshots.map((entry) => validateSandboxSnapshot(entry))) {
      if (snapshot.kind !== 'file') throw new PandaError(SANDBOX_ERROR_CODES.unavailable as never, 'directory snapshot restore is unavailable')
      const content = this.snapshotContent.get(snapshot.digest)
      if (content === undefined) throw new PandaError(SANDBOX_ERROR_CODES.unavailable as never, 'snapshot content is not owned by this session')
      const absolute = resolve(this.policy.workspaceRoot, snapshot.path)
      if (!(await containedWorkspace(absolute, this.policy.workspaceRoot))) throw new PandaError(SANDBOX_ERROR_CODES.unavailable as never, 'snapshot restore path is outside the workspace')
      await writeFile(absolute, content, { flag: 'w' })
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    const cleanups = [...this.active.entries()].map(([child, abort]) => {
      try {
        abort()
      } catch (error) {
        this.invalidate(error)
      }
      const cleanup = this.cleanups.get(child)
      return cleanup === undefined ? Promise.resolve() : this.boundedCleanup(cleanup)
    })
    this.#disposePromise = Promise.allSettled(cleanups).then((outcomes) => {
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') this.invalidate(outcome.reason)
      }
      if (this.#teardownFailure !== undefined) {
        throw new PandaError(PANDA_ERROR_CODES.sandboxUnavailable, `sandbox session '${this.id}' teardown outcome is uncertain`, { cause: this.#teardownFailure })
      }
    })
    return this.#disposePromise
  }

  private boundedCleanup(cleanup: Promise<void>): Promise<void> {
    return new Promise((resolveCleanup, rejectCleanup) => {
      const timer = setTimeout(() => rejectCleanup(new Error(`sandbox session '${this.id}' child cleanup timed out`)), this.timeoutMs)
      void cleanup.then(
        () => { clearTimeout(timer); resolveCleanup() },
        (error: unknown) => { clearTimeout(timer); rejectCleanup(error) },
      )
    })
  }

  private invalidate(error: unknown): void {
    this.#invalidated = true
    this.#teardownFailure ??= error ?? new Error('unknown child cleanup failure')
  }

  private registerChild(child: ChildProcess, cleanup: Promise<void>, abort: () => void): void {
    this.active.set(child, abort)
    this.cleanups.set(child, cleanup)
    void cleanup.then(
      () => this.removeChild(child),
      (error: unknown) => {
        this.invalidate(error)
        this.removeChild(child)
      },
    )
    if (this.#disposed) terminate(child)
  }

  private removeChild(child: ChildProcess): void {
    this.active.delete(child)
    this.cleanups.delete(child)
  }
}

function samePolicy(left: SandboxSessionRequest['policy'], right: SandboxSessionRequest['policy']): boolean {
  if (
    left.version !== right.version ||
    left.mode !== right.mode ||
    left.workspaceRoot !== right.workspaceRoot ||
    left.allowDangerous !== right.allowDangerous
  ) {
    return false
  }
  const leftEntries = Object.entries(left.requiredCapabilities).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right.requiredCapabilities).sort(([a], [b]) => a.localeCompare(b))
  if (!(leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value))) return false
  const leftLimits = Object.entries(left.resourceLimits ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const rightLimits = Object.entries(right.resourceLimits ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return leftLimits.length === rightLimits.length && leftLimits.every(([key, value], index) => rightLimits[index]?.[0] === key && rightLimits[index]?.[1] === value)
}

export function createProvider(
  id: string,
  discovery: LocalDiscovery,
  filesystem: SandboxControlEvidence,
  timeoutMs: number,
  buildArgv?: (request: SandboxExecutionRequest) => readonly [string, ...string[]],
  runner: LocalSandboxRunner = (command, args, options) => spawn(command, [...args], options),
  audit?: LocalSandboxAuditCallback,
  controlEvidence: Partial<SandboxCapabilityFacts['controls']> = {},
): LocalSandboxProvider {
  const capabilities: SandboxCapabilityFacts = Object.freeze({
    version: 1,
    providerId: id,
    enforcement: filesystem === 'none' ? 'partial' : 'os',
    controls: Object.freeze({ ...controls(filesystem), ...controlEvidence }),
  })
  let sessions = 0
  return Object.freeze({
    id,
    discovery: Object.freeze(discovery),
    capabilities,
    async createSession(value: SandboxSessionRequest): Promise<SandboxSession> {
      const policy = validateSandboxPolicy(value.policy)
      value.snapshots.forEach(validateSandboxSnapshot)
      validateSandboxCapabilities(policy, capabilities)
      sessions += 1
      return new Session(`${id}-${sessions}`, policy, capabilities, timeoutMs, buildArgv, runner, audit, value.snapshots)
    },
  })
}

export async function probe(options: LocalSandboxProviderOptions, argv: readonly [string, ...string[]]): Promise<boolean> {
  if (options.inspect !== undefined) return options.inspect(argv)
  const executable = argv[0]
  return executable !== undefined && (existsSync(executable) || process.env['PATH']?.split(delimiter).some((entry) => existsSync(resolve(entry, executable))) === true)
}

export { DEFAULT_TIMEOUT_MS }
