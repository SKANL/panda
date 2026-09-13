import {
  PANDA_ERROR_CODES,
  PandaError,
  SANDBOX_ERROR_CODES,
  validateSandboxCapabilities,
  validateSandboxExecutionRequest,
  validateSandboxExecutionResult,
  validateSandboxPolicy,
  validateSandboxSnapshot,
} from '@skanl/panda-contracts'
import type {
  SandboxCapabilityFacts,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxPolicy,
  SandboxProvider,
  SandboxSession,
  SandboxSessionRequest,
  SandboxSnapshot,
  SandboxStdioSession,
} from '@skanl/panda-contracts'

export interface RemoteSessionIdentity {
  readonly id: string
  readonly providerId: string
  readonly policy: SandboxPolicy
}

export interface RemoteSessionCreateRequest {
  readonly session: RemoteSessionIdentity & { readonly snapshots: readonly SandboxSnapshot[] }
  readonly signal: undefined
}

export interface RemoteSessionExecuteRequest {
  readonly session: RemoteSessionIdentity
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly snapshots: readonly SandboxSnapshot[] | undefined
  readonly signal: AbortSignal
}

export interface RemoteSessionDestroyRequest {
  readonly session: RemoteSessionIdentity
}

export type RemoteSessionOpenStdioRequest = RemoteSessionExecuteRequest

export interface RemoteSandboxTransport {
  createSession(request: RemoteSessionCreateRequest): Promise<unknown>
  execute(request: RemoteSessionExecuteRequest): Promise<unknown>
  openStdio?(request: RemoteSessionOpenStdioRequest): Promise<unknown>
  destroy(request: RemoteSessionDestroyRequest): Promise<void>
}

export interface RemoteSandboxProviderOptions {
  readonly id: string
  readonly capabilities: SandboxCapabilityFacts
  readonly transport: RemoteSandboxTransport
  readonly timeoutMs?: number
  /** Test seam; production defaults to a UUID-backed opaque session identity. */
  readonly createSessionId?: () => string
}

function unavailable(message: string, cause?: unknown): PandaError {
  return new PandaError(PANDA_ERROR_CODES.sandboxUnavailable, message, cause === undefined ? {} : { cause })
}

function stdioError(code: (typeof SANDBOX_ERROR_CODES)[keyof typeof SANDBOX_ERROR_CODES], message: string): PandaError {
  return new PandaError(code as never, message)
}

function responseInvalid(message: string): PandaError {
  return new PandaError(PANDA_ERROR_CODES.sandboxResponseInvalid, message)
}

function samePolicy(left: SandboxPolicy, right: SandboxPolicy): boolean {
  if (left.version !== right.version || left.mode !== right.mode || left.workspaceRoot !== right.workspaceRoot || left.allowDangerous !== right.allowDangerous) return false
  const leftLimits = left.resourceLimits
  const rightLimits = right.resourceLimits
  if ((leftLimits === undefined) !== (rightLimits === undefined)) return false
  if (leftLimits !== undefined && rightLimits !== undefined) {
    if (
      leftLimits.wallTimeMs !== rightLimits.wallTimeMs ||
      leftLimits.memoryBytes !== rightLimits.memoryBytes ||
      leftLimits.outputBytes !== rightLimits.outputBytes ||
      leftLimits.fileSizeBytes !== rightLimits.fileSizeBytes ||
      leftLimits.processCount !== rightLimits.processCount
    ) return false
  }
  const leftEntries = Object.entries(left.requiredCapabilities).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right.requiredCapabilities).sort(([a], [b]) => a.localeCompare(b))
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value)
}

function ownRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw responseInvalid(`${label} must be an object`)
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw responseInvalid(`${label} has an unsupported field`)
}

function remoteIdentity(value: unknown, expected: RemoteSessionIdentity, label: string): RemoteSessionIdentity {
  const candidate = ownRecord(value, label)
  onlyKeys(candidate, ['id', 'providerId', 'policy'], label)
  if (candidate['id'] !== expected.id || candidate['providerId'] !== expected.providerId) {
    throw responseInvalid(`${label} does not match the requested session identity`)
  }
  let policy: SandboxPolicy
  try {
    policy = validateSandboxPolicy(candidate['policy'])
  } catch (error) {
    throw responseInvalid(`${label} has an invalid policy: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  if (!samePolicy(policy, expected.policy)) throw responseInvalid(`${label} does not match the requested policy`)
  return Object.freeze({ id: expected.id, providerId: expected.providerId, policy: expected.policy })
}

function remoteCreateResponse(value: unknown, expected: RemoteSessionIdentity, policy: SandboxPolicy): SandboxCapabilityFacts {
  const candidate = ownRecord(value, 'remote create-session response')
  onlyKeys(candidate, ['session', 'capabilities'], 'remote create-session response')
  remoteIdentity(candidate['session'], expected, 'remote create-session response session')
  let capabilities: SandboxCapabilityFacts
  try {
    capabilities = validateSandboxCapabilities(policy, candidate['capabilities'])
  } catch (error) {
    if (error instanceof PandaError) throw error
    throw responseInvalid('remote create-session response has invalid capability evidence')
  }
  if (capabilities.providerId !== expected.providerId || capabilities.enforcement !== 'remote') {
    throw responseInvalid('remote create-session response capability evidence does not identify the selected remote provider')
  }
  return capabilities
}

function remoteExecuteResponse(value: unknown, expected: RemoteSessionIdentity, policy: SandboxPolicy): SandboxExecutionResult {
  const candidate = ownRecord(value, 'remote execute response')
  onlyKeys(candidate, ['session', 'result'], 'remote execute response')
  remoteIdentity(candidate['session'], expected, 'remote execute response session')
  let result: SandboxExecutionResult
  try {
    result = validateSandboxExecutionResult(candidate['result'])
    validateSandboxCapabilities(policy, result.enforcement)
  } catch (error) {
    if (error instanceof PandaError) throw error
    throw responseInvalid('remote execute response has invalid enforcement evidence')
  }
  if (result.enforcement.providerId !== expected.providerId || result.enforcement.enforcement !== 'remote') {
    throw responseInvalid('remote execute response enforcement evidence does not identify the selected remote provider')
  }
  return result
}

function remoteStdioResponse(value: unknown, expected: RemoteSessionIdentity): SandboxStdioSession {
  const candidate = ownRecord(value, 'remote stdio response')
  onlyKeys(candidate, ['session', 'stdio'], 'remote stdio response')
  remoteIdentity(candidate['session'], expected, 'remote stdio response session')
  const stdio = ownRecord(candidate['stdio'], 'remote stdio response stdio')
  onlyKeys(stdio, ['sendFrame', 'receiveFrame', 'close'], 'remote stdio response stdio')
  const sendFrame = stdio['sendFrame']
  const receiveFrame = stdio['receiveFrame']
  const close = stdio['close']
  if (typeof sendFrame !== 'function' || typeof receiveFrame !== 'function' || typeof close !== 'function') {
    throw responseInvalid('remote stdio response must provide sendFrame, receiveFrame, and close methods')
  }
  return Object.freeze({
    sendFrame: async (frame: string, signal?: AbortSignal): Promise<void> => {
      if (signal?.aborted) throw stdioError(SANDBOX_ERROR_CODES.aborted, 'remote stdio send was aborted')
      if (frame.includes('\n') || frame.includes('\r')) throw new PandaError(PANDA_ERROR_CODES.sandboxRequestInvalid, 'stdio frames cannot contain line breaks')
      try {
        await (sendFrame as (frame: string, signal?: AbortSignal) => Promise<void>).call(stdio, frame, signal)
      } catch (error) {
        if (error instanceof PandaError) throw error
        throw unavailable(`remote sandbox session '${expected.id}' stdio send is unavailable`, error)
      }
    },
    receiveFrame: async (signal?: AbortSignal): Promise<string> => {
      try {
        const frame = await (receiveFrame as (signal?: AbortSignal) => Promise<unknown>).call(stdio, signal)
        if (typeof frame !== 'string') throw responseInvalid('remote stdio receive returned a non-string frame')
        return frame
      } catch (error) {
        if (error instanceof PandaError) throw error
        throw unavailable(`remote sandbox session '${expected.id}' stdio receive is unavailable`, error)
      }
    },
    close: async (): Promise<void> => {
      try {
        await (close as () => Promise<void>).call(stdio)
      } catch (error) {
        if (error instanceof PandaError) throw error
        throw unavailable(`remote sandbox session '${expected.id}' stdio close is unavailable`, error)
      }
    },
  })
}
interface RemoteExecutionWatchdog {
  readonly signal: AbortSignal
  readonly result: Promise<SandboxExecutionResult>
  dispose(): void
}

function terminalResult(enforcement: SandboxCapabilityFacts, status: 'timed-out' | 'aborted'): SandboxExecutionResult {
  const timedOut = status === 'timed-out'
  return Object.freeze({
    status,
    stdout: '',
    stderr: '',
    enforcement,
    error: {
      code: timedOut ? SANDBOX_ERROR_CODES.timedOut : SANDBOX_ERROR_CODES.aborted,
      message: timedOut ? 'remote sandbox request timed out' : 'remote sandbox request was aborted',
    },
  })
}

function executionWatchdog(signal: AbortSignal | undefined, timeoutMs: number | undefined, enforcement: SandboxCapabilityFacts): RemoteExecutionWatchdog {
  const controller = new AbortController()
  let resolveResult: (result: SandboxExecutionResult) => void
  const result = new Promise<SandboxExecutionResult>((resolve) => {
    resolveResult = resolve
  })
  let settled = false
  const complete = (status: 'timed-out' | 'aborted', reason: unknown): void => {
    if (settled) return
    settled = true
    controller.abort(reason)
    resolveResult!(terminalResult(enforcement, status))
  }
  const abort = (): void => complete('aborted', signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = timeoutMs === undefined ? undefined : setTimeout(() => complete('timed-out', new Error('remote sandbox request timed out')), timeoutMs)
  return Object.freeze({
    signal: controller.signal,
    result,
    dispose: () => {
      settled = true
      signal?.removeEventListener('abort', abort)
      if (timeout !== undefined) clearTimeout(timeout)
    },
  })
}

function unavailableResult(enforcement: SandboxCapabilityFacts, message: string): SandboxExecutionResult {
  return Object.freeze({ status: 'unavailable', stdout: '', stderr: '', enforcement, error: { code: SANDBOX_ERROR_CODES.unavailable, message } })
}

class RemoteSandboxSession implements SandboxSession {
  #disposePromise: Promise<void> | undefined
  #disposed = false
  readonly id: string
  private readonly identity: RemoteSessionIdentity
  private readonly policy: SandboxPolicy
  private readonly capabilities: SandboxCapabilityFacts
  private readonly transport: RemoteSandboxTransport
  private readonly timeoutMs: number | undefined

  constructor(
    id: string,
    identity: RemoteSessionIdentity,
    policy: SandboxPolicy,
    capabilities: SandboxCapabilityFacts,
    transport: RemoteSandboxTransport,
    timeoutMs: number | undefined,
  ) {
    this.id = id
    this.identity = identity
    this.policy = policy
    this.capabilities = capabilities
    this.transport = transport
    this.timeoutMs = timeoutMs
  }

  async execute(value: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    if (this.#disposed) return unavailableResult(this.capabilities, 'remote sandbox session is disposed')
    const request = validateSandboxExecutionRequest(value)
    if (!samePolicy(this.policy, request.policy)) {
      throw new PandaError(PANDA_ERROR_CODES.sandboxRequestInvalid, `sandbox execution policy does not match session '${this.id}' policy`)
    }
    validateSandboxCapabilities(this.policy, this.capabilities)
    const deadline = executionWatchdog(request.signal, this.timeoutMs, this.capabilities)
    const remoteRequest: RemoteSessionExecuteRequest = Object.freeze({
      session: this.identity,
      argv: Object.freeze([...request.argv]) as RemoteSessionExecuteRequest['argv'],
      cwd: request.cwd,
      environment: Object.freeze({ ...request.environment }),
      snapshots: request.snapshots === undefined ? undefined : Object.freeze(request.snapshots.map((snapshot) => Object.freeze({ ...snapshot }))),
      signal: deadline.signal,
    })
    try {
      const response = Promise.resolve()
        .then(() => this.transport.execute(remoteRequest))
        .then((value) => ({ kind: 'response' as const, value }))
      const outcome = await Promise.race([
        response,
        deadline.result.then((result) => ({ kind: 'terminal' as const, result })),
      ])
      return outcome.kind === 'terminal' ? outcome.result : remoteExecuteResponse(outcome.value, this.identity, this.policy)
    } catch (error) {
      if (error instanceof PandaError) throw error
      throw unavailable(`remote sandbox session '${this.id}' execution is unavailable`, error)
    } finally {
      deadline.dispose()
    }
  }

  async openStdio(value: SandboxExecutionRequest): Promise<SandboxStdioSession> {
    if (this.#disposed) throw unavailable(`remote sandbox session '${this.id}' is disposed`)
    const request = validateSandboxExecutionRequest(value)
    if (!samePolicy(this.policy, request.policy)) {
      throw new PandaError(PANDA_ERROR_CODES.sandboxRequestInvalid, `sandbox execution policy does not match session '${this.id}' policy`)
    }
    validateSandboxCapabilities(this.policy, this.capabilities)
    const openStdio = this.transport.openStdio
    if (typeof openStdio !== 'function') throw unavailable(`remote sandbox session '${this.id}' does not expose stdio`)
    if (request.signal?.aborted) throw stdioError(SANDBOX_ERROR_CODES.aborted, `remote sandbox session '${this.id}' stdio open was aborted before transport invocation`)
    const deadline = executionWatchdog(request.signal, this.timeoutMs, this.capabilities)
    const remoteRequest: RemoteSessionOpenStdioRequest = Object.freeze({
      session: this.identity,
      argv: Object.freeze([...request.argv]) as RemoteSessionOpenStdioRequest['argv'],
      cwd: request.cwd,
      environment: Object.freeze({ ...request.environment }),
      snapshots: request.snapshots === undefined ? undefined : Object.freeze(request.snapshots.map((snapshot) => Object.freeze({ ...snapshot }))),
      signal: deadline.signal,
    })
    try {
      const response = Promise.resolve()
        .then(() => openStdio.call(this.transport, remoteRequest))
      const racedResponse = response.then((value) => ({ kind: 'response' as const, value }))
      const outcome = await Promise.race([
        racedResponse,
        deadline.result.then((result) => ({ kind: 'terminal' as const, result })),
      ])
      if (outcome.kind === 'terminal') {
        void response.then(
          (value) => remoteStdioResponse(value, this.identity).close(),
          () => undefined,
        ).catch(() => undefined)
        const error = outcome.result.error
        if (error === undefined) throw unavailable(`remote sandbox session '${this.id}' stdio open ${outcome.result.status} without a structured error`)
        throw stdioError(error.code, error.message)
      }
      return remoteStdioResponse(outcome.value, this.identity)
    } catch (error) {
      if (error instanceof PandaError) throw error
      throw unavailable(`remote sandbox session '${this.id}' stdio could not be opened`, error)
    } finally {
      deadline.dispose()
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    const request: RemoteSessionDestroyRequest = Object.freeze({ session: this.identity })
    this.#disposePromise = Promise.resolve()
      .then(() => this.transport.destroy(request))
      .catch((error: unknown) => {
        throw unavailable(`remote sandbox session '${this.id}' teardown is unavailable`, error)
      })
    return this.#disposePromise
  }
}

export function createRemoteSandboxProvider(options: RemoteSandboxProviderOptions): SandboxProvider {
  if (typeof options.id !== 'string' || options.id.length === 0) throw new PandaError(PANDA_ERROR_CODES.sandboxResponseInvalid, 'remote sandbox provider id must be a non-empty string')
  if (options.capabilities.providerId !== options.id || options.capabilities.enforcement !== 'remote') {
    throw new PandaError(PANDA_ERROR_CODES.sandboxResponseInvalid, 'remote sandbox provider capabilities must identify the configured remote provider')
  }
  if (typeof options.transport.createSession !== 'function' || typeof options.transport.execute !== 'function' || typeof options.transport.destroy !== 'function') {
    throw new PandaError(PANDA_ERROR_CODES.sandboxUnavailable, 'remote sandbox transport is unavailable')
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new PandaError(PANDA_ERROR_CODES.sandboxRequestInvalid, 'remote sandbox timeout must be a positive finite number')
  }
  const providerId = options.id
  const capabilities = Object.freeze({ ...options.capabilities, controls: Object.freeze({ ...options.capabilities.controls }) })
  const transport = options.transport
  let sessions = 0

  return Object.freeze({
    id: providerId,
    capabilities,
    async createSession(value: SandboxSessionRequest): Promise<SandboxSession> {
      const policy = validateSandboxPolicy(value.policy)
      const snapshots = Object.freeze(value.snapshots.map((snapshot) => validateSandboxSnapshot(snapshot))) as readonly SandboxSnapshot[]
      validateSandboxCapabilities(policy, capabilities)
      const generatedId = options.createSessionId?.() ?? `${providerId}-${crypto.randomUUID()}`
      if (typeof generatedId !== 'string' || generatedId.length === 0) throw unavailable('remote sandbox session identity is unavailable')
      sessions += 1
      const id = sessions === 1 ? generatedId : `${generatedId}-${sessions}`
      const identity = Object.freeze({ id, providerId, policy })
      const remoteRequest: RemoteSessionCreateRequest = Object.freeze({ session: Object.freeze({ ...identity, snapshots }), signal: undefined })
      let remoteCapabilities: SandboxCapabilityFacts
      try {
        remoteCapabilities = remoteCreateResponse(await transport.createSession(remoteRequest), identity, policy)
      } catch (error) {
        if (error instanceof PandaError) throw error
        throw unavailable('remote sandbox session creation is unavailable', error)
      }
      return new RemoteSandboxSession(id, identity, policy, remoteCapabilities, transport, options.timeoutMs)
    },
  })
}

