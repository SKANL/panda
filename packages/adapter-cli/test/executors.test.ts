import { createClaudeCodeAdapter } from '../src/executors/claude-code.ts'
import { createCodexAdapter } from '../src/executors/codex.ts'
import { createOpenCodeAdapter } from '../src/executors/opencode.ts'
import { PROMPT, runExecutorClauseSuite } from './executor-suite.ts'

// The three shipped adapters satisfy the SAME clauses, exercised uniformly
// through the shared runner. Their only differences are the two real structural
// axes — prompt delivery and payload shape — and both are trait DATA.
//
// The fixtures mirror the real event shapes: codex's reasoning item and
// opencode's step_finish event are present ON PURPOSE, because both are records
// the scan must decline before it reaches the actual answer.

const RESULT_TEXT = 'Wrote panda-ok.txt\nAll done.'

function jsonl(...events: readonly unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

runExecutorClauseSuite([
  {
    label: 'claude-code',
    executorId: 'claude-code',
    command: 'claude',
    makeAdapter: (options) => createClaudeCodeAdapter(options),
    promptDelivery: 'stdin',
    payload: 'jsonl',
    // E7: `stream-json` and `--verbose` travel together or the binary exits 1
    // before it does anything. MEASURED, and this is the clause that pins it.
    expectedArgs: [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
    ],
    // The event shapes the real stream emits, in the real order: the `system`
    // and `assistant` events are here ON PURPOSE. Each one carries a `subtype`
    // or a `type` of its own, and `failureWhen` is what keeps the scan from
    // reading Claude's failure vocabulary off a record that is not the result.
    okStdout: jsonl(
      { type: 'system', subtype: 'init', session_id: 's-1', cwd: '/somewhere' },
      { type: 'assistant', message: { role: 'assistant' }, session_id: 's-1' },
      { type: 'result', subtype: 'success', is_error: false, result: RESULT_TEXT, session_id: 's-1' },
    ),
    expectedResult: RESULT_TEXT,
    expectedMetadata: { subtype: 'success', session_id: 's-1' },
    reportedFailureStdout: jsonl(
      { type: 'system', subtype: 'init', session_id: 's-1' },
      { type: 'result', subtype: 'error_max_turns', is_error: false, result: 'the turn limit was reached' },
    ),
    expectedFailureDetail: 'the turn limit was reached',
  },
  {
    label: 'codex',
    executorId: 'codex',
    command: 'codex',
    makeAdapter: (options) => createCodexAdapter(options),
    promptDelivery: 'stdin',
    payload: 'jsonl',
    expectedArgs: ['exec', '--json', '--skip-git-repo-check'],
    okStdout: jsonl(
      { type: 'thread.started', thread_id: 't-1' },
      // A reasoning item carries `item.text` too: only the discriminator keeps
      // the chain-of-thought from being returned as the answer.
      { type: 'item.completed', item: { id: 'i-0', type: 'reasoning', text: 'considering the request' } },
      { type: 'item.completed', item: { id: 'i-1', type: 'agent_message', text: RESULT_TEXT } },
      { type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 22 } },
    ),
    expectedResult: RESULT_TEXT,
    expectedMetadata: {},
    // 11 + 22: `turn.completed` was already in this fixture because it is what
    // codex really prints, and M3.C is what finally reads it.
    expectedUsage: 33,
    reportedFailureStdout: jsonl(
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'error', message: 'stream disconnected before the turn finished' },
    ),
    expectedFailureDetail: 'stream disconnected before the turn finished',
  },
  {
    label: 'opencode',
    executorId: 'opencode',
    command: 'opencode',
    makeAdapter: (options) => createOpenCodeAdapter(options),
    promptDelivery: 'argument',
    payload: 'jsonl',
    expectedArgs: ['run', '--format', 'json', '--', PROMPT],
    okStdout: jsonl(
      { type: 'step_start', timestamp: 1, sessionID: 's-1', part: { type: 'step-start' } },
      { type: 'reasoning', timestamp: 2, sessionID: 's-1', part: { type: 'reasoning', text: 'thinking out loud' } },
      { type: 'text', timestamp: 3, sessionID: 's-1', part: { type: 'text', text: RESULT_TEXT } },
      { type: 'step_finish', timestamp: 4, sessionID: 's-1', part: { type: 'step-finish' } },
    ),
    expectedResult: RESULT_TEXT,
    expectedMetadata: { sessionID: 's-1' },
    reportedFailureStdout: jsonl({
      type: 'error',
      timestamp: 1,
      sessionID: 's-1',
      error: { name: 'ProviderAuthError', data: { message: 'missing api key' } },
    }),
    expectedFailureDetail: 'missing api key',
  },
])
