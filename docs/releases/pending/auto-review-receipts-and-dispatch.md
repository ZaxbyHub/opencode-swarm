# Automatic review triggers and durable reviewer receipts

## What changed

- **Expanded `auto_review` into a shared bounded review policy.** When automatic review is enabled, task completion and phase/plan boundaries use the registered reviewer in a fresh read-only ephemeral session; `/swarm review` invokes that same engine on demand. Version 7 remains opt-in. Version 8 derives an advisory `phase_boundary` default only when the approved, source-controlled cost decision remains pinned; an explicit `enabled: false` still wins.
  - Task-completion review is background/fire-and-forget with a per-session cooldown and in-flight guard. Phase and plan review are awaited with configured bounds inside `phase_complete` so evidence exists before the evidence-check-only gate runs. Manual `/swarm review` is synchronous.
  - Automatic and manual engine runs use the canonical diff collector: default/base scopes use a merge base plus current tracked and safe untracked text, exact ranges are committed-only, and `--working-tree` compares `HEAD` with the current tree. Task review uses `max_diff_kb`; phase/plan review uses `final_review.max_diff_bytes`.
  - Automatic completed, empty, incomplete, and failed review outcomes inject bounded `[AUTO-REVIEW]` advisories, and task-trigger events remain in `.swarm/events.jsonl`. Findings, validation dispositions, scope completeness, receipts, evidence, telemetry, and cost data come from the same engine.
  - Core fields are `enabled`, `trigger`, `timeout_ms`, `max_diff_kb`, `min_confidence`, `structured_findings`, `validate_findings`, `validation_model`, and `validation_timeout_ms`, plus nested `final_review` phase/plan policy.
- **Reviewer Task verdicts are machine-parsed and persisted when auto-review is enabled.** A returning reviewer delegation has its mandated verdict and structured-finding output stored under `.swarm/review-receipts/`. Its scope fingerprints repository HEAD plus the parent session's guardrails-observed modified-file paths and current bytes, never architect-authored prompt prose. Below-threshold findings remain durable with effective severity `info`; eligible HIGH/CRITICAL findings can be checked by the independent validator in a separate fresh context. Disabled version-7 sessions preserve the legacy reviewer contract and create no structured Stage-B receipt or validator work.

## Why

Outside full-auto mode, review depended on the architect issuing reviewer delegations and interpreting free-text verdicts. The shared policy adds an independent, separately configurable review leg with durable scope-bound evidence while retaining bounded advisory behavior by default.

## Migration

Version-7 installations remain unchanged unless `auto_review.enabled` is explicitly set to `true`. For version 8+, users can pin `enabled: false` to override the approved advisory default. Existing `timeout_ms` and `max_diff_kb` values continue to populate the corresponding nested final-review fields when those nested values are absent.
