import { PANDA_ERROR_CODES } from '@panda/contracts'
import { isRecord, validateRunRequest } from '@panda/contracts'
import type { ExecutorAdapter, ResultEnvelope, RunRequest } from '@panda/contracts'
import { createNodeChildSpawner } from './node-child-spawner.ts'
import type { ChildProcessSpawner, SpawnOutcome } from './spawn-seam.ts'

export interface ClaudeCodeAdapterOptions {
  /**
   * Child-process seam. Defaults to the real Node spawner; tests inject fakes
   * here so suites never touch the actual binary.
   */
  readonly spawner?: ChildProcessSpawner
  /** Executor command. Defaults to the `claude` CLI on PATH. */
  readonly command?: string
  /** Receives per-run timing, including NFR-9 spawn-overhead instrumentation. */
  readonly onTiming?: (timing: AdapterTiming) => void
}

export interface AdapterTiming {
  /** Milliseconds spent inside run() before the child was handed to the OS. */
  readonly spawnSetupMs: number
  /** Total wall time of the run() call. */
  readonly runMs: number
}

// Headless print mode: prompt arrives via stdin (CLI convention for piped input),
// a single JSON result object comes back on stdout. Session persistence is off so
// no session state outlives the workspace; permissions are bypassed because there
// is no interactive approver in headless execution.
const HEADLESS_ARGS = Object.freeze([
  '--print',
  '--output-format',
  'json',
  '--no-session-persistence',
  '--dangerously-skip-permissions',
])

const SUMMARY_MAX_LENGTH = 200

export class ClaudeCodeAdapter implements ExecutorAdapter {
  readonly #spawner: ChildProcessSpawner
  readonly #command: string
  readonly #onTiming: ((timing: AdapterTiming) => void) | undefined

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#spawner = options.spawner ?? createNodeChildSpawner()
    this.#command = options.command ?? 'claude'
    this.#onTiming = options.onTiming
  }

  async run(request: RunRequest): Promise<ResultEnvelope> {
    validateRunRequest(request)
    const startedAt = performance.now()
    // Measured before any child exists; overwritten after spawn on the real path.
    let spawnSetupMs = performance.now() - startedAt

    if (request.signal?.aborted) return this.#cancelled(startedAt, spawnSetupMs)

    // Everything between startedAt and here is adapter-added overhead (NFR-9);
    // the OS-level process start itself is shared with a raw CLI invocation.
    let child: ReturnType<ChildProcessSpawner['spawn']>
    try {
      child = this.#spawner.spawn(this.#command, HEADLESS_ARGS, { cwd: request.workspace.rootPath })
      spawnSetupMs = performance.now() - startedAt
    } catch (error) {
      return this.#finish(
        startedAt,
        spawnSetupMs,
        this.#failed(
          `executor '${this.#command}' could not be spawned: ${error instanceof Error ? error.message : String(error)}`,
          PANDA_ERROR_CODES.executorUnavailable,
        ),
      )
    }

    // Completion must be observed before an abort can claim cancellation: an
    // abort landing AFTER the child already exited successfully yields the real
    // ok/failed result, not a cancelled envelope.
    let completionSettled = false
    const completion = child.done.then((outcome) => {
      completionSettled = true
      return outcome
    })
    let cancelledInFlight = false
    const abort = () => {
      if (!completionSettled) {
        cancelledInFlight = true
        child.killTree()
      }
    }
    request.signal?.addEventListener('abort', abort, { once: true })
    try {
      try {
        child.writeStdin(request.prompt)
        child.endStdin()
      } catch (error) {
        return this.#finish(
          startedAt,
          spawnSetupMs,
          this.#failed(
            `pipe to executor '${this.#command}' failed: ${error instanceof Error ? error.message : String(error)}`,
            PANDA_ERROR_CODES.executorRunFailed,
          ),
        )
      }
      const outcome = await completion
      if (cancelledInFlight) return this.#cancelled(startedAt, spawnSetupMs)
      return this.#fromOutcome(outcome, startedAt, spawnSetupMs)
    } finally {
      request.signal?.removeEventListener('abort', abort)
    }
  }

  #fromOutcome(outcome: SpawnOutcome, startedAt: number, spawnSetupMs: number): ResultEnvelope {
    if (outcome.spawnErrorMessage !== undefined) {
      return this.#finish(
        startedAt,
        spawnSetupMs,
        this.#failed(
          `executor '${this.#command}' is not available: ${outcome.spawnErrorMessage}`,
          PANDA_ERROR_CODES.executorUnavailable,
        ),
      )
    }
    if (outcome.streamErrorMessage !== undefined) {
      return this.#finish(
        startedAt,
        spawnSetupMs,
        this.#failed(
          `pipe to or from executor '${this.#command}' failed: ${outcome.streamErrorMessage}`,
          PANDA_ERROR_CODES.executorRunFailed,
        ),
      )
    }
    if (outcome.exitCode === null) {
      return this.#finish(
        startedAt,
        spawnSetupMs,
        this.#failed(
          `executor '${this.#command}' was terminated by an external signal before completing`,
          PANDA_ERROR_CODES.executorRunFailed,
        ),
      )
    }
    if (outcome.exitCode !== 0) {
      const detail =
        outcome.stderr.trim().length > 0
          ? outcome.stderr.trim()
          : `executor '${this.#command}' exited with code ${outcome.exitCode}`
      return this.#finish(startedAt, spawnSetupMs, this.#failed(detail, PANDA_ERROR_CODES.executorRunFailed))
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(outcome.stdout)
    } catch {
      return this.#finish(
        startedAt,
        spawnSetupMs,
        this.#failed(
          `executor '${this.#command}' printed unparseable output instead of JSON`,
          PANDA_ERROR_CODES.executorRunFailed,
        ),
      )
    }
    return this.#finish(startedAt, spawnSetupMs, this.#envelopeFromPayload(parsed, outcome))
  }

  // Claude print-mode JSON payloads carry is_error plus a subtype ('success',
  // 'error_max_turns', ...). Error subtypes must surface as FAILED envelopes even
  // when the process exited 0; subtype and session metadata travel into data.
  #envelopeFromPayload(parsed: unknown, outcome: SpawnOutcome): ResultEnvelope {
    const truncated =
      outcome.stdoutTruncated || outcome.stderrTruncated
        ? { stdoutTruncated: outcome.stdoutTruncated, stderrTruncated: outcome.stderrTruncated }
        : {}
    if (!isRecord(parsed)) {
      return this.#failed(
        `executor '${this.#command}' returned JSON without a result payload`,
        PANDA_ERROR_CODES.executorRunFailed,
      )
    }
    const isError = parsed['is_error'] === true
    const subtype = typeof parsed['subtype'] === 'string' ? parsed['subtype'] : undefined
    const sessionId = typeof parsed['session_id'] === 'string' ? parsed['session_id'] : undefined
    const errorSubtype = subtype !== undefined && subtype.startsWith('error')
    const data = {
      ...(typeof parsed['result'] === 'string' ? { result: parsed['result'] } : {}),
      ...(subtype !== undefined ? { subtype } : {}),
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      ...truncated,
    }

    if (isError || errorSubtype) {
      const payloadResult = typeof parsed['result'] === 'string' ? parsed['result'] : ''
      const detail = [payloadResult.trim(), outcome.stderr.trim()].find((part) => part.length > 0) ?? ''
      return this.#failed(
        detail.length > 0
          ? `executor '${this.#command}' reported failure${subtype !== undefined ? ` (${subtype})` : ''}: ${detail}`
          : `executor '${this.#command}' reported failure${subtype !== undefined ? ` (${subtype})` : ''}`,
        PANDA_ERROR_CODES.executorRunFailed,
        data,
      )
    }
    if (typeof parsed['result'] !== 'string') {
      return this.#failed(
        `executor '${this.#command}' returned JSON without a string 'result' field`,
        PANDA_ERROR_CODES.executorRunFailed,
        data,
      )
    }
    return {
      status: 'ok',
      data,
      summary: summarize(parsed['result']),
      errors: [],
    }
  }

  #cancelled(startedAt: number, spawnSetupMs: number): ResultEnvelope {
    return this.#finish(startedAt, spawnSetupMs, {
      status: 'cancelled',
      data: null,
      summary: 'execution cancelled before completion',
      errors: [
        {
          message: 'the run was cancelled and its process tree terminated',
          code: PANDA_ERROR_CODES.executorCancelled,
        },
      ],
    })
  }

  #failed(message: string, code: string, data: unknown = null): ResultEnvelope {
    return {
      status: 'failed',
      data,
      summary: message.length > SUMMARY_MAX_LENGTH ? `${message.slice(0, SUMMARY_MAX_LENGTH)}…` : message,
      errors: [{ message, code }],
    }
  }

  #finish(startedAt: number, spawnSetupMs: number, envelope: ResultEnvelope): ResultEnvelope {
    this.#onTiming?.({ spawnSetupMs, runMs: performance.now() - startedAt })
    return envelope
  }
}

function summarize(result: string): string {
  const firstLine = result
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const text = firstLine ?? 'claude completed the task'
  return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH)}…` : text
}
