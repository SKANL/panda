#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'

const exec = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '..')
const packageDirs = JSON.parse(await readFile(join(import.meta.dirname, 'publishable-packages.json'), 'utf8'))

if (!Array.isArray(packageDirs) || !packageDirs.every((entry) => typeof entry === 'string')) {
  throw new Error('scripts/publishable-packages.json must be an array of package directory names')
}

const destination = resolve(process.argv[2] ?? join(repoRoot, '.scratch', 'panda-tarballs'))
await mkdir(destination, { recursive: true })

for (const packageDir of packageDirs) {
  const packageRoot = join(repoRoot, 'packages', packageDir)
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.private === true) throw new Error(`packages/${packageDir} is private, but the publishable manifest names it`)
  await exec(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['pack', '--pack-destination', destination], {
    cwd: packageRoot,
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  const files = await readdir(destination)
  const prefix = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
  if (!files.includes(prefix)) throw new Error(`pnpm pack did not create ${prefix}`)
}

console.log(`Packed ${packageDirs.length} publishable packages into ${destination}`)
