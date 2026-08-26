import { createCliExecutorAdapter } from '../traits.ts'
import type { CliExecutorAdapter, CliExecutorAdapterOptions, ExecutorTraits } from '../traits.ts'

// Codex trait record.
//
// `codex exec [OPTIONS] [PROMPT]` reads the instructions from STDIN when the
// positional PROMPT is omitted, and `--json` prints its ThreadEvent stream to
// stdout as JSONL.
//
// Result location, verified against codex-rs/exec/src/exec_events.rs: items
// arrive as `{"type":"item.completed","item":{…}}`, where `ThreadItemDetails`
// is serialized `#[serde(tag = "type", rename_all = "snake_case")]`. The answer
// is `AgentMessageItem { text }` at `item.type == "agent_message"`. The
// discriminator is NOT optional here: `ReasoningItem` also has a `text` field,
// so without it the scan would happily return the model's chain-of-thought as
// the result.
//
// `--skip-git-repo-check` is required because a panda workspace is not
// necessarily a git repository, and codex exec otherwise refuses to run. No cwd
// flag: the spawn seam already starts the child in `workspace.rootPath`.
//
// Failure shape: fatal problems arrive as `{"type":"error","message":"…"}`, so
// the status prefix rule matches on `type` and the detail comes from `message`.
//
// Usage, VERIFIED by running `codex exec --json --skip-git-repo-check`
// (codex-cli 0.149.1) and reading its own stdout: usage is NOT on the answer
// item. It arrives on a later event of its own,
//   {"type":"turn.completed","usage":{input_tokens, cached_input_tokens,
//    cache_write_input_tokens, output_tokens, reasoning_output_tokens}}
// Observed on a one-word task: 28451 / 6912 / 0 / 61 / 54. Only `input_tokens`
// and `output_tokens` are summed: `cached_input_tokens` is a BREAKDOWN of the
// input already counted (6912 of the 28451), and `reasoning_output_tokens` is
// likewise a share of the output. Codex says so itself — its session rollout
// records `total_tokens` as input + output with the cached figure EXCLUDED
// (27189 = 27184 + 5 on a measured run); summing it would have billed 53557 for
// a 28512-token turn.
//
// `usageWhen` pins the sum to `turn.completed`. `codex exec` runs one turn, so
// today that is one record; summing across them is the right answer if a future
// stream reports more, because each carries its own turn's spend.

export const CODEX_TRAITS: ExecutorTraits = {
  executorId: 'codex',
  command: 'codex',
  args: Object.freeze(['exec', '--json', '--skip-git-repo-check']),
  promptDelivery: 'stdin',
  output: {
    payload: 'jsonl',
    resultPath: ['item', 'text'],
    resultWhen: { path: ['item', 'type'], equals: 'agent_message' },
    statusPath: ['type'],
    errorStatusPrefix: 'error',
    errorMessagePath: ['message'],
    usageWhen: { path: ['type'], equals: 'turn.completed' },
    usagePaths: [
      ['usage', 'input_tokens'],
      ['usage', 'output_tokens'],
    ],
  },
}

export function createCodexAdapter(options: CliExecutorAdapterOptions = {}): CliExecutorAdapter {
  return createCliExecutorAdapter(CODEX_TRAITS, options)
}
