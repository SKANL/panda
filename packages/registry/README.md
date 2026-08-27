# @panda/registry

Canonical environment registry: scoped storage (`global | project | agent`) for
skill, mcp-server and profile entry envelopes (defined in `@panda/contracts`), with machine-scoped write serialization via a hand-rolled
portable lockfile protocol, atomic persistence (temp + rename), and write-time
path normalization for paths under the user home directory.

Mounts as a real plugin on the `@panda/kernel` lifecycle via
`createRegistryPlugin()` — activation wires the store, disposal releases any
held lock.
