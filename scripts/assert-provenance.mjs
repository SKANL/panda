#!/usr/bin/env node
// Asserts that every package this repository publishes carries a provenance
// attestation ON THE REGISTRY, at the version the manifests declare.
//
// WHY THIS EXISTS AS A FILE. It began as a heredoc inside `release.yml`, and a
// step that only ever runs at the one irreversible moment is a step nobody has
// driven. Moved here so it can be run by hand — `node scripts/assert-provenance.mjs`
// — and so its three outcomes could be measured against real packages before
// the release depended on them.
//
// WHAT IT IS FOR. `release.yml` used to ask for provenance with
// `NPM_CONFIG_PROVENANCE: 'true'`, which pnpm 11 does not read (measured: an
// `NPM_CONFIG_REGISTRY` pointing at a dead port is ignored while
// `PNPM_CONFIG_REGISTRY` is honoured). The publish would have exited 0 with
// thirteen unsigned packages and nothing would have failed. The flag is fixed;
// this is the part that FAILS when the fix stops working.
//
// THE DISTINCTION THAT MATTERS, and the reason the first draft was wrong:
// "not on the registry" and "on the registry without provenance" are different
// failures with different repairs — a publish that aborted partway versus a
// publish that landed unsigned. `npm view --json` reports a missing package as
// `{"error":{"code":"E404"}}` on STDOUT with exit 1, so a reader that only looks
// for `dist.attestations` reports both as "no provenance", naming `undefined`.

import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const packagesDir = join(import.meta.dirname, '..', 'packages')

/** Every package this repository publishes, and the one version they share. */
function published() {
  const names = []
  for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(packagesDir, dir.name, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    // A package that is not published has nothing to attest. `private` is the
    // field npm itself refuses to publish on, so it is the right question.
    if (manifest.private !== undefined) continue
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
    names.push({ name: manifest.name, version: manifest.version })
  }
  return names
}

/**
 * One package's verdict, as a reason string or `undefined` when it is signed.
 *
 * Reads the REGISTRY rather than the publish log, because the log is the thing
 * that was already trusted.
 */
async function verdict({ name, version }) {
  const spec = `${name}@${version}`
  let stdout
  try {
    // `shell` on win32 ONLY, and the reason is worth stating because Node
    // deprecates it by name (DEP0190): a `.cmd` shim cannot be spawned without
    // one there — `npm.cmd` without it fails `spawn EINVAL` — and CI, which is
    // where this runs for real, is Linux and takes the direct path. The
    // deprecation is about unescaped arguments, and the only argument here is a
    // package name read out of this repository's own manifests, which the loop
    // above has already parsed as JSON. It is never user input.
    ;({ stdout } = await run('npm', ['view', spec, '--json'], {
      maxBuffer: 64 * 1024 * 1024,
      ...(process.platform === 'win32' ? { shell: true } : {}),
    }))
  } catch (error) {
    // `npm view` exits non-zero for a missing package AND still prints the
    // error document, so the payload is worth reading before giving up on it.
    stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    if (stdout.trim() === '') return `${spec}: npm view failed and said nothing: ${String(error?.message ?? error).split('\n')[0]}`
  }
  let manifest
  try {
    manifest = JSON.parse(stdout)
  } catch {
    return `${spec}: npm view returned something that is not JSON`
  }
  if (manifest?.error !== undefined) {
    const code = manifest.error.code ?? 'unknown'
    return code === 'E404'
      ? `${spec}: NOT ON THE REGISTRY — the publish did not land this package`
      : `${spec}: npm view refused with ${code}`
  }
  if (manifest?.dist?.attestations?.provenance === undefined) {
    return `${spec}: published WITHOUT a provenance attestation`
  }
  return undefined
}

// Argv overrides the manifests, and exists so the THREE outcomes above can be
// driven against real registry packages before a release depends on them:
// a signed one, an unsigned one, and one that is not there. Without it only the
// missing-package branch is reachable — the repository's own packages are all
// absent until the very publish this script is meant to check.
//   node scripts/assert-provenance.mjs sigstore@latest left-pad@1.3.0
const overrides = process.argv.slice(2).map((spec) => {
  const at = spec.lastIndexOf('@')
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: 'latest' }
})

const targets = overrides.length > 0 ? overrides : published()
if (targets.length === 0) {
  console.error('no publishable package found under packages/ — this script found nothing to check')
  process.exit(1)
}

const problems = []
for (const target of targets) {
  const reason = await verdict(target)
  if (reason === undefined) console.log(`provenance ok: ${target.name}@${target.version}`)
  else problems.push(reason)
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} of ${String(targets.length)} packages failed:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`\nall ${String(targets.length)} packages carry provenance`)
