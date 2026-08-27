import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The developer's OWN skills roots, and the proof that no test in this suite
// can reach them.
//
// This story is the first in which panda deletes from a filesystem, and these
// three directories hold real work: 38, 24 and 23 entries on the machine it was
// written on. Two earlier stories in this repository left files behind — one in
// the repository, which got committed, and one in the user's home on every run
// — so "every test injects its own home" is asserted here rather than trusted.
//
// A recursive name/size/mtime snapshot, taken before and after. It catches a
// deletion, an addition and an edit; it does not catch a write that restores the
// exact bytes and the exact mtime, which is not a failure mode any code here has.
//
// WHAT IT DELIBERATELY DOES NOT COVER, said plainly rather than implied. The
// scope is the SKILLS roots, which is the scope of this story's Never clause.
// The vendor binaries write elsewhere under their own homes on every run —
// measured for codex: `cache/codex_apps_tools`, `cache/codex_apps_server_info`,
// `tmp/arg0` and `models_cache.json` under the real `~/.codex`, despite an
// injected home. Widening the assertion to those directories would make it fail
// for a reason that is not panda's doing and is not stable between runs, so the
// fact is recorded in deferred-work.md instead of being asserted here.

export const REAL_SKILLS_ROOTS: readonly string[] = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.codex', 'skills'),
  join(homedir(), '.config', 'opencode', 'skills'),
  // Not one panda writes to, and covered anyway: measured, both codex and
  // opencode READ this root even under an injected home (27 of the 32 skills
  // codex listed came from here), so it is exactly the kind of directory a live
  // check could reach by accident.
  join(homedir(), '.agents', 'skills'),
]

async function walk(path: string, lines: string[], prefix: string): Promise<void> {
  let listing
  try {
    listing = await readdir(path, { withFileTypes: true })
  } catch (error) {
    // An absent root is a fact worth recording rather than skipping: a test that
    // CREATED one would otherwise change the snapshot in a way nothing noticed.
    lines.push(`${prefix} <unreadable ${(error as NodeJS.ErrnoException)?.code ?? 'error'}>`)
    return
  }
  for (const entry of [...listing].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      lines.push(`${prefix}/${entry.name} dir`)
      await walk(child, lines, `${prefix}/${entry.name}`)
      continue
    }
    const stats = await stat(child).catch(() => undefined)
    lines.push(`${prefix}/${entry.name} ${stats?.size ?? '?'} ${stats?.mtimeMs ?? '?'}`)
  }
}

/** A stable string identity for all three roots, contents included. */
export async function snapshotRealSkillsRoots(): Promise<string> {
  const lines: string[] = []
  for (const root of REAL_SKILLS_ROOTS) await walk(root, lines, root)
  return lines.join('\n')
}
