import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeWorktree } from '@panda/session'

// The REAL interruption for spec M16.A's AC2. This process performs a real
// removal of a real worktree and is killed, for real, between the intent and the
// action — no mock of the code under test, no injected seam, no stub of git.
//
// What triggers the kill is the durable artifact ITSELF: the moment the removal
// writes its intent marker, this watcher sees the file appear and SIGKILLs its
// own pid. SIGKILL cannot be caught, so nothing unwinds, nothing is flushed and
// no cleanup runs — which is exactly the state a machine losing power leaves.
//
// It also records ONE observation before dying, synchronously: whether the tree
// was still on disk at the instant the intent became durable. That is D3's
// ordering — intent recorded BEFORE the action — and it is the half the end-state
// assertions cannot see. MEASURED: with the two lines swapped so the intent is
// written last, every other clause in the suite stayed green, because an
// interruption after the tree is already gone leaves an end state the sweep
// reaches just as well. This observation is what tells the two apart.
//
// It exits 0 if the removal ever COMPLETES, and the suite asserts a non-zero
// exit. That is deliberate: a race that quietly finished the removal would
// otherwise satisfy an "the sweep resolved it" clause while proving nothing.

const [stateDir, id, treePath, observationPath] = process.argv.slice(2)
if (stateDir === undefined || id === undefined || treePath === undefined || observationPath === undefined) {
  process.stderr.write('usage: interrupted-removal-child <stateDir> <id> <treePath> <observationPath>\n')
  process.exit(2)
}

const intentPath = join(stateDir, 'records', `${id}.removing.json`)
const watcher = setInterval(() => {
  if (!existsSync(intentPath)) return
  clearInterval(watcher)
  // Synchronous, and before the kill: there is no "after" for this process.
  writeFileSync(observationPath, JSON.stringify({ treeStillThere: existsSync(treePath) }), 'utf8')
  process.kill(process.pid, 'SIGKILL')
}, 1)

const outcome = await removeWorktree(stateDir, id)
clearInterval(watcher)
process.stdout.write(`${JSON.stringify(outcome)}\n`)
process.exit(0)
