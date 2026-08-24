#!/usr/bin/env node
import { runPanda } from '../src/run.ts'

// `panda run ... | head` must not crash: a closed stdout pipe surfaces as an
// async EPIPE error on the stream, which we treat as a graceful exit.
process.stdout?.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
})

process.exitCode = await runPanda(process.argv.slice(2))
