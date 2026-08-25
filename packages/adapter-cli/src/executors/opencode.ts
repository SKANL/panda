import { createCliExecutorAdapter } from '../traits.ts'
import type { CliExecutorAdapter, CliExecutorAdapterOptions, ExecutorTraits } from '../traits.ts'

// OpenCode trait record.
//
// `opencode run [message..]` takes the prompt as a POSITIONAL argument — there
// is no stdin path — and `--format json` streams raw JSON events, one per line.
// `--` separates the prompt from the flags so a prompt starting with `-` is not
// parsed as one; `run` joins everything after it into the message.
//
// Result location: every event shares the envelope `{type, timestamp,
// sessionID, …}`, and assistant output arrives as
// `{"type":"text","part":{"type":"text","text":"…"}}`. The `part.type` guard
// matters because `reasoning` events (emitted with `--thinking`) carry a `part`
// with a `text` field too. The `step_finish` event that follows carries no
// text, so the scan steps over it either way.
//
// Failure shape: `{"type":"error","error":{…}}` — the detail is an OBJECT, which
// the engine stringifies rather than dropping. OpenCode also emits RECOVERABLE
// error events and keeps going, which is why failure detection is non-positional.

export const OPENCODE_TRAITS: ExecutorTraits = {
  executorId: 'opencode',
  command: 'opencode',
  args: Object.freeze(['run', '--format', 'json']),
  promptDelivery: 'argument',
  promptArgSeparator: '--',
  output: {
    payload: 'jsonl',
    resultPath: ['part', 'text'],
    resultWhen: { path: ['part', 'type'], equals: 'text' },
    statusPath: ['type'],
    errorStatusPrefix: 'error',
    errorMessagePath: ['error'],
    metadata: { sessionID: ['sessionID'] },
  },
}

export function createOpenCodeAdapter(options: CliExecutorAdapterOptions = {}): CliExecutorAdapter {
  return createCliExecutorAdapter(OPENCODE_TRAITS, options)
}
