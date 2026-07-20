# PR workflow dirty-checkout recovery

## What

Adds the architect-only `prepare_pr_workflow_checkout` controller for the
unbound `PR_REVIEW` and `PR_FEEDBACK` bootstrap phase. It preserves explicitly
named dirty tracked files in a path-scoped Git stash before the required PR-head
checkout, records an auditable recovery receipt under `.swarm/`, and returns the
exact stash-apply command after the workflow completes or aborts.

## Why

The PR workflow correctly denied a generic `git stash` shell mutation while its
instructions still required architects to stash a dirty checkout. That left
architects unable to bind the PR head or dispatch the required review lanes.
The controller closes that contradiction without permitting arbitrary Git stash
commands in the read-only gate.

## Safety

- Requires literal, repository-relative paths that exactly cover the complete
  dirty tracked checkout; untracked files are refused before any stash.
- Refuses untracked, protected, duplicate, post-bind, child-session, or
  in-flight-lane requests.
- Uses a fixed array-form Git invocation with ignored stdin, timeout, and
  best-effort process cleanup.
- Keeps the generic PR-workflow shell gate fail-closed for `git stash`.

## Migration

No user action is required. The PR review and PR feedback instructions now tell
architects to use the controller when tracked checkout changes are present.
