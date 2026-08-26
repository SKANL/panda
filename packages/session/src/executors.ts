import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CLAUDE_CODE_TRAITS,
  CODEX_TRAITS,
  OPENCODE_TRAITS,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createOpenCodeAdapter,
} from '@panda/adapter-cli'
import type { CliExecutorAdapter, CliExecutorAdapterOptions, ExecutorTraits } from '@panda/adapter-cli'
import { PANDA_ERROR_CODES, PandaError, isRecord } from '@panda/contracts'
import { createLayeredConfig } from '@panda/kernel'
import type { ConfigLayer, LayeredConfig } from '@panda/kernel'

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
 * codex's traits to opencode's constructor — so `test/executors.test.ts` builds
 * every entry and asserts the ADAPTER answers with the key it was found under.
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

/** The key panda reads out of its configuration document. */
export const EXECUTOR_CONFIG_KEY = 'executor'

// ponytail: `.panda/config.json` is spelled here rather than imported from
// `@panda/environment`, which owns the same `<scope>/.panda` convention. That
// package is CONSUMER tier and so is this one, and `packages/session/test/
// guard.test.ts` pins @panda/session's dependency set to exactly four packages —
// so reaching for it would be an AD-2 violation the gate rejects, not a reuse.
// Upgrade path: move the scope-directory convention down into `@panda/contracts`
// (shared tier) and have both consumers read it from there. Recorded in the
// spec's Spec Change Log.
const PANDA_STATE_DIR = '.panda'
const CONFIG_FILE = 'config.json'

// The two errnos that mean "there is no such document", including a parent that
// is not a directory (win32 reports that as ENOENT, POSIX as ENOTDIR). Every
// other errno means something IS there and panda could not read it, which is an
// error rather than an absent layer.
const ABSENT_ERRNOS = new Set(['ENOENT', 'ENOTDIR'])

// A UTF-8 byte order mark, written as an escape. `readFile(path, 'utf8')` does
// not strip one and `JSON.parse` rejects it, so three invisible bytes brick a
// document whose visible contents are correct — and PowerShell 5.1's `>` and
// `Set-Content`, Notepad, and VS Code's "UTF-8 with BOM" all emit one by default
// on the platform this repo is developed on. `packages/adapter-cli/src/traits.ts`
// strips the same mark off executor stdout for the same reason.
const BYTE_ORDER_MARK = '\uFEFF'

/** Panda's own configuration document for a scope root. */
export function executorConfigPath(scopeDir: string): string {
  return join(scopeDir, PANDA_STATE_DIR, CONFIG_FILE)
}

export interface ResolveExecutorOptions {
  /**
   * Explicit override for this invocation, e.g. `panda run --executor codex`.
   * Set as the `invocation` LAYER, so it wins over both documents and is
   * reported as having done so. Omitted, no invocation layer exists at all.
   */
  readonly executorId?: string
  /**
   * Root of the machine scope; `<homeDir>/.panda/config.json` is the `global`
   * layer. A SEAM: it defaults to the OS home directory in production and every
   * test points it at a temp directory, because a suite whose result depends on
   * the `~/.panda` of whoever runs it passes and fails for reasons having
   * nothing to do with the code.
   */
  readonly homeDir?: string
  /**
   * Root of the project scope; `<projectDir>/.panda/config.json` is the
   * `project` layer. The same seam, defaulting to `process.cwd()`.
   */
  readonly projectDir?: string
}

export interface ExecutorSelection {
  /** The id that won; always a key of `EXECUTOR_CATALOGUE`. */
  readonly executorId: string
  /**
   * The layer that supplied it, taken from the layered config's OWN `dump()`.
   * Never recomputed here: provenance derived a second time is how a report
   * starts disagreeing with the thing it reports on.
   */
  readonly layer: ConfigLayer
  /**
   * Every id a selection may name. Here for a host that offers a CHOICE and has
   * to render one; `@panda/cli` does not print it, because on the one path where
   * a user needs the list — an id panda has no adapter for — the coded error's
   * own message already carries it.
   */
  readonly available: readonly string[]
}

function unusable(filePath: string, detail: string, cause?: unknown): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.configurationUnusable,
    `panda's configuration at '${filePath}' cannot be used: ${detail}`,
    cause === undefined ? undefined : { cause },
  )
}

function unknownExecutor(executorId: string): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.executorNotFound,
    `panda has no adapter named '${executorId}'; available executors: ${availableExecutorIds().join(', ')}`,
  )
}

function blankExecutor(): PandaError {
  return new PandaError(
    PANDA_ERROR_CODES.executorNotFound,
    `an executor id must name one of: ${availableExecutorIds().join(', ')}, but it is blank`,
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A caller-supplied scope root, absolute and non-empty.
 *
 * `homeDir: ''` — which is exactly `process.env.HOME ?? ''` in a consumer, and
 * the shape Story 2.7a was bitten by — makes `join('', '.panda', …)` RELATIVE,
 * so the machine scope silently relocates into the working directory and the
 * PROJECT's own document is then reported as the `global` layer. That is a false
 * claim on the one output this story exists to make trustworthy, so it is
 * refused with the same code `@panda/environment` refuses it with.
 */
function scopeRoot(label: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PandaError(
      PANDA_ERROR_CODES.environmentScopeUnavailable,
      `${label} must be a non-empty path, but panda was given ${JSON.stringify(value)}`,
    )
  }
  return resolve(value)
}

/** True when SOMETHING is at this path, target reachable or not. */
async function entryExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch {
    return false
  }
}

/** What a JSON value IS, for a message that tells the user what to fix. */
function describeJson(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/**
 * One configuration document, or `undefined` when there is none.
 *
 * The distinction this draws is the whole feature: a MISSING document is an
 * absent layer, and a document that exists but cannot be used is a coded error.
 * Reading a corrupt file and shrugging back to the default runs a different
 * agent than the user configured, silently — which is the failure executor
 * selection exists to remove, not a robustness feature.
 *
 * The `executor` key is type-checked here rather than after composition because
 * the layer that CARRIES the bad value is the one whose path the user has to be
 * told; once merged, the offending document is no longer identifiable.
 */
async function readConfigDocument(filePath: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code
    if (code !== undefined && ABSENT_ERRNOS.has(code)) {
      // `readFile` FOLLOWS symlinks, so a DANGLING link reports ENOENT exactly
      // like a file that was never there — and every dotfile manager (stow,
      // chezmoi, dotbot) materialises panda's config as a symlink, whose
      // canonical failure is a broken target. `lstat` looks at the ENTRY rather
      // than at the target, which is the one thing that tells the two apart.
      // This is the only present-but-unusable state that would otherwise fall
      // back to a different agent in silence.
      if (await entryExists(filePath)) {
        throw unusable(
          filePath,
          'it exists but its target cannot be read (a dangling symbolic link, or it was removed mid-read)',
          error,
        )
      }
      return undefined
    }
    throw unusable(filePath, `it could not be read (${code ?? 'unknown error'})`, error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text)
  } catch (error) {
    throw unusable(filePath, 'it is not valid JSON', error)
  }
  if (!isRecord(parsed)) {
    throw unusable(filePath, `it must hold a JSON object, but it holds ${describeJson(parsed)}`)
  }
  const selected: unknown = parsed[EXECUTOR_CONFIG_KEY]
  if (selected !== undefined && typeof selected !== 'string') {
    throw unusable(
      filePath,
      `'${EXECUTOR_CONFIG_KEY}' must be a string naming one of: ${availableExecutorIds().join(', ')}, but it is ${describeJson(selected)}`,
    )
  }
  if (typeof selected === 'string') {
    // Normalised here so a value an editor appended a newline to still works,
    // and so a blank one is named for what it is instead of reaching the
    // catalogue as `'   '` and being reported as a missing ADAPTER — which sends
    // the user looking for an installation rather than for a typo.
    const trimmed = selected.trim()
    if (trimmed.length === 0) {
      throw unusable(
        filePath,
        `'${EXECUTOR_CONFIG_KEY}' is blank; it must name one of: ${availableExecutorIds().join(', ')}`,
      )
    }
    parsed[EXECUTOR_CONFIG_KEY] = trimmed
  }
  return parsed
}

/**
 * Reads one document into one layer, or leaves the layer absent.
 *
 * The `setLayer` call is WRAPPED because the kernel's validation is what rejects
 * a hostile document, and it names the offending KEY rather than the file: a
 * `__proto__` key in the machine document and in the project document produced
 * byte-identical stderr naming neither, and an unbounded nesting depth (~3000
 * levels) produced a bare `RangeError` carrying no `code` at all — an UNCODED
 * crash on the exact input class the matrix says must be refused coded. The
 * kernel's own error travels on as the `cause`, so its code is preserved in the
 * chain rather than swallowed.
 */
async function applyDocument(
  config: LayeredConfig,
  layer: 'global' | 'project',
  filePath: string,
): Promise<void> {
  const document = await readConfigDocument(filePath)
  if (document === undefined) return
  try {
    config.setLayer(layer, document)
  } catch (error) {
    throw unusable(filePath, `the '${layer}' configuration layer rejected it: ${describeError(error)}`, error)
  }
}

/**
 * Which executor this run uses, resolved through the kernel's layered
 * configuration: `defaults` → `global` → `project` → `invocation`.
 *
 * This — not `runSession` — is what reads the filesystem. A session primitive
 * whose behaviour depends on files under the running user's home is not usable
 * from a host that already knows what it wants, and it would make every existing
 * `panda run` test depend on the `~/.panda` of whoever ran the suite.
 *
 * Ships from `@panda/session` beside `runSession`, so FR-29 holds: a third party
 * imports this package and gets the selection AND the run, with no CLI involved.
 */
export async function resolveExecutor(options: ResolveExecutorOptions = {}): Promise<ExecutorSelection> {
  // Every field read ONCE, before the first await, for the same reason
  // `runSession` does it: a live read after control has returned to the caller's
  // event loop lets an accessor answer with a temp directory now and the real
  // home directory later.
  const { executorId, homeDir = homedir(), projectDir = process.cwd() } = options
  const home = scopeRoot('the home directory', homeDir)
  const project = scopeRoot('the project directory', projectDir)

  const config = createLayeredConfig()
  // Panda's built-in default is a LAYER, never a constructor fallback. That is
  // what makes "nothing configured" a reportable provenance rather than an
  // invisible branch.
  config.setLayer('defaults', { [EXECUTOR_CONFIG_KEY]: DEFAULT_EXECUTOR_ID })

  // Documents go in whole, not just their `executor` key: `setLayer` is what
  // rejects a prototype-polluting document, and it can only reject what it sees.
  await applyDocument(config, 'global', executorConfigPath(home))
  // Running panda FROM your home directory is ONE document, not two. Loading it
  // into both layers reported `project` as the deciding layer for a project that
  // does not exist — a false provenance on the one line this story adds.
  if (project !== home) await applyDocument(config, 'project', executorConfigPath(project))
  if (executorId !== undefined) {
    const requested = executorId.trim()
    if (requested.length === 0) throw blankExecutor()
    config.setLayer('invocation', { [EXECUTOR_CONFIG_KEY]: requested })
  }

  // The value AND its provenance from ONE dump entry, so the two cannot disagree.
  const decided = config
    .dump()
    .find((entry) => entry.path.length === 1 && entry.path[0] === EXECUTOR_CONFIG_KEY)
  if (decided === undefined || typeof decided.value !== 'string') {
    // Unreachable while `defaults` supplies a string at this path and every
    // narrower layer was type-checked at its OWN file. Coded rather than
    // asserted, because the alternative to a message here is `undefined`
    // reaching the catalogue — and it names NO path, because the one it used to
    // guess was the project's, which told the user to fix a file that was fine.
    throw new PandaError(
      PANDA_ERROR_CODES.configurationUnusable,
      `panda could not resolve an '${EXECUTOR_CONFIG_KEY}' selection through its configuration layers`,
    )
  }
  if (!EXECUTOR_CATALOGUE.has(decided.value)) throw unknownExecutor(decided.value)
  return { executorId: decided.value, layer: decided.layer, available: availableExecutorIds() }
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
