import { PANDA_ERROR_CODES, PandaError } from '@skanl/panda-contracts'
import { CLAUDE_CODE_TRAITS, createClaudeCodeAdapter } from './executors/claude-code.ts'
import { CODEX_TRAITS, createCodexAdapter } from './executors/codex.ts'
import { OPENCODE_TRAITS, createOpenCodeAdapter } from './executors/opencode.ts'
import type { CliExecutorAdapter, CliExecutorAdapterOptions, ExecutorTraits } from './traits.ts'

/**
 * One shipped adapter: its OWN trait record, and the factory that builds it.
 *
 * The pair is what the catalogue stores, and the trait record is what supplies
 * the key. There is deliberately no `id` field here to write beside it — a
 * second spelling of the name is the thing this file exists to prevent.
 */
export interface ShippedExecutor {
  readonly traits: ExecutorTraits
  readonly create: (options?: CliExecutorAdapterOptions) => CliExecutorAdapter
}

const SHIPPED: readonly ShippedExecutor[] = [
  { traits: CLAUDE_CODE_TRAITS, create: createClaudeCodeAdapter },
  { traits: CODEX_TRAITS, create: createCodexAdapter },
  { traits: OPENCODE_TRAITS, create: createOpenCodeAdapter },
]

/**
 * Every adapter panda ships, keyed by each adapter's own `executorId` TRAIT.
 *
 * Keyed from the traits, never from a list of string literals written beside
 * them: Story 2.7a shipped an executor that was never once exercised because a
 * parallel name list drifted from the thing it named. A name that exists here is
 * a name whose trait record supplied it, so a fourth adapter appears by being
 * shipped rather than by being listed twice.
 *
 * The key alone does not close the whole hole — a mis-paired factory would key
 * codex's traits to opencode's constructor — so `packages/session/test/executors.test.ts`
 * builds every entry and asserts the ADAPTER answers with the key it was found under.
 *
 * It lives HERE rather than in `@skanl/panda-session` since M3.B: the executor plugin
 * turns a configured id into an adapter, and a plugin whose package could not
 * perform its own lookup would have to be handed a constructor by whoever
 * mounted it — which is the direct construction this story exists to remove.
 * `@skanl/panda-session` re-exports the whole set, so its callers see no move.
 */
export const EXECUTOR_CATALOGUE: ReadonlyMap<string, ShippedExecutor> = new Map(
  SHIPPED.map((executor) => [executor.traits.executorId, executor]),
)

/**
 * What panda runs when nothing selects otherwise. Taken from the trait record,
 * so it is one of the catalogue's own keys by construction, and used as the
 * `defaults` LAYER rather than as a constructor fallback — the difference being
 * that a layer can be overridden and reported on, and a constructor cannot.
 */
export const DEFAULT_EXECUTOR_ID: string = CLAUDE_CODE_TRAITS.executorId

/** Every id a selection may name, in catalogue order. */
export function availableExecutorIds(): readonly string[] {
  return [...EXECUTOR_CATALOGUE.keys()]
}

/** Panda ships no adapter under the name that was asked for. */
export function unknownExecutor(executorId: string): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.executorNotFound,
    `panda has no adapter named '${executorId}'; available executors: ${availableExecutorIds().join(', ')}`,
  )
}

/**
 * The adapter for one catalogue id, or panda's default when none is named.
 *
 * The default flows from `DEFAULT_EXECUTOR_ID` through the same catalogue lookup
 * every other id takes, so there is no path on which a hardcoded constructor
 * runs. An id the catalogue does not hold is a coded failure, never a fallback.
 *
 * `options` is the adapter's OWN seam — a child-process spawner, or a binary
 * path that overrides the trait's command. `SessionOptions.adapterOptions`
 * threads it through from `runSession` and from `panda run`, so it is a live
 * seam rather than flexibility no caller could reach.
 */
export function createExecutorAdapter(
  executorId: string = DEFAULT_EXECUTOR_ID,
  options?: CliExecutorAdapterOptions,
): CliExecutorAdapter {
  const shipped = EXECUTOR_CATALOGUE.get(executorId)
  if (shipped === undefined) throw unknownExecutor(executorId)
  return shipped.create(options)
}
