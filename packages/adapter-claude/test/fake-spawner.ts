import type { ChildProcessSpawner, SpawnedChild, SpawnOptions, SpawnOutcome } from '../src'

export const SUCCESS_STDOUT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Wrote panda-ok.txt\nAll done.',
})

/**
 * In-process child double. Children settle one microtask after their trigger so
 * adapters observe realistic async completion; killTree() settles immediately
 * with an unsignalled-null outcome, like a force-killed OS process tree.
 */
export class FakeChild implements SpawnedChild {
  pid: number | undefined = 4242
  killed = false
  settled = false
  readonly stdinChunks: string[] = []
  stdinEnded = false
  readonly done: Promise<SpawnOutcome>
  readonly #resolve: (outcome: SpawnOutcome) => void
  readonly #autoOutcome: SpawnOutcome | undefined

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: SpawnOptions,
    autoOutcome?: SpawnOutcome,
  ) {
    this.#autoOutcome = autoOutcome
    let resolve!: (outcome: SpawnOutcome) => void
    this.done = new Promise<SpawnOutcome>((res) => {
      resolve = res
    })
    this.#resolve = resolve
  }

  writeStdin(chunk: string): void {
    this.stdinChunks.push(chunk)
  }

  endStdin(): void {
    this.stdinEnded = true
    if (this.#autoOutcome !== undefined) {
      const outcome = this.#autoOutcome
      queueMicrotask(() => this.#settle(outcome))
    }
  }

  killTree(): void {
    if (this.killed) return
    this.killed = true
    this.pid = undefined
    this.#settle({ exitCode: null, stdout: '', stderr: '' })
  }

  #settle(outcome: SpawnOutcome): void {
    if (this.settled) return
    this.settled = true
    this.#resolve(outcome)
  }
}

export class FakeSpawner implements ChildProcessSpawner {
  readonly children: FakeChild[] = []

  constructor(private readonly autoOutcome?: SpawnOutcome) {}

  spawn(command: string, args: readonly string[], options: SpawnOptions): FakeChild {
    const child = new FakeChild(command, args, options, this.autoOutcome)
    this.children.push(child)
    return child
  }

  /**
   * The orphan-detection surface: children neither killed nor allowed to finish.
   */
  get orphans(): FakeChild[] {
    return this.children.filter((child) => !child.killed && !child.settled)
  }
}
