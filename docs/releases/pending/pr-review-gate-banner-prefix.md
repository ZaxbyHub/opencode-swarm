# PR-workflow response gate: banner prefix instead of text replacement

## What

The `experimental.text.complete` hook (`src/hooks/pr-workflow-response-gate.ts`)
previously **replaced** every architect text part with a "FINAL RESPONSE
BLOCKED" notice while a durable PR-workflow gate was active. This erased all
intermediate reasoning, making `/swarm pr-review` and `/swarm pr-feedback`
nearly unusable: every thought, status update, and planning note was
overwritten with the block message, and the auto-wake loop amplified the
effect by re-prompting on every idle boundary.

The hook now **prepends** a compact workflow-active banner and preserves the
model's original text below it:

```
--- [PR_REVIEW WORKFLOW ACTIVE — output below is not a terminal verdict;
     only `complete_pr_workflow` clears the gate; if the bind/checkout path
     is unreachable call `abort_pr_workflow` or run `/swarm abort-pr-workflow`] ---

Let me fetch the PR head and verify the merge base...
```

The model's reasoning is visible to the user, but the banner makes clear the
output is not a terminal verdict. Recovery notices for suspended/interrupted
states remain always-visible in the banner. Security is unchanged:
`complete_pr_workflow` is the publication clearing path, while
`abort_pr_workflow` can clear an unarmed workflow after its safety checks
pass; the banner is a visible signal, not a security boundary.

## Why

The text gate was a redundant secondary defense — the real gate is
tool-gated (`completePrWorkflow`/`abortPrWorkflow`), not text-gated.
Unconditional replacement destroyed the model's ability to communicate
progress, causing the "constant firing" symptom reported by users.

## Migration

No breaking changes:
- The gate state lifecycle, tool interception, and auto-wake loop logic are
  unchanged.
- The auto-wake continuation prompt (`blockedText`, used only in the
  `session.idle` → `promptAsync` path) was updated to say "The workflow
  gate is still active. Continue with…" instead of the false claim "The
  replaced text is not a valid review."
- Existing tests were updated to assert the banner + preserved-text
  coexistence rather than text replacement.
