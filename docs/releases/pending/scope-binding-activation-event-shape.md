# Fix default-mode coder dispatches stuck on SCOPE_NOT_DECLARED

## What changed

- Scope-binding activation now sources the parent session from the SDK-typed `part.sessionID` on the Task tool part (the part lives in the architect session's message stream) and the child session from `state.metadata.sessionId` — the key the opencode task tool actually emits. Previously the activation handler required a `metadata.parentSessionId` key that 1.1.x-era opencode runtimes never emit, so the pending scope binding was never claimed for the child session and every default-mode coder write failed with `SCOPE_NOT_DECLARED`, no matter how many times the task was re-dispatched or the session was reset.
- The parent identity is now taken exclusively from the runtime-assigned part stream — tool-controllable metadata can no longer influence it, and empty or whitespace session ids fail closed. This also hardens activation against a forged tool part carrying attacker-chosen metadata.
- Worktree/parallel lanes were never affected (they activate scope bindings through a separate direct path).

## Migration

No configuration or schema migration is required. If a run is currently stuck with `SCOPE_NOT_DECLARED` on every coder dispatch, update the plugin and re-dispatch the task — the first Task event after the architect's dispatch now activates the coder's scope binding.

Surfaced during the #1896 investigation.
