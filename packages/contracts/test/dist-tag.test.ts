import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The dist-tag a release publishes under, decided by the version rather than
 * hardcoded.
 *
 * `release.yml` hardcoded `--tag latest`, and its own comment argues that
 * correctly FOR A STABLE VERSION: driven through npm's `npm-pick-manifest`, a
 * packument whose only dist-tag is `next` still resolves for a bare `npm i`,
 * because a tagless install becomes the range `*`. Only a PRERELEASE VERSION
 * hides a release, and the comment concludes that a version change "is out of
 * scope".
 *
 * BUT THE TAG GATE ACCEPTS ONE. `release.yml`'s version check is a plain string
 * comparison — `TAG="${GITHUB_REF_NAME#v}"` against the contracts manifest — so
 * `v0.1.0-rc.1` passes it and is then published as `latest`, which is the one
 * outcome a prerelease exists to avoid. The workflow accepts an input it
 * mislabels, and nothing anywhere fails when it does.
 *
 * Driven as a CHILD PROCESS, exactly as the workflow invokes it, because a
 * classifier that is only ever executed at the one irreversible moment is a
 * classifier nobody has run.
 */

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'dist-tag.mjs')

function tagFor(version: string): string {
  return execFileSync(process.execPath, [SCRIPT, version], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

describe('the dist-tag a release publishes under', () => {
  it.each([
    ['0.1.0', 'latest'],
    ['10.20.30', 'latest'],
    // Build metadata is NOT a prerelease: `1.0.0+build.5` is a stable release
    // that happens to record how it was built.
    ['0.1.0+build.5', 'latest'],
    ['0.1.0-rc.1', 'rc'],
    ['1.0.0-beta.0', 'rc'],
    ['2.0.0-next.3', 'rc'],
    ['1.0.0-rc.1+build.9', 'rc'],
  ])('publishes %s under %s', (version, expected) => {
    expect(tagFor(version)).toBe(expected)
  })

  it('REFUSES a version it cannot classify, rather than guessing latest', () => {
    // Failing closed matters more here than anywhere else in the repository: a
    // classifier that shrugged and said `latest` would put whatever it could not
    // read on the tag every bare `npm i` resolves.
    for (const bad of ['', 'v1.0.0', '1.0', 'not-a-version']) {
      expect(() => tagFor(bad), `'${bad}' was classified instead of refused`).toThrow()
    }
  })

  it('CONTROL: it reads the workspace version when given no argument', () => {
    // The workflow passes no version; it must agree with what the tag gate
    // compared against.
    const manifest = join(import.meta.dirname, '..', 'package.json')
    const version = (JSON.parse(execFileSync(process.execPath, ['-p', `JSON.stringify(require(${JSON.stringify(manifest)}))`], { encoding: 'utf8' })) as { version: string }).version
    expect(execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).trim()).toBe(tagFor(version))
  })
})
