#!/usr/bin/env node
// Prints the npm dist-tag a release must publish under, derived from the version
// instead of hardcoded.
//
// WHY THIS EXISTS AS A FILE, and not as a `case` in `release.yml`: the same
// reason `assert-provenance.mjs` does. A step that only ever runs at the one
// irreversible moment is a step nobody has driven, and this one decides which
// tag every bare `npm i` resolves.
//
// WHAT IT FIXES. `release.yml` published with `--tag latest`, hardcoded, and its
// own comment argues that correctly FOR A STABLE VERSION: driven through npm's
// `npm-pick-manifest`, a packument whose only dist-tag is `next` still resolves
// for a bare `npm i`, because a tagless install becomes the range `*`. Only a
// PRERELEASE VERSION hides a release. The comment then concludes that a version
// change "is out of scope" — but the workflow's tag gate is a plain string
// comparison, so `v0.1.0-rc.1` PASSES it and is published as `latest`, which is
// the single outcome a prerelease exists to avoid. The workflow accepted an
// input it mislabelled and nothing failed when it did.
//
// IT FAILS CLOSED. A version this cannot classify exits non-zero rather than
// falling back to `latest`: shrugging would put whatever it could not read on
// the tag every consumer gets by default, which is the exact harm.
//
// Run it by hand: `node scripts/dist-tag.mjs [version]`. With no argument it
// reads the workspace version, which is what `release.yml` compares the git tag
// against.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// The official semver grammar, anchored. `prerelease` is group 4 and build
// metadata is group 5, which is the distinction that matters: `1.0.0+build.5` is
// a STABLE release that records how it was built, not a prerelease.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export function distTagFor(version) {
  const matched = SEMVER.exec(version)
  if (matched === null) {
    throw new Error(
      `'${version}' is not a semantic version, so no dist-tag can be derived from it; a release must not guess`,
    )
  }
  // `rc`, not `next`: it says what the version already says, and the workflow's
  // own measurement is that the TAG gates nobody — the prerelease version does.
  return matched[4] === undefined ? 'latest' : 'rc'
}

function workspaceVersion() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(readFileSync(join(root, 'packages', 'contracts', 'package.json'), 'utf8'))
  return manifest.version
}

const requested = process.argv[2]
const version = requested === undefined ? workspaceVersion() : requested
try {
  process.stdout.write(`${distTagFor(version)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
