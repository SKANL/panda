// Counts the module graph `panda --version` pays for, and prints it as JSON.
//
// A CHILD PROCESS on purpose: the count has to be of a cold graph, and vitest's
// own process has already loaded most of this workspace.
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const loaded = new Set()
let bytes = 0

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && !loaded.has(url)) {
      loaded.add(url)
      try {
        bytes += readFileSync(fileURLToPath(url)).byteLength
      } catch {
        // A module the loader synthesised rather than read: counted, not sized.
      }
    }
    return nextLoad(url, context)
  },
})

await import(process.argv[2])
process.stdout.write(JSON.stringify({ modules: loaded.size, bytes }))
