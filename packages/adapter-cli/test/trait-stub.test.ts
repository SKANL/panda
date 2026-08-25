import { createCliExecutorAdapter } from '../src/traits.ts'
import type { ExecutorTraits } from '../src/traits.ts'
import { PROMPT, runExecutorClauseSuite } from './executor-suite.ts'

// FR-7/8/9/10 strategy isolation, PROVEN: this trait record is brand new — no
// engine, no shipped adapter and no spawn-seam code was touched to add it — and
// it passes the SAME clause suite as the three shipped adapters.
//
// It deliberately pairs the two axes in a combination NO shipped executor uses
// (positional prompt with a single-object payload, and no argument separator),
// so passing cannot be an accident of reusing an existing adapter's code path.

const STUB_TRAITS: ExecutorTraits = {
  executorId: 'stub-agent',
  command: 'stub-agent',
  args: Object.freeze(['--run', '--json']),
  promptDelivery: 'argument',
  output: {
    payload: 'single-object',
    resultPath: ['output', 'text'],
    errorFlagPath: ['failed'],
    errorMessagePath: ['reason'],
    metadata: { runId: ['run_id'] },
  },
}

runExecutorClauseSuite([
  {
    label: 'trait-only stub',
    executorId: 'stub-agent',
    command: 'stub-agent',
    makeAdapter: (options) => createCliExecutorAdapter(STUB_TRAITS, options),
    promptDelivery: 'argument',
    payload: 'single-object',
    expectedArgs: ['--run', '--json', PROMPT],
    okStdout: JSON.stringify({ run_id: 'r-1', output: { text: 'Stub finished the task.' } }),
    expectedResult: 'Stub finished the task.',
    expectedMetadata: { runId: 'r-1' },
    reportedFailureStdout: JSON.stringify({ failed: true, reason: 'the stub refused the task' }),
    expectedFailureDetail: 'the stub refused the task',
  },
])
