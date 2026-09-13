import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, DEFAULT_TIMEOUT_MS, probe } from './shared.ts'
import type { SandboxExecutionRequest } from '@skanl/panda-contracts'
import type { LocalSandboxAuditCallback, LocalSandboxProvider, LocalSandboxProviderOptions } from './shared.ts'

type MacosSandboxProviderOptions = LocalSandboxProviderOptions & { readonly audit?: LocalSandboxAuditCallback }

const SYSTEM_READ_PATHS = ['/System', '/usr', '/bin', '/sbin', '/Library', '/private/etc', '/opt/homebrew'] as const
const SENSITIVE_ENVIRONMENT = /(?:token|secret|password|credential|api[_-]?key|authorization|cookie)/i
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

function quoted(value: string): string {
  return JSON.stringify(value)
}

function safeEnvironment(environment: Readonly<Record<string, string>>): string[] {
  return Object.entries(environment)
    .filter(([key]) => ENVIRONMENT_KEY.test(key) && !SENSITIVE_ENVIRONMENT.test(key))
    .map(([key, value]) => `${key}=${value}`)
}

/** Builds a Seatbelt profile and exact sandbox-exec argv; the target command is never interpreted by a shell. */
export function buildSeatbeltArgv(request: SandboxExecutionRequest): readonly [string, ...string[]] {
  const workspace = quoted(request.policy.workspaceRoot)
  const profile = [
    '(version 1)',
    '(deny default)',
    '(deny network*)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read-metadata)',
    ...SYSTEM_READ_PATHS.map((path) => `(allow file-read* (subpath ${quoted(path)}))`),
    '(allow file-read* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/urandom"))',
    `(allow file-read* (subpath ${workspace}))`,
    ...(request.policy.mode === 'workspace-write' ? [`(allow file-write* (subpath ${workspace}))`] : []),
  ].join('\n')
  return [
    'sandbox-exec', '-p', profile, '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    ...safeEnvironment(request.environment), '--', ...request.argv,
  ]
}

function run(argv: readonly [string, ...string[]]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
    child.once('error', () => { clearTimeout(timer); resolve(false) })
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
}

async function functionalSeatbelt(): Promise<boolean> {
  const workspace = await mkdtemp(join(tmpdir(), 'panda-seatbelt-'))
  try {
    const writableFile = join(workspace, 'writable')
    const deniedFile = join(workspace, 'denied')
    const writable = await run(buildSeatbeltArgv({
      argv: ['/usr/bin/touch', writableFile], cwd: workspace, environment: {},
      policy: { version: 1, mode: 'workspace-write', workspaceRoot: workspace, requiredCapabilities: { filesystem: 'full' } },
    }))
    if (!writable || !existsSync(writableFile)) return false
    const readOnly = await run(buildSeatbeltArgv({
      argv: ['/usr/bin/touch', deniedFile], cwd: workspace, environment: {},
      policy: { version: 1, mode: 'read-only', workspaceRoot: workspace, requiredCapabilities: { filesystem: 'full' } },
    }))
    return !readOnly && !existsSync(deniedFile)
  } catch {
    return false
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

export async function createMacosSandboxProvider(options: MacosSandboxProviderOptions): Promise<LocalSandboxProvider> {
  const available = process.platform === 'darwin' && await probe(options, ['sandbox-exec', '-h'])
  const seatbelt = available && await functionalSeatbelt()
  return createProvider(
    'local-macos',
    { bubblewrap: false, landlock: false, cgroup: false, seatbelt, windowsSandboxBroker: false, jobObjectHelper: false },
    seatbelt ? 'full' : 'none',
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    seatbelt ? buildSeatbeltArgv : undefined,
    undefined,
    options.audit,
  )
}
