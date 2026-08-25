import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeChildSpawner, routesThroughCmdShim } from '../src/node-child-spawner.ts'

// Seam-level proofs that need node:child_process to misbehave on demand: the
// win32 cmd.exe reroute, the capture cap, and the post-exit kill guard. All
// three are process-lifecycle paths a fake ExecutorAdapter spawner cannot reach.

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: mocks.execFile }))

class FakeProcess extends EventEmitter {
  pid = 1234
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly received: string[] = []
  stdinEnded = false
  readonly kill = vi.fn()

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => this.received.push(chunk.toString('utf8')))
    this.stdin.on('end', () => {
      this.stdinEnded = true
    })
    // The real stdin is consumed by the child; drain it so `end` fires.
    this.stdin.resume()
  }
}

const originalPlatform = process.platform
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function queueProcesses(count: number): FakeProcess[] {
  const processes = Array.from({ length: count }, () => new FakeProcess())
  let index = 0
  mocks.spawn.mockImplementation(() => processes[index++]!)
  return processes
}

beforeEach(() => {
  mocks.spawn.mockReset()
  mocks.execFile.mockReset()
})
afterEach(() => setPlatform(originalPlatform))

describe('routesThroughCmdShim', () => {
  it('flags exactly the win32 shim extensions', () => {
    setPlatform('win32')
    expect(routesThroughCmdShim('opencode.cmd')).toBe(true)
    expect(routesThroughCmdShim('OPENCODE.BAT')).toBe(true)
    expect(routesThroughCmdShim('opencode.exe')).toBe(false)
    setPlatform('linux')
    // No reroute off win32, therefore no shell, therefore nothing to refuse.
    expect(routesThroughCmdShim('opencode.cmd')).toBe(false)
  })
})

describe('cmd.exe reroute', () => {
  it('replays buffered stdin onto the rerouted child', async () => {
    setPlatform('win32')
    const [first, second] = queueProcesses(2)

    const child = createNodeChildSpawner().spawn('opencode', ['run'], { cwd: tmpdir() })
    // The caller writes and closes stdin BEFORE the async EINVAL arrives — this
    // is the ordering that used to leave the rerouted child waiting forever.
    child.writeStdin('the prompt')
    child.endStdin()
    first!.emit('error', Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }))
    await new Promise((resolve) => setImmediate(resolve))

    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(mocks.spawn.mock.calls[1]?.[0]).toBe('cmd.exe')
    expect(second!.received.join('')).toBe('the prompt')
    expect(second!.stdinEnded).toBe(true)

    second!.emit('close', 0)
    expect((await child.done).exitCode).toBe(0)
  })
})

describe('stream capture cap', () => {
  it('stops retaining output once the cap is reached', async () => {
    setPlatform('linux')
    const [proc] = queueProcesses(1)
    const child = createNodeChildSpawner().spawn('noisy', [], { cwd: tmpdir() })

    // Four times the cap, in chunks: a cap that fails to advance its counter
    // appends another cap-sized slice for every chunk after the first overflow.
    const chunk = Buffer.alloc(512 * 1024, 0x61)
    for (let i = 0; i < 8; i++) proc!.stdout.write(chunk)
    await new Promise((resolve) => setImmediate(resolve))
    proc!.emit('close', 0)

    const outcome = await child.done
    expect(outcome.stdout.length).toBe(1024 * 1024)
    expect(outcome.stdoutTruncated).toBe(true)
  })
})

describe('killTree', () => {
  it('terminates a live child', async () => {
    setPlatform('win32')
    queueProcesses(1)
    const child = createNodeChildSpawner().spawn('running', [], { cwd: tmpdir() })

    child.killTree()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(mocks.execFile.mock.calls[0]?.[1]).toEqual(['/pid', '1234', '/T', '/F'])
  })

  it('never signals after the child exited, because that pid may be recycled', async () => {
    setPlatform('win32')
    const [proc] = queueProcesses(1)
    const child = createNodeChildSpawner().spawn('finished', [], { cwd: tmpdir() })

    proc!.emit('close', 0)
    await child.done
    expect(child.settled).toBe(true)

    child.killTree()
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(proc!.kill).not.toHaveBeenCalled()
  })
})
