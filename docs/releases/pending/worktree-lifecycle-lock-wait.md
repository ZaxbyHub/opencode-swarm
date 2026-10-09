# Fix: parallel coder lanes no longer hard-stop each other on the lifecycle lock

## What

Every isolated coder lane takes the worktree lifecycle lock while it is
provisioned. Init orphan recovery takes it too. The lane holds it across the
collision check (a git spawn) and the owner write. A dispatch gave up after
about 310 ms (5 retries without jitter) and hard-stopped with
`STANDARD_WORKTREE_LIFECYCLE_BUSY: init orphan recovery is active`. Parallel
coders provisioning at the same moment therefore stopped each other, and the
message blamed a recovery that was not running.

Provisioning now keeps retrying with jitter. The wait follows
`worktree.session_create_timeout_ms`, because a lane can hold the lock across
a recovery-lane `session.create` bounded by that setting: the wait is that
budget plus 5 seconds, at least 10 seconds, and short enough that the waiting
dispatch can still run its own `session.create` and provision its worktree
(15 seconds are kept for that) inside the 60-second OpenCode 2 hook budget.
With the default 30-second budget the wait is 10 seconds; with 20 seconds it
is 20 seconds, and with 10 seconds it is 15 seconds. Above a 30-second
budget no room is left and the wait stays at 10 seconds, so a waiting
dispatch can then exceed the hook budget (61 seconds at a 31-second budget,
90 seconds at 60): keep `worktree.session_create_timeout_ms` at 30 seconds or
less on OpenCode 2. If the lock is still busy after the
wait, the message says so, names both possible holders and names
`worktree.session_create_timeout_ms`.
