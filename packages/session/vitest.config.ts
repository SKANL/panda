import { defineConfig } from 'vitest/config'

// ponytail: one setting. `setupFiles` runs before every test file in this
// package and points the OS home directory at an empty temp directory. This
// package OWNS `resolveExecutor`, whose production default is `os.homedir()` —
// every call in the suite passes `homeDir` explicitly today, which makes it
// clean by luck rather than by construction, and one future `resolveExecutor({})`
// would silently start reading the real machine.
export default defineConfig({
  test: {
    setupFiles: ['./test/isolate-home.ts'],
  },
})
