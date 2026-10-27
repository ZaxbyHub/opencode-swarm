# Rollback/close pipeline hardening: async checkpoint+align probes, fail-closed destruction enumeration, porcelain path containment

## What

Follow-ups from PR #3426, collated (issues #3427 + #3434):

- The checkpoint tool's entry preflight and `saveCheckpointRecord`'s probe
  now ride the shared async git reader (`readGitRepositoryStatusAsync`)
  instead of the local sync `gitExec` retry chain — on a host whose sync
  child spawns stall (#3275), `/swarm checkpoint` no longer blocks up to the
  transient-retry horizon (~150 s) before refusing. Behavior change to note:
  the entry preflight's refusal now names its cause — `not a git
  repository - …`, `git executable is not available - …`, or
  `git probe failed (<reader message>) - …` — instead of a single uniform
  text; `saveCheckpointRecord`'s probe keeps bounded transient tolerance
  (`readGitStatusAsync` retries a transient spawn failure once) so a
  single EBUSY/EPERM/ETIMEDOUT cannot silently record a SHA-less
  checkpoint. The finalize
  align stage's repository probe moved to the same reader through a new
  `readGitRepositoryStatusDetailedAsync` that preserves the exact
  `GitRepositoryStatus` reason vocabulary (`not_git_repo`,
  `git_unavailable`, `git_error`) the sync probe produced, including the
  #2236 three-way ENOENT cwd/binary split.
- The rollback destruction measurement now fails CLOSED when its
  `ls-tree`/`ls-files` enumeration cannot be read: `measureGitDestruction`
  reports `unreadable` with the structured cause instead of folding an
  empty in-the-way set into an `ok` measurement whose scope silently
  shrank below what `git reset --hard` would actually overwrite.
- Both porcelain parsers (NUL and newline forms) now exclude `../`-bearing
  (or absolute) records from the destroy scope and surface them as a
  bounded diagnostic on every consumer — the `/swarm rollback` preview and
  clean-tree restore, the checkpoint restore preview and clean-tree
  response, and the `/swarm close` early confirmation preview plus close
  summary warnings, and the confirmed destructive restore — instead of
  joining them into the confirm-token scope digest unvalidated. The
  interpolated record bytes are sanitized and bounded before rendering.
- The no-sync-spawn ratchet's `SCANNED_FILES` gains
  `src/commands/close/align-stage.ts` with a runtime membership self-pin —
  this asserts direct-spawn hygiene for that file; the probe conversion
  itself is guarded by dedicated suites (the checkpoint spawn-slot-counting
  suite for `src/tools/checkpoint.ts`, the awaited-call and true-repo legs
  for the align-stage seam), named as the different guards in the ratchet's
  own comment.

## Why

#3427 (priority:high): the two residual sync git probes sat on paths that
cross EVERY checkpoint invocation and the finalize pipeline — under the
#3275 loaded-host condition each probe could block ~150 s and then blame the
repository. #3434: an unreadable enumeration reading as "nothing in the
way" is the exact fail-open class #3317 closed for the status reads
("unreadable must never read as clean"), one call-site deeper — the
confirm token bound a scope smaller than the destruction; and porcelain
records joined the digest with no root-containment check anywhere on the
push path.
