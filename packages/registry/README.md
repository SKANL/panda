# @skanl/panda-registry

Canonical environment registry: scoped storage (`global | project | agent`) for
skill and mcp-server entry envelopes (defined in `@skanl/panda-contracts`), with machine-scoped write serialization via a hand-rolled
portable lockfile protocol, atomic persistence (temp + rename), and write-time
path normalization for paths under the user home directory.

Mounts as a real plugin on the `@skanl/panda-kernel` lifecycle via
`createRegistryPlugin()` — activation wires the store, disposal releases any
held lock.
