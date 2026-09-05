import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspaceHandle } from '@skanl/panda-contracts'
import { createClaudeCodeAdapter, createNodeChildSpawner } from '../src/index.ts'

// Live smoke against the real `claude` CLI. Gating is deterministic:
// - the binary is probed cheaply via `claude --version` (no API call);
// - PANDA_LIVE_SMOKE=0 forces a skip with an explicit typed reason;
// - CI-like environments without the binary skip instantly on spawn failure;
// - a detected-but-unauthenticated binary SKIPS with that reason (never fails
//   CI on credentials, never silently passes);
// - any other failure of the tiny real task is a hard failure with evidence.

const VERSION_PROBE_TIMEOUT_MS = 15_000
const LIVE_TASK_TIMEOUT_MS = 120_000

interface ClaudeAvailability {
  readonly available: boolean
  readonly reason: string
}

async function probeClaudeAvailability(): Promise<ClaudeAvailability> {
  if (process.env['PANDA_LIVE_SMOKE'] === '0') {
    return { available: false, reason: 'PANDA_LIVE_SMOKE=0 explicitly disables the live smoke' }
  }
  const child = createNodeChildSpawner().spawn('claude', ['--version'], { cwd: tmpdir() })
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    child.done,
    new Promise<undefined>((resolve) => {
      probeTimer = setTimeout(() => resolve(undefined), VERSION_PROBE_TIMEOUT_MS)
    }),
  ]).finally(() => {
    clearTimeout(probeTimer)
  })
  if (outcome === undefined) {
    child.killTree()
    return { available: false, reason: `claude CLI version probe exceeded ${VERSION_PROBE_TIMEOUT_MS}ms` }
  }
  if (outcome.spawnErrorMessage !== undefined) {
    return { available: false, reason: `claude CLI not detected: ${outcome.spawnErrorMessage}` }
  }
  if (outcome.exitCode !== 0) {
    return { available: false, reason: `claude CLI version probe exited with code ${outcome.exitCode}` }
  }
  return { available: true, reason: outcome.stdout.trim() }
}

// Skipping as "unauthenticated" requires a REAL auth verdict from the CLI: those
// messages only reach the envelope when claude exited non-zero with an auth-ish
// error on stderr (synthesized adapter failures never contain them). Anything
// else is a hard failure with evidence.
function looksLikeAuthFailure(envelope: { status: string; errors?: readonly { message: string }[] }): boolean {
  if (envelope.status !== 'failed') return false
  const message = envelope.errors?.map((error) => error.message).join('; ') ?? ''
  return /invalid api key|api key (is )?(invalid|required|missing)|not authenticated|unauthenticated|(please )?run `?claude login`?|oauth token|insufficient credit/i.test(message)
}

describe('live claude smoke', () => {
  it(
    'runs one tiny real task end-to-end inside a workspace',
    async (ctx) => {
      const availability = await probeClaudeAvailability()
      if (!availability.available) ctx.skip(`live claude smoke skipped: ${availability.reason}`)

      const rootDir = await mkdtemp(join(tmpdir(), 'panda-live-'))
      try {
        const adapter = createClaudeCodeAdapter()
        const handle: WorkspaceHandle = {
          id: 'panda-live-smoke',
          rootPath: rootDir,
          capabilities: ['read', 'write'],
        }
        const envelope = await adapter.run({
          prompt:
            'Create a file named panda-live.txt in the current directory containing exactly the text panda-ok. Do nothing else.',
          workspace: handle,
          signal: AbortSignal.timeout(LIVE_TASK_TIMEOUT_MS),
        })

        if (looksLikeAuthFailure(envelope)) {
          ctx.skip(`claude detected but not authenticated: ${envelope.errors?.[0]?.message}`)
        }

        expect(envelope.status).toBe('ok')
        expect(envelope.summary.length).toBeGreaterThan(0)
        await expect(readFile(join(rootDir, 'panda-live.txt'), 'utf8')).resolves.toContain('panda-ok')
      } finally {
        // Best-effort only: on Windows a finished child's lingering descendants
        // can hold the workspace cwd for a while, which must not fail the smoke.
        try {
          await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        } catch {
          // Temp dir is left behind; harmless.
        }
      }
    },
    LIVE_TASK_TIMEOUT_MS + VERSION_PROBE_TIMEOUT_MS + 10_000,
  )
})
