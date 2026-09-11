#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)
const tarballDir = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('usage: node scripts/consumer-smoke.mjs <tarball-directory>')

const packageDirs = JSON.parse(await readFile(join(import.meta.dirname, 'publishable-packages.json'), 'utf8'))
if (!Array.isArray(packageDirs) || !packageDirs.every((entry) => typeof entry === 'string')) {
  throw new Error('scripts/publishable-packages.json must be an array of package directory names')
}

const files = await readdir(tarballDir)
const tarballs = new Map()
const packages = new Map()
const packageNames = new Set()
for (const packageDir of packageDirs) {
  const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'packages', packageDir, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@skanl/panda-') || packageNames.has(manifest.name)) {
    throw new Error(`packages/${packageDir}/package.json has no publishable @skanl/panda-* name`)
  }
  packageNames.add(manifest.name)
  const prefix = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
  const matches = files.filter((file) => file.startsWith(prefix) && file.endsWith('.tgz'))
  if (matches.length !== 1) throw new Error(`expected exactly one tarball for packages/${packageDir}, found ${matches.join(', ') || 'none'}`)
  packages.set(packageDir, manifest)
  tarballs.set(packageDir, matches[0])
}

const projectDir = await mkdtemp(join(tmpdir(), 'panda-consumer-smoke-'))
const packageJson = {
  name: 'panda-consumer-smoke',
  version: '0.0.0',
  private: true,
  type: 'module',
  dependencies: Object.fromEntries(
    packageDirs.map((packageDir) => [
      packages.get(packageDir).name,
      `file:${relative(projectDir, join(tarballDir, tarballs.get(packageDir))).replaceAll('\\', '/')}`,
    ]),
  ),
}

const run = async (command, args, cwd) => {
  try {
    const result = await exec(command, args, {
      cwd,
      env: { ...process.env, npm_config_engine_strict: 'false', NPM_CONFIG_ENGINE_STRICT: 'false' },
      shell: process.platform === 'win32',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { code: 0, output: `${result.stdout}${result.stderr}` }
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? error}` }
  }
}

try {
  await writeFile(join(projectDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
  const installed = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--engine-strict=false'], projectDir)
  if (installed.code !== 0) throw new Error(`npm install of packed tarballs failed:\n${installed.output}`)

  await writeFile(
    join(projectDir, 'surface-smoke.mjs'),
    `${[...packages.values()]
      .map((manifest, index) => `const package${index} = await import(${JSON.stringify(manifest.name)})`)
      .join('\n')}\n
const contracts = package${[...packages.values()].findIndex((manifest) => manifest.name === '@skanl/panda-contracts')}
const session = package${[...packages.values()].findIndex((manifest) => manifest.name === '@skanl/panda-session')}
if (typeof contracts.validateMethodPlugin !== 'function') throw new Error('contracts public surface is missing validateMethodPlugin')
if (typeof session.runSession !== 'function') throw new Error('session public surface is missing runSession')
if (typeof session.resolveExecutor !== 'function') throw new Error('session public surface is missing resolveExecutor')
`,
    'utf8',
  )
  const surfaces = await run(process.execPath, ['surface-smoke.mjs'], projectDir)
  if (surfaces.code !== 0) throw new Error(`installed public surfaces failed:\n${surfaces.output}`)

  const cliManifest = JSON.parse(await readFile(join(projectDir, 'node_modules', '@skanl', 'panda-cli', 'package.json'), 'utf8'))
  const cliTarget = typeof cliManifest.bin?.panda === 'string' ? cliManifest.bin.panda : undefined
  if (cliTarget === undefined) throw new Error('installed CLI has no panda bin target')
  const cli = await run(process.execPath, [join(projectDir, 'node_modules', '@skanl', 'panda-cli', cliTarget), '--version'], projectDir)
  if (cli.code !== 0) throw new Error(`installed CLI --version failed:\n${cli.output}`)
  if (!cli.output.includes(String(cliManifest.version))) throw new Error(`installed CLI --version did not report ${cliManifest.version}:\n${cli.output}`)

  console.log(`Consumer smoke passed on ${process.version}: contracts, session, and CLI ${cliManifest.version}`)
} finally {
  await rm(projectDir, { recursive: true, force: true, maxRetries: 3 })
}
