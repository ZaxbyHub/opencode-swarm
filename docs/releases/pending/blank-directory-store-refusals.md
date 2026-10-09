# Fix: session and trajectory stores no longer write `.swarm/` into the current directory for a blank root

## What

Three stores built their `.swarm/` paths with `path.join` / `path.resolve`
from the directory they were handed. A blank, whitespace-only or relative
directory therefore resolved against the process's current directory, and
`.swarm/` state (or a whitespace-named directory) was created wherever
OpenCode happened to run instead of in the project:
- `startAgentSession` (`src/state.ts`) now treats a blank or whitespace
  directory as absent, so no disk-touching step runs for it;
- the session-start store (`src/session/session-start-store.ts`) writes
  nothing and reads nothing for a directory that is not a non-blank absolute
  path;
- the trajectory store (`src/prm/trajectory-store.ts`) refuses such a
  directory instead of writing trajectories.

Every production caller passes the absolute hook or context directory, so
these paths are reached only through a caller bug.

## Known caveats

Other `.swarm/` stores (for example `getDiagnoseData` and the project
database) still resolve a blank directory against the current directory;
that is tracked in #3154.

## Migration

None.
