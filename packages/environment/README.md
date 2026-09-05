# @panda/environment

The verbs that change a machine: `init`, `doctor` and `remediate`, as a library.
`@panda/cli` is a thin binding over this package and holds no capability of its
own — that is FR-29, and the consumer-install proof enforces it.

```bash
npm i @panda/environment
```

## What it gives you

- **`initMachine` / `initProject`** — project the registry into every executor's
  NATIVE configuration, at the locations those executors actually read, and
  record what panda wrote so it can be taken back exactly.
- **`diagnose`** — every state panda can see, as a closed union of finding kinds.
  `FINDING_EXITS` is a `Record` over that union, so **a finding kind without a
  way out does not compile.**
- **`remediate`** — `adopt`, `release`, `repair` and `discard`, each the exit for
  a finding rather than a general-purpose editor.
- **`detectExecutors`** — which executors this machine has, with the evidence
  paths that decided it, so an absence is reportable rather than assumed.

## The rule it exists to keep

Panda writes NATIVE vocabulary at NATIVE locations and never invents a location a
vendor does not read. A concept no target can express is REPORTED as
`unprojectable` — never approximated into a namespace that would look right and
do nothing.
