// `tsc` overwrites its outputs but never removes them, so a module deleted or
// renamed in `src/` leaves its emitted twin in `dist/` — where it still
// resolves, still packs and still installs. A reviewer wrote `dist/deleted-
// module.js` by hand, rebuilt, and it survived into the tarball.
//
// Runs in the package directory, immediately before `tsc -p tsconfig.build.json`.
import { rm } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
