# Worktree-isolated coders can write again

## What

Fixes the class of failure where a coder running in an isolated worktree was
blocked from every single write with `SCOPE_NOT_DECLARED`, even though the
architect had declared a perfectly valid scope for its task.

## Before

Two independent breakages produced the same symptom.

1. **Standard worktree dispatch.** The write gates (scope guard and the
   guardrails tool-before handler) are built once at plugin start with the
   project root. A worktree-isolated coder executes in a lane directory and its
   scope binding is published against that lane, so the gates looked for the
   binding under the wrong root and never found it.

2. **Lean Turbo lanes.** Lean Turbo created lane coder sessions with write,
   edit and patch enabled but never published a scope binding for them and
   never materialized the plan into the lane, so there was no authority to
   find under any root. Every Lean Turbo lane coder was blocked on its first
   write.

## After

- Each isolated coder session now records the root it actually runs in, and
  the write gates resolve that session's scope binding, path containment and
  write targets against it. Sessions with no recorded root keep resolving
  against the project root exactly as before.
- Lean Turbo now materializes the authoritative plan into each provisioned
  lane and publishes a lane-rooted, plan-correlated scope binding for the
  lane's coder session before the coder is prompted.
- When a lane's write scope cannot be validated — no plan-backed files, or a
  task id the plan does not recognise — nothing is published and the coder
  stays blocked, with an advisory naming the lane so the situation is visible
  instead of silent.
- The coder write gate (`src/hooks/scope-guard.ts`) now distinguishes a
  genuine wrong-root failure from an ordinary missing scope. When an active,
  otherwise-valid binding exists for the session but is rooted somewhere
  other than where the gate resolved, the tool call is blocked with a new
  `SCOPE_WORKSPACE_MISMATCH` error naming both roots, instead of the generic
  `SCOPE_NOT_DECLARED`. This is diagnostic-only: it never grants or denies
  anything the existing authorization checks would not already grant or
  deny, and it does not fire for an unresolvable directory, a `pr_feedback`
  binding, or a stale/uncorrelated one — those still fall through to the
  ordinary `SCOPE_NOT_DECLARED`.
- A lane's published scope binding and child session state are now cleaned
  up symmetrically on all four Lean Turbo dispatch failure paths — a failed
  `session.prompt`, an exception during dispatch, a failure while publishing
  the lane's own write authority, and a lane-dispatch timeout — instead of
  only the first two. Previously the latter two could leave a binding (up to
  a 1h TTL) and a child session (up to 2h) behind after every failure of that
  kind, pressuring `MAX_PENDING_SCOPE_BINDINGS` under repeated model-fallback
  retries.

Authority is unchanged in every other respect: a lane is authorized only for
files it already holds locks on *and* that the plan attributes to that lane's
own tasks. When worktree isolation is enabled (the default,
`lean_turbo.worktree_isolation: true`), that binding is rooted at the lane's
own worktree directory, so it can never authorize a write in another lane or
in the project root. When `lean_turbo.worktree_isolation` is set to `false`,
lanes run directly in the project directory — there is no separate lane
worktree to root the binding at — so the binding is rooted at the project
root itself; in that configuration the file-set intersection (the lane's
existing file locks ∩ the plan's `files_touched` for that lane's own tasks)
is what still confines each lane's coder to its own files, not the root.

## Migration

None. No configuration changes and no new options.

## Known limitation

The root an isolated coder session runs in is tracked in memory and is
deliberately not written to the session snapshot, because the snapshot lives in
the project-root `.swarm/` directory and there is no durable, plugin-owned
record of provisioned lanes to validate a restored value against. If the plugin
restarts while a lane coder is mid-task, that session loses its recorded root
and its writes are blocked with `SCOPE_NOT_DECLARED` until the task is
re-dispatched. This fails closed — a restarted session never gains authority it
did not have — but it does mean a mid-lane restart looks the same to the
operator as the bug this release fixes. Re-dispatching the task restores normal
operation.

## Related

- Closes #2002
