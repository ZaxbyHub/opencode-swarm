# Fix: `.swarm` stores no longer resolve a blank project root against the process cwd

## What

A blank or whitespace project directory names no project, but several
`.swarm/` stores resolved it against `process.cwd()` and read or wrote
`.swarm/` in whatever directory the process happened to run in:

- `getProjectDb` (the shared `.swarm/swarm.db` handle) created and opened
  `<cwd>/.swarm/swarm.db`. It now throws a typed `ProjectDbError` with the new
  category `invalid_root`. `projectDbPath` throws the same error;
  `projectDbExists` returns false and `withProjectDbReadOnly` returns null for a
  blank root, so neither can report a database found under the cwd.
  `closeProjectDb` ignores a blank root instead of closing the cwd project's
  handle.
- `getDiagnoseData` (`/swarm diagnose`) diagnosed the cwd. For a blank or
  relative root it now returns one failing "Project directory" check.
- The consensus corpus read `<cwd>/.swarm/`: `listTrajectorySessions` listed
  `.swarm/trajectories` and `listEvaluationRunIds` listed
  `.swarm/evolution/runs`. Both now throw for a blank or relative root,
  matching the PRM trajectory store. `loadConsensusCorpus` and the
  `consensus_mine` tool's boundary, `mineAndStoreConsensusV1`, throw before
  reading anything, including the prior consensus reports.
- Three shared write paths created or appended to `<cwd>/.swarm/`:
  - `assertProjectRoot`, the project-root check that guards runtime-state
    writers such as the knowledge receipt ledger, accepted a blank root
    because `realpath('')` is the cwd. It now throws, so `/swarm doctor` with
    a blank root no longer creates `.swarm/knowledge-receipts-v2.jsonl` in
    the cwd.
  - `appendCoreEventSync` and `appendCoreEventsSync`, the single append seam
    for `.swarm/events.jsonl`, throw `CORE_EVENT_NO_STORE` for a blank root
    before touching the filesystem. Producers that catch append failures
    skip the event; the task-repair and coder-retry circuit-breaker audit
    producers, which rethrow anything other than a locked store, fail the
    operation.
    `recordSteeringConsumed` no longer appends to the cwd's event log.
  - `initTelemetry` ignores a blank root instead of creating
    `.swarm/telemetry.jsonl` in the cwd, and keeps any stream that is
    already open.
- Plugin init with a blank directory wrote its bootstrap state (advisories,
  `config.example.json`, bundled skills, locks, telemetry) into the cwd.
  `resolveProjectRootDecision`, the init form of `assertProjectRoot`, now
  fails closed for a blank root, so init loads without writing `.swarm/`
  state, as it already did when the project root could not be determined.
- `writeSnapshot` (the session snapshot) created `.swarm/swarm.db` and the
  snapshot projection in the cwd; the `getProjectDb` guard above now stops
  it.

The session-start and trajectory stores already refused such a root (#3146);
they and the new guards share one helper, `isNonBlankAbsoluteDirectory` /
`isBlankDirectory` in `src/utils/path-security.ts`.

Every production caller passes an absolute project root, so normal use is
unchanged.

## Known caveat

`getProjectDb` still resolves a RELATIVE root. `save_plan` and `declare_scope`
pass a caller-supplied relative `working_directory` straight through, so
refusing relative roots there would turn their current behavior into a
failure. Resolving that argument against the project root belongs to those
tools and is not changed here.

## Migration

None.
