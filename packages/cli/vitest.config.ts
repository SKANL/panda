import { defineConfig } from 'vitest/config'

// ponytail: one setting. `setupFiles` runs before every test file in this
// package and points the OS home directory at an empty temp directory, so no
// assertion here can be decided by the `~/.panda` of whoever ran the suite.
export default defineConfig({
  test: {
    setupFiles: ['./test/isolate-home.ts'],
  },
})
