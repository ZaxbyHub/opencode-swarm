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
