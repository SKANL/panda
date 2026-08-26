import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// The ONLY import in this file, and that is the assertion: everything a consumer
// needs — the function, the seam types, the log sink — comes from this package's
// single public entry. A `@panda/session`-only install cannot resolve
// `@panda/contracts` or `@panda/kernel` under pnpm's strict layout, so a test
// that reached for either would be proving the claim on a monorepo's terms.
import { createMemoryLogSink, resolveExecutor, runSession, SESSION_ACTION_ID } from '../src/index.ts'
import type { ExecutorAdapter, ResultEnvelope, RunRequest } from '../src/index.ts'

/**
 * The POSITIVE half of "the CLI is a thin binding". A negative scan of CLI source
 * can be evaded — a working composition was planted past the previous one using
 * relative cross-package imports and destructured provider methods. This cannot
 * be evaded by rewriting the CLI, because it never mentions the CLI: it composes
 * a session the way a third party would and asserts the observable result is the
 * one `panda run` prints. If composition drifts back into `@panda/cli`, this test
 * is what stops passing when the session is hollowed out to compensate.
 */
describe('a consumer with no @panda/cli installed', () => {
  it('gets the envelope panda run prints, and the exit code it maps from', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'panda-consumer-'))
    let seen: RunRequest | undefined
    const adapter: ExecutorAdapter = {
      run(request) {
        seen = request
        const envelope: ResultEnvelope = {
          status: 'ok',
          data: { result: 'a.txt' },
          summary: 'listed files',
          errors: [],
        }
        return Promise.resolve(envelope)
      },
    }

    const log = createMemoryLogSink()
    const envelope = await runSession({ prompt: 'list files', cwd, log, createAdapter: () => adapter })

    // Byte-for-byte what the CLI writes to stdout, and the input to its exit-code
    // ternary. The CLI adds `JSON.stringify(envelope, null, 2)` and nothing else.
    expect(JSON.parse(JSON.stringify(envelope, null, 2))).toEqual({
      status: 'ok',
      data: { result: 'a.txt' },
      summary: 'listed files',
      errors: [],
    })
    expect(envelope.status === 'ok' ? 0 : 1).toBe(0)

    // The REAL default provider ran: a workspace directory exists on disk under
    // the cwd the consumer named. Nothing was injected to fake this away.
    const workspacePath = seen?.workspace.rootPath ?? ''
    expect(workspacePath.startsWith(join(cwd, '.panda', 'workspaces'))).toBe(true)
    expect((await stat(workspacePath)).isDirectory()).toBe(true)

    // And it went through the waterfall, from a consumer's entry point.
    await log.drain()
    expect(log.records.map((record) => record.event)).toEqual(['action.invoked', 'action.completed'])
    expect(log.records.every((record) => record.subject.startsWith(`${SESSION_ACTION_ID}#`))).toBe(true)
  })

  it('chooses WHICH executor from the same entry point, not only how to run one', async () => {
    // The other half of FR-29 for Story 2.7c. `panda run` is two capability
    // calls — resolve, then run — and both have to be reachable from this one
    // import or the CLI still owns half the feature.
    //
    // It goes through `../src/index.ts` on purpose: the executor tests import
    // `../src/executors.ts` directly, so deleting the re-export from `index.ts`
    // left them green while a real consumer could no longer reach the selection.
    const homeDir = await mkdtemp(join(tmpdir(), 'panda-consumer-home-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'panda-consumer-project-'))
    await mkdir(join(projectDir, '.panda'), { recursive: true })
    await writeFile(join(projectDir, '.panda', 'config.json'), JSON.stringify({ executor: 'codex' }))

    const selection = await resolveExecutor({ homeDir, projectDir })
    expect(selection).toEqual({
      executorId: 'codex',
      layer: 'project',
      available: ['claude-code', 'codex', 'opencode'],
    })

    // And the selection is what `runSession` takes, from the same import.
    let ran = false
    await runSession({
      prompt: 'list files',
      cwd: projectDir,
      executorId: selection.executorId,
      createAdapter: () => ({
        run: () => {
          ran = true
          return Promise.resolve({ status: 'ok', data: null, summary: 'ok', errors: [] })
        },
      }),
    })
    expect(ran).toBe(true)
  })
})
