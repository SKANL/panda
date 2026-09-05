import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PANDA_ERROR_CODES } from '@skanl/panda-contracts'
import type { RunRequest, WorkspaceHandle } from '@skanl/panda-contracts'
import { createCliExecutorAdapter } from '../src/traits.ts'
import type { ExecutorTraits } from '../src/traits.ts'
import { FakeSpawner } from './fake-spawner.ts'

// Guards around the trait record as an API surface, and around the argument
// delivery path — the only path that puts caller-supplied text into argv.

const BASE: ExecutorTraits = {
  executorId: 'guard-agent',
  command: 'guard-agent',
  args: Object.freeze(['--json']),
  promptDelivery: 'argument',
  output: { payload: 'single-object', resultPath: ['result'] },
}

function traits(overrides: Partial<ExecutorTraits>): ExecutorTraits {
  return { ...BASE, ...overrides }
}

function request(prompt = 'do a thing'): RunRequest {
  const workspace: WorkspaceHandle = {
    id: 'probe',
    rootPath: join(tmpdir(), 'panda-probe'),
    capabilities: ['read', 'write'],
  }
  return { prompt, workspace }
}

const originalPlatform = process.platform
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}
afterEach(() => setPlatform(originalPlatform))

describe('trait record validation', () => {
  // Each shape below fails SILENTLY at runtime rather than loudly, which is
  // exactly why the factory has to reject it.
  const invalid: readonly (readonly [string, ExecutorTraits])[] = [
    ['empty executorId', traits({ executorId: '  ' })],
    ['empty command', traits({ command: '' })],
    ['empty resultPath', traits({ output: { payload: 'single-object', resultPath: [] } })],
    [
      'empty errorStatusPrefix',
      traits({ output: { payload: 'jsonl', resultPath: ['result'], errorStatusPrefix: '' } }),
    ],
    ['empty errorFlagPath', traits({ output: { payload: 'jsonl', resultPath: ['result'], errorFlagPath: [] } })],
    [
      'metadata key colliding with the result',
      traits({ output: { payload: 'single-object', resultPath: ['result'], metadata: { result: ['other'] } } }),
    ],
    [
      'metadata key colliding with a truncation flag',
      traits({
        output: { payload: 'single-object', resultPath: ['result'], metadata: { stdoutTruncated: ['x'] } },
      }),
    ],
  ]

  it.each(invalid)('rejects %s with a coded error', (_label, record) => {
    expect(() => createCliExecutorAdapter(record)).toThrowError(
      expect.objectContaining({ code: PANDA_ERROR_CODES.contractEnvelopeInvalid }),
    )
  })

  it('accepts a well-formed record', () => {
    expect(createCliExecutorAdapter(BASE).executorId).toBe('guard-agent')
  })
})

describe('payload path resolution', () => {
  it('resolves nothing for a path that exists only on the prototype', async () => {
    // A record must not qualify through inherited members. Note this asserts
    // the OUTCOME: `isRecord` and the own-property guard both enforce it, so
    // this test cannot single out either one.
    const spawner = new FakeSpawner({
      exitCode: 0,
      stdout: JSON.stringify({ nothing: 'useful' }),
      stderr: '',
    })
    const adapter = createCliExecutorAdapter(
      traits({ output: { payload: 'single-object', resultPath: ['constructor', 'name'] } }),
      { spawner },
    )
    const envelope = await adapter.run(request())

    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
  })
})

describe('argument-delivery guards', () => {
  it('refuses to hand a prompt to a win32 .cmd shim, which would let cmd.exe parse it', async () => {
    setPlatform('win32')
    const spawner = new FakeSpawner({ exitCode: 0, stdout: '{}', stderr: '' })
    const adapter = createCliExecutorAdapter(BASE, { spawner, command: 'opencode.cmd' })
    const envelope = await adapter.run(request('go & del /q *'))

    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorUnavailable)
    expect(envelope.errors?.[0]?.message).toContain('cmd.exe')
    // Nothing may reach a shell: the refusal happens before any spawn.
    expect(spawner.children).toHaveLength(0)
  })

  it('still runs a .cmd command when the prompt never enters argv', async () => {
    setPlatform('win32')
    const spawner = new FakeSpawner({ exitCode: 0, stdout: JSON.stringify({ result: 'done' }), stderr: '' })
    const adapter = createCliExecutorAdapter(traits({ promptDelivery: 'stdin' }), {
      spawner,
      command: 'claude.cmd',
    })

    expect((await adapter.run(request())).status).toBe('ok')
    expect(spawner.children).toHaveLength(1)
  })

  it('refuses an argument prompt beyond the platform argv limit with a coded envelope', async () => {
    const spawner = new FakeSpawner({ exitCode: 0, stdout: '{}', stderr: '' })
    const envelope = await createCliExecutorAdapter(BASE, { spawner }).run(request('x'.repeat(200_001)))

    expect(envelope.status).toBe('failed')
    expect(envelope.errors?.[0]?.code).toBe(PANDA_ERROR_CODES.executorRunFailed)
    expect(envelope.errors?.[0]?.message).toMatch(/argument limit/)
    expect(spawner.children).toHaveLength(0)
  })

  it('lets an equally long prompt through on the stdin path', async () => {
    const spawner = new FakeSpawner({ exitCode: 0, stdout: JSON.stringify({ result: 'done' }), stderr: '' })
    const adapter = createCliExecutorAdapter(traits({ promptDelivery: 'stdin' }), { spawner })

    expect((await adapter.run(request('x'.repeat(200_001)))).status).toBe('ok')
  })
})
