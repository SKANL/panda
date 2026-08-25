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
  },
}

export function createCodexAdapter(options: CliExecutorAdapterOptions = {}): CliExecutorAdapter {
  return createCliExecutorAdapter(CODEX_TRAITS, options)
}
