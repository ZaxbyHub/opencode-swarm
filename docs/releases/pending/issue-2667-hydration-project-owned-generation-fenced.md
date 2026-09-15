# Hydration is project-owned and authority-fenced

## What

Hydration (restoring one project's session snapshot into live state) no longer
clears process-global state it does not own, and a stale hydration callback can
no longer publish over newer state:

- `rehydrateState` (`src/session/snapshot-reader.ts`) with a project directory
  evicts only that project's own snapshot-derived sessions (ownership stamp +
  hydration generation), leaving every other plugin instance's live sessions,
  unowned sessions, and non-owned tool aggregates untouched. Single-project
  replace semantics are preserved: a project's own re-hydration still replaces
  its own snapshot state. Calling it without a directory keeps the legacy
  clear-all (direct-test path only).
- Each hydration initiation (`loadSnapshot` entry, SQLite snapshot
  coordination initialization and retries) captures an exact authority scope
  from `src/session/hydration-ownership.ts`: a per-project generation plus a
  process-monotonic epoch that cannot be reused after bounded-registry eviction
  or reset. An apply whose authority has been superseded is refused with zero
  mutation — a timed-out initializer that settles late can no longer wipe
  state written by a newer generation. Live sessions created while a hydration
  is in flight carry a stamp above it and survive that hydration's own apply.
- The plan/evidence rehydration cache is per-project instead of a
  process-global singleton: whichever project built the cache last no longer
  feeds foreign workflow states to another project's new sessions.
- `ensureAgentSession`/`startAgentSession` creation paths now thread the
  plugin instance's project directory (chat.message delegation tracker,
  index.ts hook paths, cohort cache, delegation-gate parent-session sites;
  worktree child sessions keep their lane root), so live sessions are
  ownership-stamped at creation.

## Why

Two plugin instances in one process (or one project's hydration racing
another's) previously wiped each other's live session state: `rehydrateState`
cleared the shared `agentSessions`/`activeAgent`/`delegationChains`/
`toolAggregates` maps unconditionally, and the `withTimeout` wrappers around
`loadSnapshot` and coordination initialization abandoned the await without
fencing the eventual apply. A missing snapshot also overwrote the shared
rehydration cache, bleeding one project's plan-derived task states into
another project's sessions (issue #2667).

## Notes

- New session fields `owningProjectKey` and `hydrationStamp` are never
  serialized; the snapshot field-parity guard covers them.
- The new per-project registries are bounded (FIFO, 32 projects) with an
  explicit `resetSwarmState` reset path. The small authority-epoch scalar is
  deliberately process-monotonic across resets so an old token can never
  become current again. Canonical project keys resolve through a bounded memo
  (one realpath per directory spelling per process — no new init-path
  filesystem cost).
- Ownership and generation rules are documented in
  `docs/plan-durability.md` § Live-State Ownership and Hydration Fencing.
