import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RegistryEntriesByKind } from '@skanl/panda-contracts'
import { createCodexConfigTarget } from '../src/targets/codex-config.ts'

// Live check against the real `codex` binary: the ONLY executable form of the
// acceptance criterion "codex --strict-config loads the resulting config.toml
// without error". Every other assertion in this package reasons about panda's
// output; this is the one that hands it to the parser that decides whether the
// user's whole config still loads.
//
// Gating follows the repo's existing live-smoke idiom (adapter-cli):
// - `codex --version` is probed cheaply; a missing binary skips instantly;
// - PANDA_LIVE_CODEX=0 forces a skip;
// - CODEX_HOME points at a throwaway directory with NO credentials, so codex
//   loads the config and then fails on auth — it never completes a model call;
// - the check is DIFFERENTIAL and self-verifying: a deliberately non-conformant
//   config must be rejected, or the test reports that and stops rather than
//   passing vacuously.
//
// The two patterns below are the binary's own verbatim output, observed on
// codex-cli 0.149.1: an undeclared key produces
//   `Error loading config.toml: ... unknown configuration field
//    'mcp_servers.<id>.<key>'`
// while an accepted config reaches the session banner.

const PROBE_TIMEOUT_MS = 15_000
const RUN_TIMEOUT_MS = 20_000

const CONFIG_REJECTED = /Error loading config\.toml|unknown configuration field/i
const CONFIG_ACCEPTED = /OpenAI Codex v/i

const ENTRIES: RegistryEntriesByKind = {
  skill: [],
  'mcp-server': [
    { type: 'mcp-server', id: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  ],
}

const tempRoots: string[] = []
// codex leaves a live sqlite handle in CODEX_HOME; a locked temp file must not
// fail the suite that already produced its answer.
afterAll(() =>
  Promise.all(
    tempRoots.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})),
  ),
)

interface Ran {
  readonly spawned: boolean
  readonly output: string
  /** Exit status of the shell, and so of `codex`; null when it was killed. */
  readonly code: number | null
}

function run(
  args: readonly string[],
  codexHome: string | undefined,
  timeoutMs: number,
  /** Stop as soon as the answer is on stdout, instead of waiting the timeout. */
  until?: RegExp,
): Promise<Ran> {
  return new Promise((resolve) => {
    // One command string rather than shell + argv: the arguments are constants
    // here, and it avoids node's shell-argument deprecation warning.
    const command = ['codex', ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(' ')
    const child = spawn(command, {
      env: codexHome === undefined ? process.env : { ...process.env, CODEX_HOME: codexHome },
      // stdin closed: `codex exec` otherwise waits for piped instructions.
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    })
    let output = ''
    const stop = (): void => {
      // `shell` means the direct child is the shell, so kill the whole tree.
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill()
      }
    }
    const timer = setTimeout(stop, timeoutMs)
    const collect = (chunk: Buffer): void => {
      output += chunk.toString()
      // An accepted config leaves codex retrying an unauthenticated request
      // for half a minute; the answer is already here.
      if (until?.test(output) === true) stop()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ spawned: false, output, code: null })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ spawned: true, output, code })
    })
  })
}

async function codexAvailable(): Promise<boolean> {
  if (process.env['PANDA_LIVE_CODEX'] === '0') return false
  // The EXIT STATUS, not `spawned`. With `shell: true` the direct child is the
  // shell, which starts perfectly on a machine with no codex, prints `codex: not
  // found` and exits 127 — so `spawned` answers "did a shell start", never "does
  // codex exist", and the `error` event fires only when the SHELL cannot launch.
  // CI ran this suite for real against a runner without the binary and failed on
  // its own differential assertion, which is the failure mode this probe exists
  // to prevent. A present-but-broken codex also exits non-zero and skips, which
  // is right: a live smoke proves nothing against a binary that cannot answer.
  const probe = await run(['--version'], undefined, PROBE_TIMEOUT_MS)
  return probe.spawned && probe.code === 0
}

const available = await codexAvailable()

describe.skipIf(!available)('codex --strict-config over a projected config.toml', () => {
  it(
    'loads panda’s output, and rejects the same file with one undeclared key',
    { timeout: 4 * RUN_TIMEOUT_MS },
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'panda-codex-strict-'))
      tempRoots.push(home)
      const configPath = join(home, 'config.toml')
      const exec = ['exec', '--strict-config', '--skip-git-repo-check', 'noop']

      const projected = await createCodexConfigTarget({ filePath: configPath }).merge({
        entries: ENTRIES,
        records: [],
        nativeText: 'model = "gpt-5-codex"\n',
      })

      // Control FIRST: prove this invocation can detect a strict-mode
      // rejection at all. Without it, "panda's config was accepted" could mean
      // nothing was ever checked — the failure mode this whole story is about.
      await writeFile(configPath, `${projected.text}panda_version = "1"\n`, 'utf8')
      const control = await run(exec, home, RUN_TIMEOUT_MS, CONFIG_REJECTED)
      expect(
        control.output,
        'codex did not reject an undeclared key, so this check proves nothing',
      ).toMatch(CONFIG_REJECTED)

      await writeFile(configPath, projected.text, 'utf8')
      const good = await run(exec, home, RUN_TIMEOUT_MS, CONFIG_ACCEPTED)

      // codex still fails afterwards — the throwaway CODEX_HOME has no
      // credentials — but it must not fail on the CONFIG, and it must get far
      // enough to prove the config was read.
      expect(good.output).not.toMatch(CONFIG_REJECTED)
      expect(good.output).toMatch(CONFIG_ACCEPTED)
    },
  )
})
