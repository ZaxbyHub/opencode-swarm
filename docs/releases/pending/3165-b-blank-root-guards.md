# Fix: the project DB, plugin init and the shared `.swarm` write paths refuse a blank project root

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
  The agent tool snapshot (`getAgentConfigs`) checked only for an empty
  string, so a whitespace root still wrote
  `<cwd>/<spaces>/.swarm/evidence/agent-tools-*.json`; it now skips a blank
  root.
- `/swarm reset-session` and `/swarm close` with a blank root backed up and
  deleted the cwd project's session files. Both now refuse a blank root.
- The `swarm.db` stores that canonicalize the root before opening the
  database never reached the `getProjectDb` guard, because
  `canonicalProjectKey('')` is the absolute cwd. They now refuse a blank root
  first:
  - `getGroupCommitWriter`, `appendObservabilityEventDb`,
    `syncObservabilityImport`, the phase-report and insight-candidate writers
    and the legacy importers throw `ProjectDbError` (`invalid_root`) before
    any state changes. Before, they created `<cwd>/.swarm/swarm.db` (a
    whitespace root created a whitespace-named directory) or wrote through the
    cwd project's cached writer.
  - The snapshot-coordination entry points (`ensureSnapshotCoordinationReady`,
    `startSnapshotCoordinationInitialization`,
    `retrySnapshotCoordinationInitialization`) reject or throw the same error
    instead of initializing the cwd project's coordination, so `writeSnapshot`
    with a blank root no longer touches it.
  - The close, status and lookup paths (`closeGroupCommitWriter`,
    `markSnapshotCoordinationClosing`, `beginSnapshotCoordinationReset`,
    `getSnapshotCoordinationStatus`, `getDashboardHandle`, the dashboard close
    functions) treat a blank root as a no-op or not-found, so plugin dispose
    with a blank root no longer closes the cwd project's writer or
    coordination. The phase-report, insight-candidate and observability
    coverage reads return their empty result (`[]`, 0 or null).
    `registerObservabilityEventSink` ignores a blank root, and
    `startDashboardServer` disables itself for a whitespace root (it already
    did for `''`).
  - `getSwarmDbHealthSnapshot` reports an `invalid_root` error for a blank
    root instead of a healthy "absent" database.

The session-start and trajectory stores already refused such a root (#3146);
they and the new guards share one helper, `isNonBlankAbsoluteDirectory` /
`isBlankDirectory` in `src/utils/path-security.ts`.

A caller that passes a non-blank root sees no change. The guards only
refuse a blank root; a relative root still resolves as before (see below).

## Known caveats

Not every `.swarm` store is guarded yet. These still join a blank root with
`.swarm/` (so they resolve under the cwd) and stay tracked in #3165 B:
`src/plan/ledger.ts` (ledger and `plan.json` paths),
`src/council/council-round-state.ts`, `src/context-map/persistence.ts`,
`src/memory/storage-root.ts`, `src/consensus/store.ts` (reached in production
only after the guarded consensus boundary) and the compaction rehydration
cache (`src/hooks/compaction-customizer.ts`, in memory only).

`getProjectDb` still resolves a RELATIVE root. `save_plan` and `declare_scope`
pass a caller-supplied relative `working_directory` straight through, so
refusing relative roots there would turn their current behavior into a
failure. Resolving that argument against the project root belongs to those
tools and is not changed here.

## Migration

A caller of the guarded paths above that passed a blank root used to read or
write the process cwd's `.swarm/` state. It now gets a typed error (`ProjectDbError` `invalid_root`,
`CORE_EVENT_NO_STORE`, or the corpus and project-root errors), `false`,
`null`, an empty result, a refusal message, or a no-op. Pass the project root
instead.
