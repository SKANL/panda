import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import type { WorkspaceHandle } from '@skanl/panda-contracts'
import { createClaudeCodeAdapter, createNodeChildSpawner } from '../src/index.ts'
import type { AdapterTiming } from '../src/index.ts'

// NFR-9 measurement: adapter-added spawn overhead must stay <=150ms above a raw
// CLI startup. The delta that matters is what the adapter ADDS on top of spawning
// the same command directly, so both sides are measured against a trivial binary
// (process.execPath) instead of the real claude CLI — no network, no auth, no
// cold-start jitter, therefore no CI flake. Live evidence with the real binary is
// covered by the env-gated live smoke.
const OVERHEAD_BUDGET_MS = 150
const SAMPLES = 12

describe('spawn overhead budget (NFR-9)', () => {
  it(
    'adds at most 150ms above a raw spawn of the same command',
    async () => {
    const cwd = tmpdir()
    const handle: WorkspaceHandle = { id: 'overhead', rootPath: cwd, capabilities: ['read', 'write'] }

    const spawner = createNodeChildSpawner()
    const timings: AdapterTiming[] = []
    const adapter = createClaudeCodeAdapter({ spawner, command: process.execPath, onTiming: (t) => timings.push(t) })

    const adapterSetups: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const envelope = await adapter.run({ prompt: 'overhead probe', workspace: handle })
      // node rejects claude's flags; only the adapter's setup timing matters here.
      expect(['ok', 'failed']).toContain(envelope.status)
      const timing = timings.at(-1)
      expect(timing?.spawnSetupMs).toBeGreaterThanOrEqual(0)
      if (timing) adapterSetups.push(timing.spawnSetupMs)
    }

    const rawSetups: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const startedAt = performance.now()
      const child = spawner.spawn(process.execPath, ['--version'], { cwd })
      rawSetups.push(performance.now() - startedAt)
      await child.done
    }

    const delta = Math.max(0, Math.min(...adapterSetups) - Math.min(...rawSetups))
    expect(delta).toBeLessThanOrEqual(OVERHEAD_BUDGET_MS)
    },
    60_000,
  )
})
