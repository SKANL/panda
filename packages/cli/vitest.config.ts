import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // ponytail: one setting. `setupFiles` runs before every test file in this
    // package and points the OS home directory at an empty temp directory, so no
    // assertion here can be decided by the `~/.panda` of whoever ran the suite.
    setupFiles: ['./test/isolate-home.ts'],
    // vitest 4 dropped `**/dist/**` from `defaultExclude` (2 and 3 carried it).
    // Nothing under `src/` is a test file today, so this changes nothing now —
    // it stops the first colocated `*.test.ts` anyone adds from being collected
    // twice on every machine that has run the build.
    exclude: [...defaultExclude, '**/dist/**'],
  },
  // `@skanl/panda-*` resolves to SOURCE inside this repository through one custom
  // export condition, the same name `tsconfig.base.json` sets. Without it vitest
  // reads each manifest's `default` — `dist/` — and the whole suite would demand
  // a build before it could run.
  //
  // Under `ssr`, not `resolve`: vitest 4 drives the node environment through the
  // SSR pipeline, and `resolve.conditions` alone was measured not to reach it
  // (it still failed with "Failed to resolve entry for package @skanl/panda-kernel").
  ssr: { resolve: { conditions: ['panda-source'] } },
})
