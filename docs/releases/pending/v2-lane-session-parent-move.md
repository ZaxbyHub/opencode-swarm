# OpenCode 2.x: worktree-isolated coders can be resumed again

## What

On the OpenCode 2.x hosts tested (2.0.26, 2.1.4 and 2.2.5), every worktree-isolated
coder dispatch failed with "Session … is not a child of the current session". The plugin's v2 session
shim created each worktree-lane session without a parent (on OpenCode 2.0.x a
parentless create honours a foreign directory, while a parented one does not),
but the host's
native `subagent` tool only resumes sessions whose recorded parent is
the calling session.

The shim now creates the lane session as a real child of the dispatching
session and then moves it into the lane worktree with the host's
`session.move`, re-reading the session until it reports the lane directory.
Hosts that already place a parented session in the requested directory are not
moved. Every placement step after the create has a time limit and honours the
caller's cancellation: each placement read is limited to 1 second, the
confirmation re-reads to about 5 seconds in total, and the move to 10 seconds.
Because the host cannot cancel a move, a move that times out or is cancelled
is given up to 10 more seconds to finish before the session is removed. If the
move is rejected, unavailable, or never observed, or the host returns
something other than a promise, the created session is removed and the
dispatch degrades through the existing `STANDARD_WORKTREE_SESSION_CREATE_FAILED`
path, exactly as a placement mismatch did before.

If a move still has not finished when the session is removed, the error text
says the removal is unconfirmed and names the session (`cleanupUnconfirmed`).
This is informational only: it reaches the architect inside the
`STANDARD_WORKTREE_SESSION_CREATE_FAILED` message, the lane is torn down
regardless, and no code acts on the flag (the existing `cleanupFailed` flag
works the same way).

## Who is affected

- Users running opencode-swarm on OpenCode 2.1+ with worktree isolation
  enabled (including Epic Mode's isolated coders): isolated coder dispatch works
  again. Verified live end to end on OpenCode 2.1.4 and 2.2.5, and (A/B) on 2.0.26.
- OpenCode 2.0.26 hosts take the same path (parented create, then
  `session.move`); there is no version gate. The 2.0.26 host contains the same
  resume check, so isolated coders failed there too: an A/B on 2.0.26 shows the
  unpatched build failing with "not a child of the current session" and the
  patched build resuming the lane and running the coder in it. A placement
  failure fails closed exactly as on 2.1+.
- Factory/ephemeral helper sessions (for example the knowledge curator)
  started from inside a lane for a directory outside it: these are now parented
  children of the lane session, moved to the project root. Before, they were
  created parentless in the project root.
- OpenCode 1.x hosts are unaffected.

## Migration

None. A `worktree.policy: "disabled"` workaround added for this bug can be
removed after upgrading.
