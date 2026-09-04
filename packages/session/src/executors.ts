import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_EXECUTOR_ID,
  EXECUTOR_CATALOGUE,
  EXECUTOR_CONFIG_KEY,
  availableExecutorIds,
  createExecutorAdapter,
  unknownExecutor,
} from '@panda/adapter-cli'
import type { CliExecutorAdapterOptions, ShippedExecutor } from '@panda/adapter-cli'
import { METHOD_CONFIG_KEY, PANDA_ERROR_CODES, PandaError, isRecord } from '@panda/contracts'
import { createLayeredConfig, deepMerge } from '@panda/kernel'
import type { ConfigLayer, LayeredConfig } from '@panda/kernel'

// Executor SELECTION: which shipped adapter this run uses, decided through the
// layered configuration panda already owns.
//
// The catalogue itself moved to `@panda/adapter-cli` with Story M3.B — the
// package that ships the three adapters is the one whose kernel plugin has to
// turn a configured id into one. It is re-exported here unchanged, because
// `@panda/session` is the FR-29 surface: a consumer that installed only this
// package still gets the whole selection vocabulary from one import.
export {
  DEFAULT_EXECUTOR_ID,
  EXECUTOR_CATALOGUE,
  // Re-exported, never re-declared. A second `const EXECUTOR_CONFIG_KEY` lived
  // here and a third literal lived in `run-session.ts`, so the REPORTED
  // selection and the MOUNTED adapter were derived independently from the same
  // document: renaming one produced `executor: codex (selected by the 'project'
  // layer)` on stderr while `claude` was spawned, exit 0. This package's whole
  // catalogue design exists because a second spelling drifted from the thing it
  // named; the key gets the same treatment.
  EXECUTOR_CONFIG_KEY,
  availableExecutorIds,
  createExecutorAdapter,
  type ShippedExecutor,
}
export type { CliExecutorAdapterOptions }

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
 * Marks a document `readExecutorConfigLayers` actually read off disk.
 *
 * Module-private and unforgeable from outside this file. The layer a selection
 * is reported under is the one printed on stderr — "a swap you cannot see is not
 * one you can trust" — and without this brand a caller could hand `runSession` a
 * document it invented, name it `project`, and have `panda run` print
 * `selected by the 'project' layer` for a file that does not exist. A supplied
 * document is composed into the `agent` layer instead: still narrower than the
 * project document, still reported honestly as coming from the running host.
 */
const READ_FROM_DISK = Symbol('panda.executor-config.read-from-disk')

/** One of panda's own configuration documents, and where it came from. */
export interface ExecutorConfigDocument {
  /** The path it was read from, so a layer that rejects it can name the file. */
  readonly filePath: string
  readonly document: unknown
}

function readDocument(filePath: string, document: unknown): ExecutorConfigDocument {
  return { filePath, document, [READ_FROM_DISK]: true } as ExecutorConfigDocument
}

function wasReadFromDisk(entry: ExecutorConfigDocument): boolean {
  return (entry as { [READ_FROM_DISK]?: unknown })[READ_FROM_DISK] === true
}

/**
 * Panda's own documents, READ but not yet composed.
 *
 * This exists so the documents are read ONCE per run. Story M3.B made the
 * kernel's layered configuration the one the mounted plugins read, and the
 * kernel is constructed inside `runSession` — so a caller that resolved a
 * selection first and then ran would have read `.panda/config.json` twice, with
 * a window between them in which the two could disagree. Handing the SNAPSHOTS
 * forward closes that window: `seedExecutorConfig` composes them into whichever
 * configuration is going to be used, and nothing re-reads a file.
 */
export interface ExecutorConfigLayers {
  /**
   * Values composed UNDER panda's own built-in default, so any document can
   * still override them. `@panda/session` puts its computed workspace root here
   * when the caller named no `cwd`, which is what lets a user's
   * `workspace.rootDir` actually decide the directory.
   */
  readonly defaults?: unknown
  /** `<homeDir>/.panda/config.json`, when it exists. */
  readonly global?: ExecutorConfigDocument
  /** `<projectDir>/.panda/config.json`, when it exists and is not the machine one. */
  readonly project?: ExecutorConfigDocument
  /** This invocation's explicit override, e.g. `panda run --executor codex`. */
  readonly invocation?: unknown
}

/**
 * Reads panda's own documents into layer snapshots. The ONLY filesystem access
 * in executor selection.
 *
 * A MISSING document is an absent layer. A document that exists and cannot be
 * used is a coded error — reading a corrupt file and shrugging back to the
 * default runs a different agent than the user configured, silently, which is
 * the failure this selection exists to remove.
 */
export async function readExecutorConfigLayers(
  options: ResolveExecutorOptions = {},
): Promise<ExecutorConfigLayers> {
  // Every field read ONCE, before the first await, for the same reason
  // `runSession` does it: a live read after control has returned to the caller's
  // event loop lets an accessor answer with a temp directory now and the real
  // home directory later.
  const { executorId, homeDir = homedir(), projectDir = process.cwd() } = options
  const home = scopeRoot('the home directory', homeDir)
  const project = scopeRoot('the project directory', projectDir)

  const layers: { global?: ExecutorConfigDocument; project?: ExecutorConfigDocument; invocation?: unknown } = {}
  // Documents go in whole, not just their `executor` key: `setLayer` is what
  // rejects a prototype-polluting document, and it can only reject what it sees.
  const globalPath = executorConfigPath(home)
  const globalDocument = await readConfigDocument(globalPath)
  if (globalDocument !== undefined) layers.global = readDocument(globalPath, globalDocument)
  // Running panda FROM your home directory is ONE document, not two. Loading it
  // into both layers reported `project` as the deciding layer for a project that
  // does not exist — a false provenance on the one line this story adds.
  if (project !== home) {
    const projectPath = executorConfigPath(project)
    const projectDocument = await readConfigDocument(projectPath)
    if (projectDocument !== undefined) layers.project = readDocument(projectPath, projectDocument)
  }
  if (executorId !== undefined) {
    const requested = executorId.trim()
    if (requested.length === 0) throw blankExecutor()
    layers.invocation = { [EXECUTOR_CONFIG_KEY]: requested }
  }
  return layers
}

/**
 * Composes panda's defaults and the given documents into ONE layered
 * configuration: `defaults` -> `global` -> `project` -> `invocation`.
 *
 * The `setLayer` calls are WRAPPED because the kernel's validation is what
 * rejects a hostile document, and it names the offending KEY rather than the
 * file: a `__proto__` key in the machine document and in the project document
 * produced byte-identical stderr naming neither, and an unbounded nesting depth
 * (~3000 levels) produced a bare `RangeError` carrying no `code` at all — an
 * UNCODED crash on the exact input class the matrix says must be refused coded.
 * The kernel's own error travels on as the `cause`, so its code is preserved in
 * the chain rather than swallowed.
 *
 * Since Story M3.B this is what seeds the KERNEL's configuration, so the mounted
 * plugins and the executor selection read one composed document rather than two.
 */
/**
 * A key panda READ off disk and refused to admit into its layer, with what it
 * is running instead.
 *
 * Typed rather than logged, because AD-5 is "typed absence over silence" and its
 * opposite of IGNORED is TYPED AND REPORTED, not FATAL. The guard this replaces
 * read that as a binary -- "REFUSED rather than ignored, per AD-5" -- and made a
 * cloned repository able to deny service to the machine owner's own selection.
 * `using` is `undefined` when nothing else selects one, which is a different
 * sentence and has to stay tellable apart.
 */
export interface DeclinedConfigKey {
  readonly key: 'method'
  /** What the project document recommended, verbatim. */
  readonly specifier: string
  /** The document that recommended it, so the notice can name the file. */
  readonly filePath: string
  /** What decides instead, taken from the COMPOSED view rather than guessed. */
  readonly using: string | undefined
}

export function seedExecutorConfig(
  config: LayeredConfig,
  layers: ExecutorConfigLayers = {},
): DeclinedConfigKey | undefined {
  // Panda's built-in default is a LAYER, never a constructor fallback. That is
  // what makes "nothing configured" a reportable provenance rather than an
  // invisible branch. Caller-supplied defaults compose UNDER it, so a document
  // still wins over both.
  config.setLayer('defaults', deepMerge(layers.defaults ?? {}, { [EXECUTOR_CONFIG_KEY]: DEFAULT_EXECUTOR_ID }))
  // A document panda READ goes into the layer its file belongs to. A document a
  // caller merely handed over goes into `agent` — the layer for "the running
  // host supplied this" — so the provenance panda reports can never be a claim
  // the caller made up. Two supplied documents compose in the same order.
  let supplied: unknown
  let recommendation: { specifier: string; filePath: string } | undefined
  for (const layer of ['global', 'project'] as const) {
    const entry = layers[layer]
    if (entry === undefined) continue
    if (!wasReadFromDisk(entry)) {
      supplied = supplied === undefined ? entry.document : deepMerge(supplied, entry.document)
      continue
    }
    // A PROJECT RECOMMENDS A METHOD; IT DOES NOT SELECT ONE, so the key never
    // becomes part of this layer.
    //
    // `assertMethodMayMount` refuses a project-layer method because importing it
    // is running a cloned repository's code. That refusal was FATAL, and driven
    // at 220f288 it was wider than the threat: the run stopped whatever else was
    // configured, so a clone carrying the key denied service to a method the
    // MACHINE's owner had selected, with hand-editing JSON as the only exit --
    // the one answer `config-write.ts:10-12` says the product exists to remove.
    //
    // DROPPED HERE RATHER THAN AT SELECTION, and that was measured. The obvious
    // shape is `selectMethod` falling back through `snapshot('global')`, but
    // `snapshot()` has ZERO production consumers outside the kernel's own
    // definition, so that would make the method selection the product's only
    // layer-by-layer reader. Dropping before composition costs no new resolution
    // rule at all -- and it keeps `dump()` honest, which is the real prize: the
    // composed view says what panda ACTED ON, and a gate pins that no entry ever
    // reports `method` decided by `project`.
    //
    // Only a document READ FROM DISK reaches here; one a host supplied composes
    // into `agent`, which is that host's own code and stays mountable.
    let document = entry.document
    if (layer === 'project' && isRecord(document) && typeof document[METHOD_CONFIG_KEY] === 'string') {
      const { [METHOD_CONFIG_KEY]: recommended, ...rest } = document
      document = rest
      recommendation = { specifier: recommended as string, filePath: entry.filePath }
    }
    try {
      config.setLayer(layer, document)
    } catch (error) {
      throw unusable(entry.filePath, `the '${layer}' configuration layer rejected it: ${describeError(error)}`, error)
    }
  }
  if (supplied !== undefined) {
    try {
      config.setLayer('agent', supplied)
    } catch (error) {
      throw new PandaError(
        PANDA_ERROR_CODES.configurationUnusable,
        `the configuration this host supplied cannot be used: the 'agent' layer rejected it: ${describeError(error)}`,
        { cause: error },
      )
    }
  }
  if (layers.invocation !== undefined) config.setLayer('invocation', layers.invocation)

  if (recommendation === undefined) return undefined
  // WHAT IS USED INSTEAD IS READ FROM THE COMPOSED VIEW, NOT GUESSED. Reading
  // `layers.global` would be a second answer to "which layer decides", and two
  // answers is how the notice ends up naming a value the run does not use -- the
  // exact failure `selectExecutor` takes value and provenance from ONE entry to
  // avoid.
  const decided = config.dump().find((entry) => entry.path.length === 1 && entry.path[0] === METHOD_CONFIG_KEY)
  const using = typeof decided?.value === 'string' ? decided.value : undefined
  // FOLLOWING THE ADVICE HAS TO SILENCE THE NOTICE.
  // `panda swap method ./mine.mjs` run from the project stores the RESOLVED
  // absolute path, so a user who adopted the recommendation would otherwise be
  // told it was declined on every run, forever. Advice that nags after being
  // taken is the same defect class as advice that does nothing, and this
  // milestone found that one twice.
  //
  // `dirname` twice because the project document is `<projectDir>/.panda/config.json`.
  if (using !== undefined && resolve(dirname(dirname(recommendation.filePath)), recommendation.specifier) === using) {
    return undefined
  }
  return { key: METHOD_CONFIG_KEY, specifier: recommendation.specifier, filePath: recommendation.filePath, using }
}

/**
 * The selection an already-seeded configuration decides, with the layer that
 * decided it. Pure: it reads the composed view and touches no file.
 */
export function selectExecutor(config: LayeredConfig): ExecutorSelection {
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
 * Which executor this run uses, resolved through the kernel's layered
 * configuration: `defaults` -> `global` -> `project` -> `invocation`.
 *
 * This — not `runSession` — is what reads the filesystem. A session primitive
 * whose behaviour depends on files under the running user's home is not usable
 * from a host that already knows what it wants, and it would make every existing
 * `panda run` test depend on the `~/.panda` of whoever ran the suite.
 *
 * Ships from `@panda/session` beside `runSession`, so FR-29 holds: a third party
 * imports this package and gets the selection AND the run, with no CLI involved.
 *
 * `panda run` does NOT call this: it reads the layers once and hands them to
 * `runSession`, which seeds the KERNEL's configuration and selects from that one
 * composed document. The three steps are exactly the three this function performs.
 */
export async function resolveExecutor(options: ResolveExecutorOptions = {}): Promise<ExecutorSelection> {
  const layers = await readExecutorConfigLayers(options)
  const config = createLayeredConfig()
  seedExecutorConfig(config, layers)
  return selectExecutor(config)
}
