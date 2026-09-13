import { describe, expect, it } from 'vitest'
import * as contracts from '../src'

function api(name: string): (...values: unknown[]) => unknown {
  const candidate = Reflect.get(contracts, name)
  expect(candidate, `${name} must be exported publicly`).toBeTypeOf('function')
  return candidate as (...values: unknown[]) => unknown
}

function expectPandaError(action: () => unknown, code: string): void {
  try {
    action()
    expect.unreachable()
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

const policy = {
  version: 1,
  mode: 'read-only',
  workspaceRoot: '/workspace',
  requiredCapabilities: { filesystem: 'full', network: 'full', process: 'full' },
}

const capabilities = {
  version: 1,
  providerId: 'remote-sandbox',
  enforcement: 'remote',
  controls: { filesystem: 'full', network: 'full', process: 'full', resources: 'full' },
}

describe('sandbox contracts', () => {
  it('exports dependency-free versioned policy vocabulary', () => {
    expect(contracts).toMatchObject({
      SANDBOX_POLICY_VERSION: 1,
      SANDBOX_MODES: ['read-only', 'workspace-write', 'danger-full-access'],
      SANDBOX_ENFORCEMENT_LEVELS: ['none', 'simulated', 'partial', 'os', 'remote'],
    })
  })

  it('rejects unsupported policy versions and danger-full-access without an explicit acknowledgement', () => {
    const validateSandboxPolicy = api('validateSandboxPolicy')
    expectPandaError(() => validateSandboxPolicy({ ...policy, version: 2 }), 'PANDA_SANDBOX_POLICY_INVALID')
    expectPandaError(
      () => validateSandboxPolicy({ ...policy, mode: 'danger-full-access' }),
      'PANDA_SANDBOX_POLICY_INVALID',
    )
  })

  it.each(['read-only', 'workspace-write'] as const)('requires full filesystem and process enforcement for %s', (mode) => {
    const validateSandboxPolicy = api('validateSandboxPolicy')
    expectPandaError(
      () => validateSandboxPolicy({ ...policy, mode, requiredCapabilities: { filesystem: 'none', process: 'full' } }),
      'PANDA_SANDBOX_POLICY_INVALID',
    )
    expectPandaError(
      () => validateSandboxPolicy({ ...policy, mode, requiredCapabilities: { process: 'full' } }),
      'PANDA_SANDBOX_POLICY_INVALID',
    )
  })

  it('normalizes and freezes all sandbox resource limits', () => {
    const validateSandboxPolicy = api('validateSandboxPolicy')
    const resourceLimits = {
      wallTimeMs: 1_000,
      memoryBytes: 2_000,
      outputBytes: 3_000,
      fileSizeBytes: 4_000,
      processCount: 5,
    }
    const validatedPolicy = validateSandboxPolicy({ ...policy, resourceLimits }) as typeof policy & {
      resourceLimits: typeof resourceLimits
    }

    expect(validatedPolicy.resourceLimits).toEqual(resourceLimits)
    expect(validatedPolicy.resourceLimits).not.toBe(resourceLimits)
    expect(Object.isFrozen(validatedPolicy.resourceLimits)).toBe(true)
    expect(Reflect.set(validatedPolicy.resourceLimits, 'wallTimeMs', 0)).toBe(false)
    expect(validatedPolicy.resourceLimits.wallTimeMs).toBe(1_000)
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['non-safe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s sandbox resource limits', (_label, value) => {
    const validateSandboxPolicy = api('validateSandboxPolicy')
    expectPandaError(
      () => validateSandboxPolicy({ ...policy, resourceLimits: { wallTimeMs: value } }),
      'PANDA_SANDBOX_POLICY_INVALID',
    )
  })

  it('rejects unknown sandbox resource-limit keys', () => {
    const validateSandboxPolicy = api('validateSandboxPolicy')
    expectPandaError(
      () => validateSandboxPolicy({ ...policy, resourceLimits: { wallTimeMs: 1, cpuTimeMs: 2 } }),
      'PANDA_SANDBOX_POLICY_INVALID',
    )
  })

  it('admits exact argv only and rejects unsafe paths or shell-command fields', () => {
    const validateSandboxExecutionRequest = api('validateSandboxExecutionRequest')
    const request = {
      argv: ['git', 'status'],
      cwd: '/workspace',
      environment: { LANG: 'C' },
      policy,
    }
    expect(validateSandboxExecutionRequest(request)).toEqual(request)
    expectPandaError(
      () => validateSandboxExecutionRequest({ ...request, argv: [] }),
      'PANDA_SANDBOX_REQUEST_INVALID',
    )
    expectPandaError(
      () => validateSandboxExecutionRequest({ ...request, argv: ['git', `status${String.fromCharCode(0)}`] }),
      'PANDA_SANDBOX_REQUEST_INVALID',
    )
    expectPandaError(
      () => validateSandboxExecutionRequest({ ...request, cwd: '/workspace/../secrets' }),
      'PANDA_SANDBOX_REQUEST_INVALID',
    )
    expectPandaError(
      () => validateSandboxExecutionRequest({ ...request, command: 'git status' }),
      'PANDA_SANDBOX_REQUEST_INVALID',
    )
  })

  it('requires cwd to stay lexically contained by the policy workspace on POSIX and Windows paths', () => {
    const validateSandboxExecutionRequest = api('validateSandboxExecutionRequest')
    const request = {
      argv: ['git', 'status'],
      cwd: '/workspace/nested',
      environment: {},
      policy,
    }
    expect(validateSandboxExecutionRequest(request)).toEqual(request)
    expectPandaError(
      () => validateSandboxExecutionRequest({ ...request, cwd: '/workspace-escape' }),
      'PANDA_SANDBOX_REQUEST_INVALID',
    )

    const windowsPolicy = { ...policy, workspaceRoot: 'C:\\workspace' }
    expect(validateSandboxExecutionRequest({ ...request, cwd: 'c:\\workspace\\nested', policy: windowsPolicy })).toMatchObject({
      cwd: 'c:\\workspace\\nested',
    })
    expectPandaError(
      () => validateSandboxExecutionRequest({ ...request, cwd: 'C:\\workspace-escape', policy: windowsPolicy }),
      'PANDA_SANDBOX_REQUEST_INVALID',
    )
  })

  it('rejects snapshots with escaping paths before a provider can create a session', () => {
    const validateSandboxSnapshot = api('validateSandboxSnapshot')
    expectPandaError(
      () => validateSandboxSnapshot({ version: 1, path: '../secret.txt', kind: 'file', digest: 'sha256:abc' }),
      'PANDA_SANDBOX_SNAPSHOT_INVALID',
    )
    expectPandaError(
      () => validateSandboxSnapshot({ version: 1, path: 'C:secret.txt', kind: 'file', digest: 'sha256:abc' }),
      'PANDA_SANDBOX_SNAPSHOT_INVALID',
    )
  })

  it('fails closed when provider facts do not prove a required capability', () => {
    const validateSandboxCapabilities = api('validateSandboxCapabilities')
    expectPandaError(
      () => validateSandboxCapabilities(policy, { ...capabilities, controls: { ...capabilities.controls, network: 'none' } }),
      'PANDA_SANDBOX_CAPABILITY_UNAVAILABLE',
    )
  })

  it('rejects malformed provider responses rather than accepting a best-effort result', () => {
    const validateSandboxExecutionResult = api('validateSandboxExecutionResult')
    expectPandaError(
      () => validateSandboxExecutionResult({ status: 'ok', stdout: '', stderr: '', enforcement: { ...capabilities, controls: {} } }),
      'PANDA_SANDBOX_RESPONSE_INVALID',
    )
    expectPandaError(
      () => validateSandboxExecutionResult({
        status: 'denied',
        stdout: '',
        stderr: '',
        enforcement: capabilities,
        error: { code: 'PANDA_SANDBOX_RUNNER_FAILED', message: 'runner crashed' },
      }),
      'PANDA_SANDBOX_RESPONSE_INVALID',
    )
  })

  it('freezes public vocabularies and returns defensive immutable validation results', () => {
    const validateSandboxPolicy = api('validateSandboxPolicy')
    const validateSandboxExecutionResult = api('validateSandboxExecutionResult')
    const validatedPolicy = validateSandboxPolicy(policy) as { requiredCapabilities: Record<string, string> }
    expect(validatedPolicy).not.toBe(policy)
    expect(Object.isFrozen(contracts.SANDBOX_MODES)).toBe(true)
    expect(Object.isFrozen(contracts.SANDBOX_ERROR_CODES)).toBe(true)
    expect(Object.isFrozen(validatedPolicy)).toBe(true)
    expect(Object.isFrozen(validatedPolicy.requiredCapabilities)).toBe(true)
    expect(Reflect.set(validatedPolicy.requiredCapabilities, 'network', 'none')).toBe(false)
    expect(validatedPolicy.requiredCapabilities.network).toBe('full')

    const result = validateSandboxExecutionResult({
      status: 'ok',
      stdout: '',
      stderr: '',
      exitCode: 0,
      enforcement: capabilities,
    }) as { enforcement: { controls: Record<string, string> } }
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.enforcement.controls)).toBe(true)
    expect(Reflect.set(result.enforcement.controls, 'network', 'none')).toBe(false)
    expect(result.enforcement.controls.network).toBe('full')
  })
})
