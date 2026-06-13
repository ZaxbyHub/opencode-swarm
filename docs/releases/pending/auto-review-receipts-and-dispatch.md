# Automatic review of execution by the review model (opt-in) + durable reviewer receipts

## What changed

- **New `auto_review` config block (opt-in, default off).** When enabled, completing a task (`update_task_status` → `completed`) and/or a phase (`phase_complete`) automatically dispatches the registered reviewer agent — its own configured model, in a fresh ephemeral session, read-only — to review the current execution diff (`git diff HEAD` plus untracked-file summary, bounded by `max_diff_kb`). This mirrors the auto-review pattern from Claude Code and Codex: a second model checks the work in a clean context without the orchestrator having to ask for it.
  - Advisory and fire-and-forget: tool calls are never delayed; per-session 60s cooldown and in-flight guard prevent dispatch storms.
  - Verdicts are persisted as durable review receipts (`.swarm/review-receipts/`, scope-fingerprinted over the diff) plus an `auto_review` event in `.swarm/events.jsonl`.
  - REJECTED verdicts inject an `[AUTO-REVIEW]` advisory with the top findings and required fixes into the architect's next prompt; unparseable responses inject an UNVERIFIED advisory; APPROVED stays silent.
  - Fields: `enabled` (false), `trigger` (`task_completion` | `phase_boundary` (default) | `both`), `timeout_ms` (300000), `max_diff_kb` (256).
- **Reviewer verdicts are now machine-parsed and persisted.** Every returning reviewer Task delegation has its mandated `VERDICT`/`RISK`/`ISSUES`/`FIXES` output block parsed and stored as an approved/rejected review receipt (fingerprinted over the delegation prompt). Previously verdicts existed only as free text in the architect's context; re-reviews and critic drift verification now have a durable machine-readable record.

## Why

Outside full-auto mode, review depended entirely on the architect issuing reviewer delegations and interpreting free-text verdicts. This adds the missing independent leg: a hook-driven review pass by a separately configurable review model, with durable evidence, that runs whether or not the orchestrator remembers to ask.

## Migration

None. Both features are additive; `auto_review` is off by default and the receipt collector only adds durable artifacts under `.swarm/`.
