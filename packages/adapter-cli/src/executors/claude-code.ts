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
//
// Usage, VERIFIED by running `claude --print --output-format json` (2.1.246) and
// reading its own stdout: the result object carries a `usage` object with
//   input_tokens, output_tokens,
//   cache_creation_input_tokens, cache_read_input_tokens
// Observed on a one-word task: 2 / 4 / 42206 / 17630. The four are DISJOINT, and
// the vendor's own printout proves it rather than the name suggesting it: pricing
// each component at its own published rate reconstructs the `total_cost_usd` the
// same payload reports, to the last digit. `input_tokens` counts only the uncached
// input, so charging it alone would have priced that run at 2 tokens instead of
// 59842 — the budget figure is their sum.
//
// The one result object is the only record here, and `usageWhen` pins it to
// `type == "result"` so a future print-mode event carrying a `usage` of its own
// cannot join the sum.
//
// Confinement, MEASURED (M4.A) by running the real binary and looking at the
// filesystem, not by reading a flag: told to create a file, claude created it in
// the cwd it was spawned in while `PWD` named a directory OUTSIDE that cwd and
// `INIT_CWD` a third one. claude resolves the write against its cwd. It confines
// a workspace-relative write, which is not the same as being confined: MEASURED
// in the same story, claude asked for an ABSOLUTE path outside the workspace
// created the file there without hesitating. panda runs it with
// `--dangerously-skip-permissions` and spawns an ordinary child with the user's
// own privileges, so there is nothing between the two. Epic 4 inherits that.
//
// `test/confinement-live.test.ts` keeps this true, and it spawns claude
// deliberately OUTSIDE panda's spawner to do it: panda now hands every child a
// `PWD` equal to its cwd, so a claude that started following `$PWD` tomorrow
// would still land in the workspace and a through-panda check could never
// notice. The lie has to reach the child for the claim to be falsifiable.
//
// The same payload also reports `total_cost_usd` and a per-model `modelUsage`
// (which restates the four figures under different spellings, and is what the live
// check reads as an INDEPENDENT oracle); money is Ask-First, so neither ships.

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
    usageWhen: { path: ['type'], equals: 'result' },
    usagePaths: [
      ['usage', 'input_tokens'],
      ['usage', 'output_tokens'],
      ['usage', 'cache_creation_input_tokens'],
      ['usage', 'cache_read_input_tokens'],
    ],
  },
}

export function createClaudeCodeAdapter(options: CliExecutorAdapterOptions = {}): CliExecutorAdapter {
  return createCliExecutorAdapter(CLAUDE_CODE_TRAITS, options)
}
