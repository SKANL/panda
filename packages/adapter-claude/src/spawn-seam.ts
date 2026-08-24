// The child-process seam. The adapter talks to executors exclusively through this
// interface, so unit tests and the contract suite run against fake children while
// the real Node spawner (with Windows-safe process-tree termination) is exercised
// by the overhead measurement and the env-gated live smoke.

export interface SpawnOutcome {
  /** null when the process was killed by a signal or never spawned. */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  /** Set only when the process could not be spawned at all (e.g. missing binary). */
  readonly spawnErrorMessage?: string
  /** Set when a pipe to/from the child failed mid-run (e.g. EPIPE on stdin write). */
  readonly streamErrorMessage?: string
  readonly stdoutTruncated?: boolean
  readonly stderrTruncated?: boolean
}

export interface SpawnedChild {
  /** undefined when the platform refused to start the process. */
  readonly pid: number | undefined
  writeStdin(chunk: string): void
  endStdin(): void
  /**
   * Terminate the child AND every descendant it spawned. Idempotent; safe to
   * call even when the process already exited.
   */
  killTree(): void
  /** Resolves exactly once, after the whole tree has settled. Never rejects. */
  readonly done: Promise<SpawnOutcome>
}

export interface SpawnOptions {
  readonly cwd: string
}

export interface ChildProcessSpawner {
  spawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedChild
}
