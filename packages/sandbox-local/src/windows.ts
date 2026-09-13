import { spawn } from 'node:child_process'
import { PandaError, SANDBOX_ERROR_CODES, validateSandboxCapabilities, validateSandboxPolicy, validateSandboxSnapshot } from '@skanl/panda-contracts'
import { createProvider, DEFAULT_TIMEOUT_MS, probe } from './shared.ts'
import type {
  SandboxCapabilityFacts,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxPolicy,
  SandboxSession,
  SandboxSessionRequest,
  SandboxStdioSession,
} from '@skanl/panda-contracts'
import type { LocalSandboxAuditCallback, LocalSandboxProvider, LocalSandboxProviderOptions } from './shared.ts'

type WindowsSandboxProviderOptions = LocalSandboxProviderOptions & { readonly audit?: LocalSandboxAuditCallback }

const BROKER = 'panda-windows-sandbox-broker'
const SELF_TEST_TIMEOUT_MS = 10_000

function brokerCapabilities(available: boolean): SandboxCapabilityFacts {
  return Object.freeze({
    version: 1,
    providerId: 'local-windows',
    // A missing broker is not partial enforcement: this provider has no
    // verified execution substrate and must fail closed.
    enforcement: available ? 'os' : 'none',
    controls: Object.freeze({
      filesystem: available ? 'full' : 'none',
      process: available ? 'full' : 'none',
      network: available ? 'full' : 'none',
      // The broker self-test does not prove resource quotas.
      resources: available ? 'partial' : 'none',
    }),
  })
}

function brokerPolicy(policy: SandboxPolicy): SandboxPolicy {
  return Object.freeze({
    ...policy,
    requiredCapabilities: Object.freeze({ filesystem: 'full' as const }),
  })
}

function withEnforcement(result: SandboxExecutionResult, enforcement: SandboxCapabilityFacts): SandboxExecutionResult {
  return Object.freeze({ ...result, enforcement })
}

function unavailableSession(id: string, enforcement: SandboxCapabilityFacts): SandboxSession {
  const unavailable = (): SandboxExecutionResult => Object.freeze({
    status: 'unavailable',
    stdout: '',
    stderr: '',
    enforcement,
    error: { code: SANDBOX_ERROR_CODES.unavailable, message: 'Windows Sandbox broker is unavailable' },
  })
  return Object.freeze({
    id,
    execute: async (): Promise<SandboxExecutionResult> => unavailable(),
    openStdio: async (): Promise<SandboxStdioSession> => {
      throw new PandaError(SANDBOX_ERROR_CODES.unavailable as never, 'Windows Sandbox broker is unavailable')
    },
    dispose: async (): Promise<void> => undefined,
  })
}

function brokerSession(
  session: SandboxSession,
  enforcement: SandboxCapabilityFacts,
  policy: SandboxPolicy,
): SandboxSession {
  const delegatedPolicy = brokerPolicy(policy)
  const delegatedRequest = (request: SandboxExecutionRequest): SandboxExecutionRequest => ({ ...request, policy: delegatedPolicy })
  return Object.freeze({
    id: session.id,
    execute: async (request: SandboxExecutionRequest): Promise<SandboxExecutionResult> =>
      withEnforcement(await session.execute(delegatedRequest(request)), enforcement),
    openStdio: async (request: SandboxExecutionRequest): Promise<SandboxStdioSession> => {
      if (session.openStdio === undefined) throw new PandaError(SANDBOX_ERROR_CODES.unavailable as never, 'Windows Sandbox broker stdio is unavailable')
      return session.openStdio(delegatedRequest(request))
    },
    dispose: (): Promise<void> => session.dispose(),
  })
}

async function usableBroker(options: LocalSandboxProviderOptions): Promise<boolean> {
  if (!(await probe(options, [BROKER, '--version']))) return false
  const argv = [BROKER, 'self-test', '--network', 'disabled', '--cleanup'] as const
  // `inspect` is the injected execution seam. Production discovery remains
  // conservative: a broker is unusable until its own isolation self-test passes.
  if (options.inspect !== undefined) return options.inspect(argv)
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false, windowsHide: true, stdio: 'ignore' })
    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false) }, SELF_TEST_TIMEOUT_MS)
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
  })
}

export async function createWindowsSandboxProvider(options: WindowsSandboxProviderOptions): Promise<LocalSandboxProvider> {
  const windowsSandboxBroker = await usableBroker(options)
  const jobObjectHelper = await probe(options, ['panda-windows-job-helper', '--version'])
  const discovery = { bubblewrap: false, landlock: false, cgroup: false, seatbelt: false, windowsSandboxBroker, jobObjectHelper }
  const capabilities = brokerCapabilities(windowsSandboxBroker)
  const base = createProvider(
    'local-windows',
    discovery,
    windowsSandboxBroker ? 'full' : 'none',
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    windowsSandboxBroker
      ? (request) => [
          BROKER,
          'run',
          '--workspace-root', request.policy.workspaceRoot,
          '--working-directory', request.cwd,
          '--network', 'disabled',
          '--workspace-transfer', 'controlled',
          '--cleanup', 'always',
          '--',
          ...request.argv,
        ]
      : undefined,
    undefined,
    options.audit,
  )
  return Object.freeze({
    id: base.id,
    discovery: base.discovery,
    capabilities,
    async createSession(value: SandboxSessionRequest): Promise<SandboxSession> {
      const policy = validateSandboxPolicy(value.policy)
      value.snapshots.forEach(validateSandboxSnapshot)
      validateSandboxCapabilities(policy, capabilities)
      if (!windowsSandboxBroker) return unavailableSession('local-windows-unavailable', capabilities)
      const session = await base.createSession({ ...value, policy: brokerPolicy(policy) })
      return brokerSession(session, capabilities, policy)
    },
  })
}
