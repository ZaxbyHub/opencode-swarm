# OpenCode 2.1+: worktree-isolated coders can be resumed again

## What

On OpenCode 2.1 and later, every worktree-isolated coder dispatch failed with
"Session … is not a child of the current session". The plugin's v2 session
shim created each worktree-lane session without a parent (on OpenCode 2.0.x
that was the only way to place a session in a foreign directory), but the 2.1
host's native `subagent` tool only resumes sessions whose recorded parent is
the calling session.

The shim now creates the lane session as a real child of the dispatching
session and then moves it into the lane worktree with the host's
`session.move`, re-reading the session (bounded, about two seconds) until it
reports the lane directory. Hosts that already place a parented session in the
requested directory are not moved. If the move is rejected, unavailable, or
never observed, the created session is removed and the dispatch degrades
through the existing `STANDARD_WORKTREE_SESSION_CREATE_FAILED` path, exactly as
a placement mismatch did before.

## Who is affected

Users running opencode-swarm on OpenCode 2.1+ with worktree isolation enabled
(including Epic Mode's isolated coders). OpenCode 1.x hosts are unaffected.

## Migration

None. Workarounds such as `worktree.policy: "disabled"` can be removed after
upgrading.
