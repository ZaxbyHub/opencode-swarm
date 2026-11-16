# v2 hosts: coder child scope activation now translated from the subagent progress event

## What

On OpenCode 2 hosts, the v2 event pump now translates the subagent tool's
`session.tool.progress` event — which carries the spawned child session id as
live metadata (`metadata.sessionID`) — into the v1 `message.part.updated`
ToolPart shape the plugin's scope-activation handler consumes. The tool call
must be the host subagent tool (name tracked from `session.tool.input.started`
in a bounded FIFO registry); non-subagent tools, untracked names, and
empty/self-referencing session ids are still dropped.

## Why

Before this fix, coder dispatches on OpenCode 2 hosts could fail closed at the
child's first write with
`SCOPE_NOT_DECLARED: coder cannot invoke edit without a validated scope for task
unknown. ACTION[architect]: call declare_scope with the exact workspace-relative
paths and replace_existing=true, then dispatch a new Task call.`
(#3401; the reporter's environment is quoted in the issue). The
parent-side declaration and `pending_child` dispatch record were correct, but
the only child-side claim path requires a v1-shaped tool part that the v2 pump
never produced: `session.tool.called` passes through flat (no `part`), and the
one event that carries the child identity mid-run (`session.tool.progress`) was
dropped as unmapped. The pending binding therefore never flipped to the
child-owned active generation, the coder child never resolved a task id, and
every write was refused before execution — each blocked attempt also consumed
a retry diagnostic.

## Verification

The synthesized part feeds the existing, unchanged v1 activation chain
(`taskMetadata` → durable claim → child `currentTaskId`/`declaredCoderScope`);
the durable claim (`claimScopeBindingForChildDurably`) remains the sole
authority, so a forged or misaddressed progress event for a non-subagent or
unknown call still finds no pending binding and no-ops. Pinned by
`tests/unit/host/v2/scope-activation-progress-3401.test.ts` and
`tests/unit/host/v2/scope-activation-progress-gating-3401.test.ts`
(live-capture-mirroring envelope fixtures, gating negatives with differential
positive controls, registry bounds) plus the extended `#3022` event-name
contract test. The full end-to-end path was additionally exercised against a
live 2.0.29 host during development (event-capture plugin; the envelope shapes
are identical at the v2.0.32 schema); the PR's automated checks cover the
contract level rather than a live host run.
