---
issue: 1931
title: PR-review workflow errors now name the directory, the remediation command, and the valid trigger IDs
---

# PR-review workflow diagnostic errors (issue #1931)

The `swarm-pr-review` workflow previously emitted three misleading,
diagnostic-free `BLOCKED:` errors that sent users down rabbit holes of
incorrect root-cause hypotheses (fictional gate files, allowlist desyncs,
controller-path blocks). The errors now name the working directory, the
exact remediation command to run, and for trigger-ID validation the
complete list of valid IDs.

## What changed

### `assertCurrentCheckoutHead` (src/hooks/pr-workflow-gate.ts)

Two distinct failure modes are now reported with separate, diagnostic-rich
messages:

- **HEAD cannot be resolved** (git failed, unborn HEAD, shallow clone,
  missing binary, timeout, non-repo directory): the error names the
  `directory`, enumerates the real causes, and includes the exact command
  `git -C "<directory>" rev-parse --verify HEAD^{commit}` for self-diagnosis.
- **HEAD does not match**: the error now also names the `directory` and
  includes the exact command `git -C "<directory>" switch --detach <sha>`.

All five callers inherit the improvement automatically:
`dispatch_lanes_async`, `run_pr_feedback_stage_a`, `activatePrWorkflow`,
`bindPrWorkflowHead`, and `requireBoundState`.

### `write_pr_review_trigger_eval` (src/tools/write-pr-review-trigger-eval.ts)

The `unknown trigger IDs` error now lists all 11 valid micro-lane IDs and
explicitly calls out that base-lane IDs and dispatch mode strings
(swarm-pr-review:base, :micro, :reviewer, :critic) are NOT trigger IDs.

### `prepare_pr_workflow_checkout` / `requireAnyActiveState` (src/hooks/pr-workflow-gate.ts)

The `no active PR workflow gate for session` error now points at the
activation path: run `/swarm pr-review <pr-ref>` (PR_REVIEW) or
`/swarm pr-feedback <pr-ref>` (PR_FEEDBACK), or dispatch the first
`swarm-pr-review:*` / `swarm-pr-feedback:*` lane.

### `swarm-pr-review` skill (`.opencode/skills/swarm-pr-review/SKILL.md`)

Added a "Trigger-ID namespace - do not mix" callout directly above the
mandatory micro-lane map. The `.claude` and `.agents` adapters inherit the
change automatically via their canonical-file reference.

## What did NOT change

- **Fail-closed behavior is preserved.** Every enriched error still
  throws `BLOCKED:` and aborts the operation (AGENTS.md invariant #9).
- **No new tools, exports, schema changes, or gate-file path changes.**
- **No change to `dispatch_lanes_async` core logic, `prepare_pr_workflow_checkout` core logic, or the trigger-ID allowlist.**

## Closed

Closes #1931.
