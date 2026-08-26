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
// Confinement, MEASURED (M4.A) by running the real binary and looking at the
// filesystem. The verdict has to be stated about the argv ABOVE, not about codex
// in general, and they differ:
//
// AS PANDA SHIPS IT, codex writes nothing at all. `codex exec` defaults to the
// `read-only` sandbox: asked to create a file it completes its turn and reports
// that write access is denied, leaving the workspace empty. So panda's workspace
// boundary is never tested by codex, and `panda run --executor codex` is a
// coding agent that cannot edit code. That is the fact a user meets, so that is
// the fact `test/confinement-live.test.ts` guards — with these exact args, and
// it goes red the day codex ships a writable default.
//
// MEASURED ONCE with `-s workspace-write`, which panda does not pass: codex
// wrote through `apply_patch` to an ABSOLUTE path resolved from its own cwd,
// ignoring a `PWD` aimed elsewhere. Recorded, NOT guarded — a standing check on
// argv panda never sends would be testing a configuration nobody ships.
// ponytail: if panda ever ships codex writable, that measurement becomes a
// claim and needs its own case.
//
// Also measured under `-s workspace-write`: told to write to an ABSOLUTE path
// outside the workspace, codex REFUSED — "I can't write outside the permitted
// workspace". That is codex's own sandbox, not panda's; claude, which panda runs
// with `--dangerously-skip-permissions`, wrote the same file without hesitating.
// So of the three, codex is the only one that enforces anything, and it does so
// by not writing at all in the mode panda ships.
//
// Loosening the shipped sandbox is a vendor-configuration decision, deliberately
// not taken here.
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
