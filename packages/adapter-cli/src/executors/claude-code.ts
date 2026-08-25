import { createCliExecutorAdapter } from '../traits.ts'
import type { CliExecutorAdapter, CliExecutorAdapterOptions, ExecutorTraits } from '../traits.ts'

// Claude Code trait record.
//
// Headless print mode: `--print --output-format json` prints ONE JSON result
// object on stdout, and the prompt arrives via stdin (the CLI's piped-input
// convention). Session persistence is off so no session state outlives the
// workspace; permissions are bypassed because headless execution has no
// interactive approver.
//
// Failure shape: print-mode payloads carry `is_error` plus a `subtype`
// ('success', 'error_max_turns', …). Both must surface as FAILED envelopes even
// when the process exited 0, which is exactly what the flag/status-prefix
// traits below express.

export const CLAUDE_CODE_TRAITS: ExecutorTraits = {
  executorId: 'claude-code',
  command: 'claude',
  args: Object.freeze(['--print', '--output-format', 'json', '--no-session-persistence', '--dangerously-skip-permissions']),
  promptDelivery: 'stdin',
  output: {
    payload: 'single-object',
    resultPath: ['result'],
    errorFlagPath: ['is_error'],
    statusPath: ['subtype'],
    errorStatusPrefix: 'error',
    metadata: { subtype: ['subtype'], session_id: ['session_id'] },
  },
}

export function createClaudeCodeAdapter(options: CliExecutorAdapterOptions = {}): CliExecutorAdapter {
  return createCliExecutorAdapter(CLAUDE_CODE_TRAITS, options)
}
