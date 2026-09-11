# Close remaining subprocess lifetime gaps at three probe sites (#2674)

## What

Three production subprocess callers gained the full bounded, killable caller
contract required by AGENTS.md invariant 3:

- `src/knowledge/identity.ts` — `getGitRemoteUrl` (the legacy
  `writeProjectIdentity` path) now runs `git remote get-url` through a
  file-scoped `_internals.execFileSync` seam with `stdin` ignored
  (`stdio: ['ignore', 'pipe', 'ignore']`) and an explicit 1 500 ms timeout,
  matching its already-compliant sibling `deriveProjectHash`.
- `src/services/diagnose-service.ts` — `checkGitRepository` (the
  `/swarm diagnose` git probe) runs `git rev-parse --git-dir` through the
  module's extended `_internals` seam with all-ignored stdio (its output was
  already discarded) and an explicit 3 000 ms timeout.
- `src/tools/complexity-hotspots.ts` — `getGitChurn` now passes
  `stdin: 'ignore'` and `timeout: 2 000` to `bunSpawn`, races the read against
  the same 2 000 ms bound caller-side, and kills the owned child in a
  `finally` on every exit path (mirroring `resolveCurrentGitHeadAsync` in
  `pr-workflow-status.ts`). A hung child can no longer leave the tool's await
  pending forever.
- `docs/engineering-invariants.md` gained the caller-contract table
  (timeout / stdin-stdio / cwd / output bound / cleanup) for the three
  functions.

Tests: a new tracked contract test pins the options and the hung-child
settle+kill bound at all three sites through the `_internals` seams; the one
`diagnose-git-repository.test.ts` assertion that pinned the old unbounded
options shape was updated to the bounded shape.

## Why

Issue #2674 (Workstream A, PR 11 of 12): a caller that leaves stdin open,
fails to consume output, or ignores cancellation can hang the host even when
the higher-level await has a timeout. All three sites predated the bounded
spawn contract: two synchronous probes had no timeout at all (an unbounded
event-loop block on a hung child), and the churn analysis had no timeout, no
ignored stdin, and no kill-in-finally — reproduced live with a hung child
still pending after 2.5 s with zero kill calls.

## Migration

No public API changes; the `_internals` additions and the exported
`GIT_REPOSITORY_CHECK_TIMEOUT_MS` constant are additive. One behavior
tightening, deliberate: a churn run that exceeds the new 2 s bound now fails
closed with an error naming the bound (surfaced through the tool's existing
`analysis failed:` error JSON) instead of eventually completing; the two sync
probes degrade to their existing fallback paths on timeout (no remote /
failing health row). `deriveProjectHash` was already compliant and is
untouched.
