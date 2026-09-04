import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * The FR-29 proof THAT CAN FAIL.
 *
 * `consumer.test.ts` beside this file makes the same claim — "anything the CLI
 * can do, a third party can do by importing packages" — and cannot be wrong
 * about it: it imports `../src/index.ts`, so pnpm's workspace links answer no
 * matter what the export map, the build or the tarball say. This file installs
 * BUILT TARBALLS into a project outside the repository and runs a real session
 * there, so it fails when the PACKAGED artifact is wrong rather than when the
 * monorepo is.
 *
 * Not run by `pnpm test`: the filename ends in `.proof.ts`, which vitest's
 * default `*.test.ts` include does not match, and it is reached only through
 * `vitest.consumer-install.config.ts` (`pnpm proof:consumer-install`, and the
 * `proof` job in `.github/workflows/ci.yml`).
 *
 * It does NOT skip itself when the environment looks unhelpful. A missing or
 * broken `pnpm` FAILS here, because the two green outcomes — "seven assertions
 * held" and "seven assertions never ran" — used to differ only by wall time,
 * and the reason was written with `console.warn` at collection time, which
 * vitest's reporter drops when every task in the file skips. `PANDA_CONSUMER_
 * INSTALL=0` is the one way to skip it, and it announces itself on stderr.
 *
 * WHERE IT LIVES. The spec's Code Map put it at `test/consumer-install/`. It is
 * here instead because a repo-root vitest suite would need either a root
 * `typescript` devDependency — whose `tsc` bin collides with the load-bearing
 * `@typescript/typescript6` the root manifest calls out — or an untypechecked
 * test file. Here it is typechecked, linted and runnable by wiring that already
 * exists, and it sits beside the in-workspace proof it makes falsifiable.
 * It IMPORTS nothing from any package (AD-2 is about imports and manifests):
 * every `@panda/*` name below is a directory to pack or a tarball to read.
 */

const PROBE_TIMEOUT_MS = 60_000
const SETUP_TIMEOUT_MS = 900_000
const RUN_TIMEOUT_MS = 120_000

const repoRoot = join(import.meta.dirname, '..', '..', '..')

/** Every workspace package, in no particular order — the build sorts itself. */
const PACKAGE_DIRS = [
  'adapter-cli',
  'cli',
  'contracts',
  'environment',
  'kernel',
  'memory-filesystem',
  'memory-sqlite',
  'projection',
  'registry',
  'session',
  'workspace-git-worktree',
  'workspace-local',
] as const

/**
 * The five packages `@panda/session` pulls in. Every one is declared as a DIRECT
 * `file:` dependency of the consumer project, exactly as a third party handed a
 * set of tarballs would have to declare them: the packed manifest says
 * `"@panda/contracts": "0.0.0"`, a version no registry has, and npm satisfies
 * that requirement from the top-level `file:` install of the same version.
 *
 * This list used to feed `pnpm.overrides`, and that is what broke CI — see the
 * Spec Change Log #26. A missing entry here fails the install loudly, which is
 * the behaviour wanted; the failure this file exists to prevent is a SILENT
 * resolution through the workspace, and a tarball cannot reach one.
 */
const SESSION_DEPENDENCIES = [
  'adapter-cli',
  'contracts',
  'kernel',
  'workspace-git-worktree',
  'workspace-local',
] as const

/**
 * The one skip, and it announces itself. `process.stderr.write`, not
 * `console.warn`: the reporter owns console output and drops it when a file
 * produces no running task.
 */
const OPT_OUT = process.env['PANDA_CONSUMER_INSTALL'] === '0'
if (OPT_OUT) {
  process.stderr.write(
    'SKIPPED packages/session/test/consumer-install.proof.ts — PANDA_CONSUMER_INSTALL=0\n',
  )
}

interface Ran {
  readonly code: number | null
  readonly output: string
}

/**
 * One child process, reporting its EXIT STATUS.
 *
 * `shell: true` is needed for `pnpm` on win32 (it is a `.CMD` shim), and it is
 * exactly why the status is what gets read: with a shell in between, "a process
 * started" only says a SHELL started. The sibling live smoke in
 * `@panda/projection` shipped a probe that asked the weaker question and let CI
 * run red for seven commits against a runner with no binary.
 */
function run(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    const line = [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ')
    const child = spawn(line, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const collect = (chunk: Buffer): void => {
      output += chunk.toString()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}${String(error)}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

function node(args: readonly string[], cwd: string, timeoutMs: number): Promise<Ran> {
  return run(process.execPath, args, cwd, timeoutMs)
}

/**
 * Every file in a `pnpm pack` tarball, by archive path, without shelling out.
 *
 * `tar` was the obvious answer and it is the wrong one: the GNU build on PATH
 * here reads `C:\Users\…` as a `host:path` remote spec and answers `Cannot
 * connect to C: resolve failed`, which made the assertion depend on which `tar`
 * a machine has. A gzip stream and 512-byte ustar headers are both in the
 * standard library's reach, so nothing external decides whether this can run.
 *
 * ponytail: plain ustar entries only — no pax headers, no >100-character names.
 * That is what npm and pnpm emit; the whole archive is read once and cached,
 * because every clause below asks it several questions.
 */
async function readTarball(tarballPath: string): Promise<ReadonlyMap<string, string>> {
  const archive = gunzipSync(await readFile(tarballPath))
  const entries = new Map<string, string>()
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const name = archive.toString('utf8', offset, offset + 100).replace(/\0.*$/, '')
    // A cleared header block is the end-of-archive marker.
    if (name === '') break
    const size = Number.parseInt(archive.toString('ascii', offset + 124, offset + 136).replace(/\0.*$/, '').trim(), 8)
    const body = offset + 512
    entries.set(name, archive.toString('utf8', body, body + size))
    offset = body + Math.ceil(size / 512) * 512
  }
  return entries
}

/** A manifest-relative path (`./dist/index.js`) as the tarball names it. */
function packedPath(manifestPath: string): string {
  return `package/${manifestPath.replace(/^\.\//, '')}`
}

/**
 * Every file a PACKED manifest points at: each export entry's targets and every
 * `bin`. `panda-source` is skipped deliberately — it names `src/`, which is the
 * repository-only condition and is not shipped.
 */
function manifestTargets(manifest: Record<string, unknown>): string[] {
  const exported = Object.values((manifest['exports'] ?? {}) as Record<string, Record<string, string>>)
  const conditions = exported.flatMap((entry) =>
    Object.entries(entry)
      .filter(([condition]) => condition !== 'panda-source')
      .map(([, target]) => target),
  )
  return [...conditions, ...Object.values((manifest['bin'] ?? {}) as Record<string, string>)]
}

/** Relative specifiers in one emitted module, in source order. */
function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]*)['"]/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined)
}

/**
 * Every archive path the module graph rooted at `entry` reaches, or the first
 * specifier it could not find.
 *
 * This is what an entry-point-only check misses, and the frozen matrix asks for:
 * a `files` list of `["dist/index.js","dist/index.d.ts"]` ships an entry point
 * that re-exports four modules the archive does not contain, so
 * `import '@panda/registry'` throws on its FIRST line while every
 * entry-point assertion stays green.
 *
 * Declarations are followed with their own rule, because
 * `rewriteRelativeImportExtensions` rewrites JavaScript emit only: `index.d.ts`
 * says `./run-session.ts` where `index.js` says `./run-session.js`, and both
 * mean the file the archive stores as `run-session.d.ts`.
 */
function unreachable(entries: ReadonlyMap<string, string>, entry: string): string[] {
  const missing: string[] = []
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    const source = entries.get(current)
    if (source === undefined) {
      missing.push(current)
      continue
    }
    const declaration = current.endsWith('.d.ts')
    for (const specifier of relativeSpecifiers(source)) {
      const resolved = posix.normalize(posix.join(posix.dirname(current), specifier))
      queue.push(declaration ? resolved.replace(/\.(?:ts|js)$/, '.d.ts') : resolved)
    }
  }
  return missing
}

/**
 * What the consumer project runs. Plain JavaScript in the installed project, so
 * nothing about it can be answered by this repository's toolchain: it resolves
 * `@panda/session` by Node's own rules, out of `node_modules`.
 *
 * The spawner is a fake, so no executor binary is required, but everything
 * BETWEEN the entry point and the child is production code — catalogue lookup,
 * vendor argv, the interception waterfall, and the REAL workspace provider
 * creating a directory under the consumer's own cwd.
 *
 * The payload is DELIMITED. Reading the last line of merged stdout+stderr was
 * one Node deprecation warning away from an opaque `SyntaxError` inside
 * `beforeAll`, which would have looked like a packaging defect.
 */
const PAYLOAD_BEGIN = 'PANDA-PROOF-PAYLOAD-BEGIN'
const PAYLOAD_END = 'PANDA-PROOF-PAYLOAD-END'

const CONSUMER_SCRIPT = `import { createMemoryLogSink, resolveExecutor, runSession } from '@panda/session'

const STDOUT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Wrote panda-ok.txt' })

class FakeChild {
  pid = 4242
  settled = false
  stdin = ''
  #resolve
  constructor(command, args, options) {
    this.command = command
    this.args = args
    this.options = options
    this.done = new Promise((resolve) => {
      this.#resolve = resolve
    })
  }
  writeStdin(chunk) {
    this.stdin += chunk
  }
  endStdin() {
    queueMicrotask(() => {
      this.settled = true
      this.#resolve({ exitCode: 0, stdout: STDOUT, stderr: '' })
    })
  }
  killTree() {}
}

class FakeSpawner {
  children = []
  spawn(command, args, options) {
    const child = new FakeChild(command, args, options)
    this.children.push(child)
    return child
  }
}

const spawner = new FakeSpawner()
const log = createMemoryLogSink()
const selection = await resolveExecutor({ homeDir: process.cwd(), projectDir: process.cwd() })
const envelope = await runSession({
  prompt: 'list files',
  cwd: process.cwd(),
  executorId: selection.executorId,
  adapterOptions: { spawner },
  log,
})
await log.drain()
console.log('${PAYLOAD_BEGIN}')
console.log(
  JSON.stringify({
    envelope,
    selection,
    spawned: spawner.children.map((child) => ({
      command: child.command,
      args: child.args,
      stdin: child.stdin,
      cwd: child.options.cwd,
    })),
    events: log.records.map((record) => record.event),
    subjects: log.records.map((record) => record.subject),
    resolvedFrom: import.meta.resolve('@panda/session'),
  }),
)
console.log('${PAYLOAD_END}')
`

/**
 * Consumer code compiled against the SHIPPED declarations. The
 * `@ts-expect-error` is the half that matters: if the declarations failed to
 * resolve and the import degraded to `any`, `{ prompt: 42 }` would be
 * assignable, the directive would be unused, and tsc would report THAT — so a
 * clean exit means the types arrived and are real.
 */
const CONSUMER_TYPES = `import { runSession } from '@panda/session'
import type { ResultEnvelope, SessionOptions } from '@panda/session'

const options: SessionOptions = { prompt: 'list files' }

export async function go(): Promise<ResultEnvelope> {
  return await runSession(options)
}

// @ts-expect-error 'prompt' is a string, so these declarations are real types.
export const wrong: SessionOptions = { prompt: 42 }
`

/**
 * The OTHER promise, and the one nothing tested.
 * `ARCHITECTURE-SPINE.md` (AD-2): "Third parties implement any port installing
 * only `@panda/contracts`." The session arm above installs six tarballs, so it
 * proves the session BUNDLE is installable and says nothing about this. Its
 * control is that arm: if the harness itself were broken, both would be red.
 *
 * Runtime half. A port is a type, so this exercises the runtime surface a port
 * implementation actually calls — the validator and the coded error — and the
 * typecheck below carries the port itself.
 */
const CONTRACTS_ONLY_SCRIPT = `import { PANDA_ERROR_CODES, PandaError, validateWorkspaceHandle } from '@panda/contracts'

const handle = validateWorkspaceHandle({ id: 'w1', rootPath: process.cwd(), capabilities: ['read', 'write'] })

let rejectedCode = null
try {
  validateWorkspaceHandle({ id: '', rootPath: '', capabilities: [] })
} catch (error) {
  if (!(error instanceof PandaError)) throw error
  rejectedCode = error.code
}

console.log('${PAYLOAD_BEGIN}')
console.log(
  JSON.stringify({
    handle,
    rejectedCode,
    expectedCode: PANDA_ERROR_CODES.contractEnvelopeInvalid,
    resolvedFrom: import.meta.resolve('@panda/contracts'),
  }),
)
console.log('${PAYLOAD_END}')
`

/**
 * The port itself, compiled against the SHIPPED declarations with `@panda/contracts`
 * as the only thing installed. `implements WorkspaceProvider` is the assertion:
 * a declaration file that failed to resolve would degrade the import to `any`,
 * the `@ts-expect-error` below would be unused, and tsc would report THAT.
 */
const CONTRACTS_ONLY_TYPES = `import { PANDA_ERROR_CODES, PandaError, validateWorkspaceHandle } from '@panda/contracts'
import type { WorkspaceHandle, WorkspaceProvider } from '@panda/contracts'

export class EphemeralWorkspaces implements WorkspaceProvider {
  async create(): Promise<WorkspaceHandle> {
    return validateWorkspaceHandle({ id: 'w1', rootPath: '/w1', capabilities: ['read', 'write'] })
  }

  async acquire(id: string): Promise<WorkspaceHandle> {
    return validateWorkspaceHandle({ id, rootPath: \`/\${id}\`, capabilities: ['read'] })
  }

  async release(_handle: WorkspaceHandle): Promise<void> {}

  async dispose(): Promise<void> {
    throw new PandaError(PANDA_ERROR_CODES.contractProviderDisposed, 'disposed')
  }
}

// @ts-expect-error 'execute' is not a WorkspaceCapability, so these declarations are real types.
export const wrong: WorkspaceHandle = { id: 'x', rootPath: '/x', capabilities: ['execute'] }
`

const CONSUMER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'es2023',
      // `dom` for one reason, measured: the shipped declarations need an
      // ambient `AbortSignal` and NOTHING else outside `es2023`. It is supplied
      // either by this lib or by `@types/node`, and taking it from the lib means
      // the consumer project installs no type package at all — which is what
      // keeps the whole install `file:`-only and offline.
      lib: ['es2023', 'dom'],
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      // STRICT, not lenient. `skipLibCheck: true` skips every `.d.ts` —
      // including the ones this story ships — so it hid that
      // `@panda/contracts/dist/executor.d.ts` needs an ambient `AbortSignal`
      // nothing supplied. Measured with `lib: ["es2023"]` alone: `TS2304:
      // Cannot find name 'AbortSignal'`. So the check is doing work.
      skipLibCheck: false,
      types: [],
    },
    include: ['consumer.ts'],
  },
  null,
  2,
)

interface ConsumerRun {
  readonly envelope: unknown
  readonly selection: { executorId: string; layer: string; available: string[] }
  readonly spawned: { command: string; args: string[]; stdin: string; cwd: string }[]
  readonly events: string[]
  readonly subjects: string[]
  readonly resolvedFrom: string
}

let temporaryRoot = ''
let projectDir = ''
let installedManifest: Record<string, unknown> = {}
let consumer: ConsumerRun
/** Archive path -> its complete contents, for each of the nine tarballs. */
const packed = new Map<string, ReadonlyMap<string, string>>()

// The installed project is EVIDENCE when something goes red, and litter when
// nothing does. `beforeAll` flips this only after it has finished, so a setup
// that threw keeps its tree.
let setupCompleted = false
let anyTestFailed = false

describe.skipIf(OPT_OUT)('a project OUTSIDE the workspace that installed the packed tarballs', () => {
  beforeAll(async () => {
    // FIRST, and an assertion rather than a skip. Everything below shells out to
    // pnpm; without it the suite has nothing to say, and saying nothing while
    // exiting 0 is the exact defect the projection live smoke shipped.
    const probe = await run('pnpm', ['--version'], repoRoot, PROBE_TIMEOUT_MS)
    expect(
      probe.code,
      `this proof builds, packs and installs through pnpm, and pnpm is not usable here (exit ${String(probe.code)}): ${probe.output.trim()}. Set PANDA_CONSUMER_INSTALL=0 to skip it deliberately.`,
    ).toBe(0)

    // Build every time. A proof that asserted against whatever `dist/` happened
    // to be lying around would go green on a stale artifact — which is the same
    // "cannot be wrong" defect as proving FR-29 through workspace links.
    const built = await run('pnpm', ['-r', 'build'], repoRoot, SETUP_TIMEOUT_MS)
    expect(built.code, `pnpm -r build failed:\n${built.output}`).toBe(0)

    // The ONE directory this repository is allowed to write outside itself, and
    // the entire point: inside the workspace, pnpm answers `@panda/session` from
    // `src/` whatever the tarball says.
    temporaryRoot = await mkdtemp(join(tmpdir(), 'panda-installed-consumer-'))
    projectDir = join(temporaryRoot, 'project')
    const tarballDir = join(projectDir, 'tarballs')
    await mkdir(tarballDir, { recursive: true })

    for (const packageDir of PACKAGE_DIRS) {
      const packedResult = await run(
        'pnpm',
        ['pack', '--pack-destination', tarballDir],
        join(repoRoot, 'packages', packageDir),
        RUN_TIMEOUT_MS,
      )
      expect(packedResult.code, `pnpm pack failed for packages/${packageDir}:\n${packedResult.output}`).toBe(0)
      packed.set(packageDir, await readTarball(join(tarballDir, `panda-${packageDir}-0.0.0.tgz`)))
    }

    const tarball = (packageDir: string): string => `file:./tarballs/panda-${packageDir}-0.0.0.tgz`
    await writeFile(
      join(projectDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'panda-installed-consumer',
          version: '0.0.0',
          private: true,
          type: 'module',
          // Every `@panda/*` in the closure, DIRECT, each on its own tarball —
          // and nothing else at all, so the install has no registry package to
          // want and `--offline` is a fact rather than a hope.
          dependencies: Object.fromEntries(
            ['session', ...SESSION_DEPENDENCIES].map((packageDir) => [
              `@panda/${packageDir}`,
              tarball(packageDir),
            ]),
          ),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(join(projectDir, 'consumer.mjs'), CONSUMER_SCRIPT, 'utf8')
    await writeFile(join(projectDir, 'consumer.ts'), CONSUMER_TYPES, 'utf8')
    await writeFile(join(projectDir, 'tsconfig.json'), `${CONSUMER_TSCONFIG}\n`, 'utf8')

    // npm, deliberately, and not the pnpm this repository is built with. pnpm
    // produces the tarballs; the consumer is whoever received them, and npm is
    // both what they most likely run and the thing that keeps this half of the
    // proof independent of the workspace's own tooling. It also ships with Node,
    // so there is no second binary to probe.
    //
    // `--offline` is an assertion rather than a convenience: every dependency is
    // a `file:` tarball, so nothing here has a registry package to want, and the
    // flag is what makes a future one fail loudly instead of quietly dialling
    // out.
    const installed = await run('npm', ['install', '--offline'], projectDir, RUN_TIMEOUT_MS)
    expect(installed.code, `npm install failed in the consumer project:\n${installed.output}`).toBe(0)

    installedManifest = JSON.parse(
      await readFile(join(projectDir, 'node_modules', '@panda', 'session', 'package.json'), 'utf8'),
    ) as Record<string, unknown>

    const ran = await node(['consumer.mjs'], projectDir, RUN_TIMEOUT_MS)
    expect(ran.code, `the consumer script failed:\n${ran.output}`).toBe(0)
    const payload = ran.output.split(PAYLOAD_BEGIN)[1]?.split(PAYLOAD_END)[0]
    expect(payload, `the consumer script printed no delimited payload:\n${ran.output}`).toBeDefined()
    consumer = JSON.parse(payload ?? '') as ConsumerRun
    setupCompleted = true
  }, SETUP_TIMEOUT_MS)

  afterEach((context) => {
    if (context.task.result?.state === 'fail') anyTestFailed = true
  })

  afterAll(async () => {
    if (setupCompleted && !anyTestFailed && temporaryRoot !== '') {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
  })

  it('packs EVERY workspace package, because the list above says it does', async () => {
    // The comment on PACKAGE_DIRS claimed "every workspace package" while the
    // list held nine of ten: `workspace-git-worktree` shipped in M6.A and was
    // never added, so its tarball was the only one no pack step and no
    // module-graph walk ever inspected. A prose claim nothing checks is the
    // defect class AGENTS.md names, and this is the check.
    //
    // It asserts membership only. It does NOT assert that anything imports a
    // packed package: the install-and-import arm below is scoped to
    // `@panda/session` and its dependency closure, so a package can be packed,
    // proven well-formed, and still be unreachable from the binary. That gap is
    // Story 4.2's, not this assertion's.
    const workspacePackages = (await readdir(join(repoRoot, 'packages'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect([...PACKAGE_DIRS].sort()).toStrictEqual(workspacePackages)
  })

  it('lives outside the repository, and resolves the package out of its own node_modules', () => {
    expect(relative(repoRoot, projectDir).startsWith(`..${sep}`)).toBe(true)
    // Not "a path that looks right" — the URL Node itself resolved. A symlink or
    // a `file:` path back into the repo would surface here as a repo path.
    expect(consumer.resolvedFrom.startsWith(pathToFileURL(projectDir).href)).toBe(true)
    expect(consumer.resolvedFrom.toLowerCase()).not.toContain(
      pathToFileURL(repoRoot).href.toLowerCase().replace(/\/$/, ''),
    )
    expect(consumer.resolvedFrom.endsWith('/dist/index.js')).toBe(true)
  })

  it('runs a real session and returns the envelope panda run prints', () => {
    // Byte-for-byte the object `@panda/cli` hands to `JSON.stringify(_, null, 2)`,
    // and the input to its exit-code ternary — asserted from a project that has
    // no `@panda/cli` installed and no access to this workspace.
    expect(consumer.envelope).toEqual({
      status: 'ok',
      data: { result: 'Wrote panda-ok.txt', subtype: 'success' },
      summary: 'Wrote panda-ok.txt',
      errors: [],
    })
    // `layer: 'defaults'` is the honest scope of this clause: no configuration
    // document exists in the temp project, so the layered read is exercised in
    // its EMPTY case only. Layer precedence is proved by `executors.test.ts`.
    expect(consumer.selection).toEqual({
      executorId: 'claude-code',
      layer: 'defaults',
      available: ['claude-code', 'codex', 'opencode'],
    })
  })

  it('drove the production path: catalogue argv, the real workspace, the waterfall', () => {
    // The fake stops at the child process. Everything before it is the shipped
    // composition, so these assertions are what separate "the tarball imports"
    // from "the tarball WORKS".
    expect(consumer.spawned).toHaveLength(1)
    const spawned = consumer.spawned[0]!
    expect(spawned.command).toBe('claude')
    expect(spawned.args).toEqual([
      '--print',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
    ])
    expect(spawned.stdin).toBe('list files')
    // The REAL provider ran: the child's cwd is a workspace directory the
    // installed package created under the consumer's own project.
    expect(spawned.cwd.startsWith(join(projectDir, '.panda', 'workspaces'))).toBe(true)
    // The waterfall ran as PLUMBING: no interceptor is registered and no
    // `ActionPolicy` is set, so this says the pipeline is reachable and records
    // an invocation, not that any budget or interception behaves.
    expect(consumer.events).toEqual(['action.invoked', 'action.completed'])
    expect(consumer.subjects.every((subject) => subject.startsWith('session.executor-run#'))).toBe(true)
  })

  it('exports dist from the INSTALLED manifest, with the workspace protocol resolved away', () => {
    // Asserted, never assumed: this is the manifest as pnpm unpacked it.
    expect(installedManifest['exports']).toEqual({
      '.': {
        'panda-source': './src/index.ts',
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
    })
    expect(installedManifest['dependencies']).toEqual({
      '@panda/adapter-cli': '0.0.0',
      '@panda/contracts': '0.0.0',
      '@panda/kernel': '0.0.0',
      '@panda/workspace-git-worktree': '0.0.0',
      '@panda/workspace-local': '0.0.0',
    })
  })

  it('ships declarations a strict Node consumer can compile against', async () => {
    const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript')), 'tsc.js')
    const typechecked = await node([tsc, '-p', 'tsconfig.json'], projectDir, RUN_TIMEOUT_MS)
    expect(typechecked.code, `consumer typecheck failed:\n${typechecked.output}`).toBe(0)
  })

  it('installs and imports @panda/contracts ALONE, and a port compiles against it', async () => {
    // Its OWN project, beside the session one and sharing only the tarball
    // directory `beforeAll` packed. Installing into the session consumer would
    // prove nothing: five other packages are already there, and the claim is
    // precisely that none of them is needed.
    const soleDir = join(temporaryRoot, 'contracts-only')
    await mkdir(soleDir, { recursive: true })
    await writeFile(
      join(soleDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'panda-contracts-only-consumer',
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies: { '@panda/contracts': 'file:../project/tarballs/panda-contracts-0.0.0.tgz' },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(join(soleDir, 'consumer.mjs'), CONTRACTS_ONLY_SCRIPT, 'utf8')
    await writeFile(join(soleDir, 'consumer.ts'), CONTRACTS_ONLY_TYPES, 'utf8')
    await writeFile(join(soleDir, 'tsconfig.json'), `${CONSUMER_TSCONFIG}\n`, 'utf8')

    // `--offline` is the assertion that nothing else was wanted: a runtime
    // dependency appearing on `@panda/contracts` fails HERE, loudly, instead of
    // quietly dialling out to a registry and passing.
    const installed = await run('npm', ['install', '--offline'], soleDir, RUN_TIMEOUT_MS)
    expect(installed.code, `npm install failed in the contracts-only project:\n${installed.output}`).toBe(0)

    // ALONE, asserted from the installed tree rather than from the manifest that
    // asked: one `@panda/*` package arrived, not a closure.
    expect((await readdir(join(soleDir, 'node_modules', '@panda'))).sort()).toEqual(['contracts'])

    const ran = await node(['consumer.mjs'], soleDir, RUN_TIMEOUT_MS)
    expect(ran.code, `the contracts-only consumer script failed:\n${ran.output}`).toBe(0)
    const payload = ran.output.split(PAYLOAD_BEGIN)[1]?.split(PAYLOAD_END)[0]
    expect(payload, `the contracts-only consumer printed no delimited payload:\n${ran.output}`).toBeDefined()
    const sole = JSON.parse(payload ?? '') as {
      handle: unknown
      rejectedCode: string | null
      expectedCode: string
      resolvedFrom: string
    }
    expect(sole.handle).toEqual({ id: 'w1', rootPath: soleDir, capabilities: ['read', 'write'] })
    // The coded error is real, not a bare throw: a port implementation routes on
    // the code, and this is the shipped one.
    expect(sole.rejectedCode).toBe(sole.expectedCode)
    expect(sole.resolvedFrom.startsWith(pathToFileURL(soleDir).href)).toBe(true)
    expect(sole.resolvedFrom.toLowerCase()).not.toContain(
      pathToFileURL(repoRoot).href.toLowerCase().replace(/\/$/, ''),
    )

    const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript')), 'tsc.js')
    const typechecked = await node([tsc, '-p', 'tsconfig.json'], soleDir, RUN_TIMEOUT_MS)
    expect(typechecked.code, `the contracts-only port typecheck failed:\n${typechecked.output}`).toBe(0)
  }, SETUP_TIMEOUT_MS)

  it('packs a binary that is emitted JavaScript with its shebang intact', () => {
    // Read out of the TARBALL, not out of the workspace: the claim is about what
    // a consumer receives, and `files` could stop shipping `dist` without any
    // workspace-side assertion noticing. No import of `@panda/cli` is involved,
    // so the session package's tier is untouched — this is a file, not a
    // dependency.
    const entries = packed.get('cli')!
    const cli = JSON.parse(entries.get('package/package.json')!) as Record<string, unknown>
    expect(cli['bin']).toEqual({ panda: './dist/bin/panda.js' })
    expect(cli['exports']).toEqual({
      '.': {
        'panda-source': './src/index.ts',
        types: './dist/src/index.d.ts',
        default: './dist/src/index.js',
      },
    })

    // Followed from the manifest rather than typed again, so a `bin` that moved
    // is a failure to FIND the file, never a stale assertion passing beside it.
    const binary = entries.get(packedPath((cli['bin'] as { panda: string }).panda))
    expect(binary, 'the packed CLI does not contain the file its bin points at').toBeDefined()
    expect(binary?.startsWith('#!/usr/bin/env node\n')).toBe(true)
    // The shebang survived, and so did the extension rewrite that makes the line
    // under it resolvable from `dist/bin/`.
    expect(binary).toContain("from '../src/run.js'")
  })

  it('ships every manifest entry point AND every module those entry points reach', () => {
    // A partial build — or a `files` list that stopped covering all of `dist` —
    // produces a tarball that installs and then throws on the first line of its
    // own entry point, for ONE package, while the other eight stay fine.
    //
    // Entry points alone are not enough, and that is not hypothetical: a
    // reviewer set `"files": ["dist/index.js","dist/index.d.ts"]` on
    // `@panda/registry` and got a green 7/7 beside an import that threw. So the
    // whole module graph is walked, in the archive, from every target the
    // PACKED manifest names — `types` included, which an earlier version read
    // past.
    const missing: string[] = []
    for (const packageDir of PACKAGE_DIRS) {
      const entries = packed.get(packageDir)!
      const manifest = JSON.parse(entries.get('package/package.json')!) as Record<string, unknown>
      const targets = manifestTargets(manifest)
      expect(targets.length, `@panda/${packageDir} names no shippable target`).toBeGreaterThan(0)
      for (const target of targets) {
        for (const absent of unreachable(entries, packedPath(target))) {
          missing.push(`@panda/${packageDir} does not ship ${absent}, reached from ${target}`)
        }
      }
    }
    expect(missing, `packed manifests reach files their tarballs do not contain:\n${missing.join('\n')}`).toEqual([])
  })

  it('declares @panda/* dependency ranges the packed versions actually satisfy', () => {
    // The consumer installs every `@panda/*` as a direct `file:` dependency,
    // and npm satisfies each packed `"0.0.0"` requirement from the top-level
    // install of that same version. That is a real resolution, but it is a
    // LENIENT one: a manifest requiring `"@panda/kernel": "^9.9.9"` beside a
    // top-level kernel would still be handed the tarball here and would hand a
    // registry consumer an `ETARGET`. This is what stops that drift travelling.
    //
    // ponytail: exact equality, not semver range satisfaction. Every package is
    // `0.0.0` and every declared range is that literal, so a range parser would
    // be a dependency bought for a case that does not exist yet. Upgrade path:
    // real ranges arrive with a versioning policy, and that is when a semver
    // check earns its place.
    const version = new Map<string, string>()
    for (const [packageDir, entries] of packed) {
      const manifest = JSON.parse(entries.get('package/package.json')!) as { name: string; version: string }
      expect(manifest.name, `packages/${packageDir} packed under an unexpected name`).toBe(`@panda/${packageDir}`)
      version.set(manifest.name, manifest.version)
    }

    const wrong: string[] = []
    for (const [packageDir, entries] of packed) {
      const manifest = JSON.parse(entries.get('package/package.json')!) as Record<string, unknown>
      const dependencies = (manifest['dependencies'] ?? {}) as Record<string, string>
      for (const [name, range] of Object.entries(dependencies)) {
        if (!name.startsWith('@panda/')) continue
        const packedVersion = version.get(name)
        if (range !== packedVersion) {
          wrong.push(`@panda/${packageDir} requires ${name}@${range}, but it packs as ${String(packedVersion)}`)
        }
      }
    }
    expect(wrong, `packed dependency ranges no packed version satisfies:\n${wrong.join('\n')}`).toEqual([])
  })
})

// The opt-out has to leave one RUNNING task behind, or vitest exits non-zero for
// "nothing ran" and the escape hatch does not escape. `passWithNoTests` would do
// it too and is the wrong tool: it would also swallow a config whose `include`
// matches no file, which is a real mistake this suite already made once.
it.runIf(OPT_OUT)('is deliberately skipped by PANDA_CONSUMER_INSTALL=0', () => {
  expect(process.env['PANDA_CONSUMER_INSTALL']).toBe('0')
})
