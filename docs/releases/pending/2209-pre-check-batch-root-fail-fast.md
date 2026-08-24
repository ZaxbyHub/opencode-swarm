# pre_check_batch: fail fast on invalid project roots; secretscan evidence failures now fail the gate

## What changed

Two consistency fixes for `pre_check_batch` (issue #2209):

1. **Fail-fast project-root validation.** When invoked with `directory` equal to the workspace anchor (the CLI-invoked-from-a-subdirectory shape), the tool's early boundary validation passed unconditionally, deferring the violation to evidence-write time — where it surfaced inconsistently: `secretscan` reported success while swallowing its evidence-write error, and `sast_scan`/`quality_budget` failed with `Cannot write evidence in "<sub>" — parent directory "<root>" already contains a .swarm/ folder…`. `runPreCheckBatch` now calls `assertProjectRoot` (reused unmodified — the same invariant the evidence writers enforce) before any tool executes: a directory nested inside an existing Swarm project without its own boundary marker fails immediately with a single consistent error across all four tool slots. Standalone directories without a `.swarm`-bearing ancestor and nested independent roots (own `.git`/`.opencode`) continue to pass.
2. **Secretscan evidence-write parity.** A failed secretscan evidence persistence is no longer a swallowed `warn()`: it sets the `secretscan` slot's `error` and fails the batch gate (`gates_passed: false`), mirroring how `sast_scan` and `quality_budget` treat evidence-write failures. The scan result itself (`ran: true`, findings) is unchanged.

## Why

The validation bypass let invalid-anchor runs produce mixed, misleading tool results; the swallowed evidence error hid critical runtime-state failures from the gate.

## Migration

No migration required. Runs anchored at a boundary-less subdirectory of an existing Swarm project that previously "passed" (with per-tool evidence errors buried in the payload) now fail fast with a clear message. Note: `assertProjectRoot` is reused unmodified and therefore also surfaces its pre-existing fail-CLOSED branches — a directory whose `realpathSync` throws, whose `.swarm`-bearing ancestor state is inaccessible (EPERM / ENOTDIR-class), whose ancestor search exceeds 20 levels, or whose ancestor project indicators are unreadable will now hard-fail at the pre-check-batch guard instead of deferring to evidence-write time.
