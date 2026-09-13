import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMacosSandboxProvider } from '@skanl/panda-sandbox-local'

const describeMacosConformance = process.platform === 'darwin' && process.env['PANDA_RUN_SANDBOX_CONFORMANCE'] === '1'
  ? describe
  : describe.skip

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

describeMacosConformance('local macOS sandbox host conformance', () => {
  it('enforces workspace-only writes, secret isolation, network denial, and descendant cleanup', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'panda-macos-sandbox-conformance-'))
    const workspace = join(fixture, 'workspace')
    const outside = join(fixture, 'outside.txt')
    const secret = join(fixture, 'secret.txt')
    const written = join(workspace, 'written.txt')
    const orphaned = join(workspace, 'orphaned.txt')
    const policy = {
      version: 1 as const,
      mode: 'workspace-write' as const,
      workspaceRoot: workspace,
      requiredCapabilities: { filesystem: 'full' as const },
    }

    await mkdir(workspace)
    await writeFile(secret, 'not-for-the-sandbox', 'utf8')

    try {
      const provider = await createMacosSandboxProvider({})
      expect(provider.capabilities.enforcement).toBe('os')
      expect(provider.capabilities.controls.filesystem).toBe('full')

      const session = await provider.createSession({ policy, snapshots: [] })
      try {
        const insideWrite = await session.execute({
          argv: [process.execPath, '--eval', `require('node:fs').writeFileSync(${JSON.stringify(written)}, 'written')`],
          cwd: workspace,
          environment: {},
          policy,
        })
        expect(insideWrite.status).toBe('ok')
        await expect(readFile(written, 'utf8')).resolves.toBe('written')

        const outsideWrite = await session.execute({
          argv: [process.execPath, '--eval', `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'escape')`],
          cwd: workspace,
          environment: {},
          policy,
        })
        expect(outsideWrite.status).toBe('failed')
        expect(existsSync(outside)).toBe(false)

        const secretRead = await session.execute({
          argv: [process.execPath, '--eval', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(secret)}, 'utf8'))`],
          cwd: workspace,
          environment: {},
          policy,
        })
        expect(secretRead.status).toBe('failed')
        expect(secretRead.stdout).not.toContain('not-for-the-sandbox')

        const network = await session.execute({
          argv: [process.execPath, '--eval', "require('node:net').connect({ host: '1.1.1.1', port: 53 }).once('connect', () => process.exit(0)).once('error', () => process.exit(1))"],
          cwd: workspace,
          environment: {},
          policy,
        })
        expect(network.status).toBe('failed')

        const descendant = await session.execute({
          argv: [process.execPath, '--eval', `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['--eval', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(orphaned)}, 'orphaned'), 500)`) }], { detached: true, stdio: 'ignore' }); child.unref()`],
          cwd: workspace,
          environment: {},
          policy,
        })
        expect(descendant.status).toBe('ok')
        await wait(1_000)
        expect(existsSync(orphaned)).toBe(false)
      } finally {
        await session.dispose()
      }
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})