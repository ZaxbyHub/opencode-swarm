# Session snapshot writer: retry transient Windows rename failures

## What

`writeSnapshot` (`src/session/snapshot-writer.ts`) performed its atomic
temp-file swap with a bare `renameSync`, inside a `catch` block that only logs.
The rename now retries on the transient Windows sharing-violation codes
(`EEXIST` / `EBUSY` / `EPERM`) with the same bounded policy the repository's
own write shim already applies — 3 attempts, 50 ms apart, same codes (one
deliberate difference: `bunWrite` also sleeps after its final attempt; this
loop skips that pointless terminal sleep) — and breaks
immediately on any other error code.

Two supporting changes:

- On permanent rename failure the writer best-effort `unlink`s its own temp
  file, so a persistently locked `state.json` no longer accumulates one
  orphaned `state.json.tmp.*` per `tool.execute.after` under
  `.swarm/session/`.
- The rename is routed through the module's existing `_internals`
  dependency-injection seam (`_internals.rename`), so the retry path is
  testable without `mock.module`.

`invalidateCachedArtifact` still runs only after a genuinely successful swap,
preserving the issue #1729 cache-invalidation ordering.

## Why

`src/utils/bun-compat.ts` documents this exact failure mode and defends against
it: `WINDOWS_RENAME_MAX_RETRIES = 3` with an `EEXIST`/`EBUSY`/`EPERM` retry loop
in `bunWrite`. On Windows, a second process holding the destination open — an
external reader tailing `.swarm/session/state.json`, or an antivirus scanner —
makes `rename` fail transiently.

The snapshot writer was the highest-frequency writer without this defense on
its canonical-file swap — it is not the only one: `src/commands/handoff.ts`
(`handoff.md`, `handoff-prompt.md`) and `src/evidence/task-file.ts`
(`atomicWriteFile`) still perform bare `renameSync` swaps with the same
transient exposure; unifying those behind a shared retrying helper is the
remaining scope of #2035. Because the snapshot writer's `catch` only logs, a
transient failure silently degraded an atomic
update into a dropped one: the snapshot on disk stayed at its previous
contents while the in-memory `swarmState` moved on. The writer runs on every
`tool.execute.after`, so any consumer reading the snapshot (handoff, phase
resume, session rehydration) could observe stale session state with no error
surfaced anywhere.

## Migration

No migration required. The change is internal to the snapshot write path:

- No schema, format, or field change to `.swarm/session/state.json` — the
  snapshot is still `version: 3`.
- No public tool, agent, or command surface changes.
- Error behavior is unchanged from the caller's perspective: `writeSnapshot`
  still swallows failures and never throws, so it cannot crash the plugin.

## Caveats

- The retry budget is deliberately duplicated in `snapshot-writer.ts` rather
  than imported from `src/utils/bun-compat.ts`. Several test files mock
  `../utils/bun-compat` with non-spreading `mock.module` factories, and Bun
  fails module resolution when a real module imports an export such a factory
  omits — so adding a new shared export to `bun-compat` would break unrelated
  suites. The budget is exported as `SNAPSHOT_RENAME_MAX_ATTEMPTS` so tests
  assert against the real constant instead of a hand-copied literal.
- The retry covers transient *rename* failures only. It does not attempt to
  make the write durable against a permanently locked target; after the budget
  is exhausted the failure is still logged and swallowed, as before.
- The post-failure temp cleanup is best-effort: the `finally` `unlink` swallows
  its own errors, so if something (e.g. a scanner holding the freshly written
  temp open on Windows) blocks that unlink, an orphaned `.tmp.*` file can
  still remain.
- Simulated retry behavior is verified through the `_internals.rename` seam.
  The underlying Windows sharing-violation timing is not reproduced in CI —
  the same limitation applies to the pre-existing `bunWrite` retry loop.
