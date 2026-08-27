# Worktree Redispatch Recovery Status

- `/swarm lanes` now surfaces worktree recovery authority details for conflicted lanes instead of only generic manual hints.
  - Human output shows the preserved generation, original lane identity, reservation, parent session, strategy, and any active claimant.
  - JSON output now includes a `recovery` block plus a `manualRecoveryHint` when operators still need the underlying merge guidance.
- Conflicted lanes now distinguish between:
  - exact same-task redispatch being available,
  - the preserved lane already being claimed by a retry,
  - legacy or uncertain metadata forcing manual recovery.
- The main-bundle smoke tripwire is raised from 7.5 MiB to 8.5 MiB to retain
  cross-platform headroom for the durable recovery implementation. The build
  remains size-checked; this follows the repository's existing cap-bump policy
  for intentional source growth.

Why this matters:

- Issue #2105 was about making preserved worktree recovery end-to-end and observable. Once the backend can safely reclaim a preserved lane, operators need `/swarm lanes` to say that explicitly instead of implying every conflicted lane is a manual-only rescue.

Migration:

- None. Existing lane commands still work; they now return richer recovery state for conflicted lanes.

Caveats:

- Legacy or malformed recovery metadata still falls back to manual recovery guidance. In those cases `/swarm lanes` now says that same-task redispatch is unavailable instead of silently pretending the recovery path exists.
