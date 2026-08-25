import type { ChildProcessSpawner, SpawnedChild, SpawnOptions, SpawnOutcome } from '../src/index.ts'

export const SUCCESS_STDOUT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Wrote panda-ok.txt\nAll done.',
})

/** Which stdin call the fake should blow up on, mimicking a broken pipe. */
export interface StdinFailure {
  readonly on: 'write' | 'end'
  readonly message: string
}

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
  readonly #stdinFailure: StdinFailure | undefined

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: SpawnOptions,
    autoOutcome?: SpawnOutcome,
    stdinFailure?: StdinFailure,
  ) {
    this.#autoOutcome = autoOutcome
    this.#stdinFailure = stdinFailure
    let resolve!: (outcome: SpawnOutcome) => void
    this.done = new Promise<SpawnOutcome>((res) => {
      resolve = res
    })
    this.#resolve = resolve
  }

  writeStdin(chunk: string): void {
    if (this.#stdinFailure?.on === 'write') throw new Error(this.#stdinFailure.message)
    this.stdinChunks.push(chunk)
  }

  endStdin(): void {
    if (this.#stdinFailure?.on === 'end') throw new Error(this.#stdinFailure.message)
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
  #stdinFailure: StdinFailure | undefined

  constructor(private readonly autoOutcome?: SpawnOutcome) {}

  /** Make every subsequent child throw on the named stdin call. */
  failStdin(on: StdinFailure['on'], message: string): void {
    this.#stdinFailure = { on, message }
  }

  spawn(command: string, args: readonly string[], options: SpawnOptions): FakeChild {
    const child = new FakeChild(command, args, options, this.autoOutcome, this.#stdinFailure)
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
