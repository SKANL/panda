import {
  PANDA_ERROR_CODES,
  PandaError,
  validateSandboxCapabilities,
  validateSandboxExecutionRequest,
  validateSandboxExecutionResult,
  validateSandboxPolicy,
  validateSandboxSnapshot,
} from '@skanl/panda-contracts'
import type {
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxPolicy,
  SandboxProvider,
  SandboxSession,
  SandboxSessionRequest,
  SandboxSnapshot,
  SandboxStdioSession,
} from '@skanl/panda-contracts'

export interface ResolvedSandboxSession {
  readonly id: string
  readonly providerId: string
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>
  openStdio?(request: SandboxExecutionRequest): Promise<SandboxStdioSession>
  snapshot?(paths: readonly string[]): Promise<readonly SandboxSnapshot[]>
  restore?(snapshots: readonly SandboxSnapshot[]): Promise<void>
  dispose(): Promise<void>
}

export interface SandboxProviderResolver {
  select(policy: SandboxPolicy): SandboxProvider
  createSession(request: SandboxSessionRequest): Promise<ResolvedSandboxSession>
}

type SessionState = 'active' | 'disposing' | 'disposed' | 'uncertain'

interface SelectedSandboxProvider {
  readonly provider: SandboxProvider
  readonly providerId: string
  readonly capabilities: ReturnType<typeof validateSandboxCapabilities>
  createSession(request: SandboxSessionRequest): Promise<SandboxSession>
}

function unavailable(message: string, cause?: unknown): PandaError {
  return new PandaError(PANDA_ERROR_CODES.sandboxUnavailable, message, cause === undefined ? {} : { cause })
}

function requestInvalid(message: string): PandaError {
  return new PandaError(PANDA_ERROR_CODES.sandboxRequestInvalid, message)
}

function validatedSessionRequest(request: SandboxSessionRequest): SandboxSessionRequest {
  const policy = validateSandboxPolicy(request.policy)
  if (!Array.isArray(request.snapshots)) throw requestInvalid('sandbox session snapshots must be an array')
  const snapshots = Object.freeze(request.snapshots.map((snapshot) => validateSandboxSnapshot(snapshot))) as readonly SandboxSnapshot[]
  return Object.freeze({ policy, snapshots })
}

function snapshotCapabilities(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const candidate = value as Record<string, unknown>
  const controls = candidate['controls']
  return Object.freeze({
    version: candidate['version'],
    providerId: candidate['providerId'],
    enforcement: candidate['enforcement'],
    controls:
      typeof controls !== 'object' || controls === null
        ? controls
        : Object.freeze({
            filesystem: (controls as Record<string, unknown>)['filesystem'],
            network: (controls as Record<string, unknown>)['network'],
            process: (controls as Record<string, unknown>)['process'],
            resources: (controls as Record<string, unknown>)['resources'],
          }),
  })
}

function snapshotExecutionResult(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const candidate = value as Record<string, unknown>
  const error = candidate['error']
  const normalizedError =
    typeof error !== 'object' || error === null
      ? error
      : Object.freeze({ code: (error as Record<string, unknown>)['code'], message: (error as Record<string, unknown>)['message'] })
  return Object.freeze({
    status: candidate['status'],
    stdout: candidate['stdout'],
    stderr: candidate['stderr'],
    enforcement: snapshotCapabilities(candidate['enforcement']),
    exitCode: candidate['exitCode'],
    ...(normalizedError === undefined ? {} : { error: normalizedError }),
  })
}

function selectProvider(providers: readonly SandboxProvider[], policy: SandboxPolicy): SelectedSandboxProvider {
  let firstCapabilityFailure: PandaError | undefined
  for (const provider of providers) {
    try {
      // Provider-owned getters run once, at this boundary. Everything past this
      // point uses frozen values panda owns rather than mutable provider state.
      const providerId = provider.id
      const capabilities = validateSandboxCapabilities(policy, snapshotCapabilities(provider.capabilities))
      const createSession = provider.createSession
      if (typeof createSession !== 'function') continue
      if (providerId !== capabilities.providerId) continue
      return Object.freeze({ provider, providerId, capabilities, createSession: createSession.bind(provider) })
    } catch (error) {
      if (error instanceof PandaError && error.code === PANDA_ERROR_CODES.sandboxCapabilityUnavailable && firstCapabilityFailure === undefined) {
        firstCapabilityFailure = error
      }
    }
  }
  if (firstCapabilityFailure !== undefined) throw firstCapabilityFailure
  throw new PandaError(PANDA_ERROR_CODES.sandboxCapabilityUnavailable, 'no sandbox provider proves every required capability')
}

function normalizedSession(value: unknown): SandboxSession {
  if (typeof value !== 'object' || value === null) throw new Error('sandbox provider returned a non-object session')
  const candidate = value as Partial<SandboxSession>
  const { id, execute, openStdio, snapshot, restore, dispose } = candidate
  if (typeof id !== 'string' || id.length === 0 || typeof execute !== 'function' || typeof dispose !== 'function') {
    throw new Error('sandbox provider returned an invalid session')
  }
  return Object.freeze({
    id,
    execute: execute.bind(value),
    ...(typeof openStdio === 'function' ? { openStdio: openStdio.bind(value) } : {}),
    ...(typeof snapshot === 'function' ? { snapshot: snapshot.bind(value) } : {}),
    ...(typeof restore === 'function' ? { restore: restore.bind(value) } : {}),
    dispose: dispose.bind(value),
  })
}

class ManagedSandboxSession implements ResolvedSandboxSession {
  #state: SessionState = 'active'
  #disposePromise: Promise<void> | undefined

  constructor(
    private readonly session: SandboxSession,
    private readonly policy: SandboxPolicy,
    readonly providerId: string,
    private readonly capabilities: ReturnType<typeof validateSandboxCapabilities>,
  ) {}

  get id(): string {
    return this.session.id
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    if (this.#state !== 'active') throw unavailable(`sandbox session '${this.id}' is not reusable after teardown begins`)
    const validated = validateSandboxExecutionRequest(request)
    if (!samePolicy(this.policy, validated.policy)) {
      throw requestInvalid(`sandbox execution policy does not match session '${this.id}' policy`)
    }

    let executionResult: unknown
    try {
      executionResult = await this.session.execute(validated)
    } catch (error) {
      this.#state = 'uncertain'
      throw unavailable(`sandbox session '${this.id}' execution failed without a structured result`, error)
    }

    try {
      let resultSnapshot: unknown
      try {
        // Snapshot every provider-owned result property before local validation so
        // hostile getters cannot choose panda's outward error vocabulary.
        resultSnapshot = snapshotExecutionResult(executionResult)
      } catch (error) {
        throw unavailable(`sandbox session '${this.id}' execution result could not be normalized`, error)
      }
      const result = validateSandboxExecutionResult(resultSnapshot)
      const enforcement = validateSandboxCapabilities(this.policy, result.enforcement)
      if (enforcement.providerId !== this.capabilities.providerId) {
        throw new PandaError(
          PANDA_ERROR_CODES.sandboxResponseInvalid,
          `sandbox session '${this.id}' returned enforcement for provider '${enforcement.providerId}', not selected provider '${this.providerId}'`,
        )
      }
      return result
    } catch (error) {
      this.#state = 'uncertain'
      if (error instanceof PandaError) throw error
      throw unavailable(`sandbox session '${this.id}' execution result could not be validated`, error)
    }
  }

  async openStdio(request: SandboxExecutionRequest): Promise<SandboxStdioSession> {
    if (this.#state !== 'active') throw unavailable(`sandbox session '${this.id}' is not reusable after teardown begins`)
    const validated = validateSandboxExecutionRequest(request)
    if (!samePolicy(this.policy, validated.policy)) throw requestInvalid(`sandbox execution policy does not match session '${this.id}' policy`)
    const openStdio = this.session.openStdio
    if (typeof openStdio !== 'function') throw unavailable(`sandbox session '${this.id}' does not expose stdio`)
    try {
      return await openStdio(validated)
    } catch (error) {
      this.#state = 'uncertain'
      throw unavailable(`sandbox session '${this.id}' stdio could not be opened`, error)
    }
  }

  async snapshot(paths: readonly string[]): Promise<readonly SandboxSnapshot[]> {
    if (this.#state !== 'active') throw unavailable(`sandbox session '${this.id}' is not reusable after teardown begins`)
    const snapshot = this.session.snapshot
    if (typeof snapshot !== 'function') throw unavailable(`sandbox session '${this.id}' does not expose snapshots`)
    try {
      return Object.freeze((await snapshot.call(this.session, Object.freeze([...paths]))).map((entry) => validateSandboxSnapshot(entry)))
    } catch (error) {
      this.#state = 'uncertain'
      throw unavailable(`sandbox session '${this.id}' snapshots could not be created`, error)
    }
  }

  async restore(snapshots: readonly SandboxSnapshot[]): Promise<void> {
    if (this.#state !== 'active') throw unavailable(`sandbox session '${this.id}' is not reusable after teardown begins`)
    const restore = this.session.restore
    if (typeof restore !== 'function') throw unavailable(`sandbox session '${this.id}' does not expose snapshot restore`)
    try {
      await restore.call(this.session, Object.freeze(snapshots.map((entry) => validateSandboxSnapshot(entry))))
    } catch (error) {
      this.#state = 'uncertain'
      throw unavailable(`sandbox session '${this.id}' snapshots could not be restored`, error)
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#state = 'disposing'
    this.#disposePromise = Promise.resolve()
      .then(() => this.session.dispose())
      .then(
        () => {
          this.#state = 'disposed'
        },
        (error: unknown) => {
          this.#state = 'uncertain'
          throw unavailable(`sandbox session '${this.id}' teardown outcome is uncertain`, error)
        },
      )
    return this.#disposePromise
  }
}

function samePolicy(left: SandboxPolicy, right: SandboxPolicy): boolean {
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

export function createSandboxProviderResolver(providers: readonly SandboxProvider[]): SandboxProviderResolver {
  const available = Object.freeze([...providers])

  function select(policy: SandboxPolicy): SandboxProvider {
    const validated = validateSandboxPolicy(policy)
    if (available.length === 0) throw unavailable('no sandbox providers are registered')
    return selectProvider(available, validated).provider
  }

  return Object.freeze({
    select,
    async createSession(request: SandboxSessionRequest): Promise<ResolvedSandboxSession> {
      const validated = validatedSessionRequest(request)
      if (available.length === 0) throw unavailable('no sandbox providers are registered')
      const selected = selectProvider(available, validated.policy)
      let session: SandboxSession
      try {
        session = normalizedSession(await selected.createSession(validated))
      } catch (error) {
        throw unavailable('sandbox provider could not create a session', error)
      }
      return new ManagedSandboxSession(session, validated.policy, selected.providerId, selected.capabilities)
    },
  })
}

