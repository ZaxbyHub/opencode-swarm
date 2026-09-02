# Restore PR_REVIEW re-entry and PR_FEEDBACK scope execution

## What

- Authenticated PR_FEEDBACK scope declarations now take precedence over generic plan membership, retry, critic, and stale Stage-A checks even when a plan exists. Declaration consumption is serialized and call-bound.
- `authorize_pr_review_reentry` is admitted by the PR_REVIEW controller, and its exact reviewer/test-engineer `subagent_type` Task is reserved once under a workflow-state → authorization-store lock order. Competing calls, ambiguous role fields, stale bindings, and replay by another call fail closed. A Task carrying only the `agent` field is never admitted (the delegation gate cannot enforce on it), and a dispatch the delegation gate later rejects for an unrelated reason still burns the authorization.
- PR workflow auto-resume now treats durable active-lane status and structured receipt transitions as progress. Repeated no-op collection still trips the brake; corrupt or unreadable delegation state never earns progress credit (a throwing recovery scan is treated as uncertainty, not a wake-killing error); the progress scan is no longer paid before the wake-cooldown early-return; running lanes remain running on wait-budget expiry.
- The re-entry authorization store write is now hard-bounded to the persisted-record cap (a full store can no longer be written one record over the schema bound and become unreadable), and pruning prioritizes still-live unconsumed authorizations over consumed ones within the retention bound.
- The optional PR-review resilience policy remains disabled by default.

## Why

The decomposed PR workflow had three integration gaps: plan-bearing feedback scopes fell into generic plan gates, the documented one-shot re-entry tool could not pass the real controller hook, and the wake brake observed only gate revision changes while lane collection writes its durable progress elsewhere.

## Migration

No configuration or persisted-state migration is required. Existing authorization, scope, workflow, and delegation records remain readable. Two single-consumption behaviors are intentional and now documented: a failed downstream re-entry dispatch burns its one-shot authorization (issue a fresh authorization before retrying), and a consumed PR-feedback scope declaration is not reclaimed — if a dispatch fails after consumption, prepare a fresh declaration for a new task id instead of retrying the consumed one.
