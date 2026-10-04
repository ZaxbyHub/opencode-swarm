# Fix: parallel coder lanes no longer hard-stop each other on the lifecycle lock

## What

Every isolated coder lane takes the worktree lifecycle lock while it is
provisioned. Init orphan recovery takes it too. The lane holds it across the
collision check (a git spawn) and the owner write. A dispatch gave up after
about 310 ms (5 retries without jitter) and hard-stopped with
`STANDARD_WORKTREE_LIFECYCLE_BUSY: init orphan recovery is active`. Parallel
coders provisioning at the same moment therefore stopped each other, and the
message blamed a recovery that was not running.

Provisioning now keeps retrying with jitter for up to 10 seconds. If the lock
is still busy after that, the message says so and names both possible holders.
