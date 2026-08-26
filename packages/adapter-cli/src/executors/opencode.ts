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
//
// Usage, VERIFIED by running `opencode run --format json` (1.18.23) and reading
// its own stdout: the `step_finish` event carries
//   part.tokens = { total, input, output, reasoning, cache: { write, read } }
// and `total` is opencode's OWN sum of its own components — on a one-word task,
// total 42599 = input 34390 + output 17 + reasoning 0 + cache.write 0 +
// cache.read 8192.
//
// `step_finish` is emitted PER STEP and each `total` is that step's own spend,
// not a running one. Measured on a three-step task: 42770, 42875 and 43025, each
// equal to its own components, for a run that really cost 128670. Taking the last
// record billed 43025, and a run whose final step is a one-line answer bills
// almost nothing — so the engine sums every `step_finish`, and `usageWhen` is
// what bounds which records join that sum.
//
// The event also carries `cost`, which is money and Ask-First.

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
    usageWhen: { path: ['type'], equals: 'step_finish' },
    usagePaths: [['part', 'tokens', 'total']],
  },
}

export function createOpenCodeAdapter(options: CliExecutorAdapterOptions = {}): CliExecutorAdapter {
  return createCliExecutorAdapter(OPENCODE_TRAITS, options)
}
