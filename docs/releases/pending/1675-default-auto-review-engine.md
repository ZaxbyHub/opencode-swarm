# Default-path independent auto-review engine (#1675)

## What changed

- Generalized task, phase, plan, and manual review into one bounded engine. Lean review consumes the same instance-local ephemeral-session dispatcher while retaining its specialized phase package and verdict contract.
- When auto-review is enabled, reviewer output carries strict structured findings with severity, confidence, file/line locations, stable SHA-256 IDs, deduplication, and current-side diff-hunk anchoring. Version-7 disabled mode retains the legacy reviewer prompt and output contract and creates no new structured receipts or validator work.
- Added the read-only `critic_finding_validator` role. Eligible anchored HIGH/CRITICAL findings are checked in a separate fresh context and receive `CONFIRMED`, `DISPROVED`, or `UNVERIFIED` dispositions.
- Added `auto_review.min_confidence`, structured/validation controls, and nested `final_review` phase/plan policy. Advisory remains the default disposition; explicit gate mode is evidence-backed and fail-closed.
- Added `/swarm review [--base <ref> | --range <from..to|from...to> | --working-tree] [--json]` for an on-demand local review using the same canonical diff, reviewer, validator, receipt, evidence, telemetry, and cost pipeline.
- Added a deterministic 30-diff source-only cost baseline. Version 7 remains opt-in. The version-8 default flip requires both major version 8+ and the source-controlled approved decision that pins `docs/benchmarks/auto-review-v8-cost-baseline.json` as SHA-256 `b4e981d4d87e3de80f6d7dd4ae782b08159d385019c4d8b0d300c0443f1984ce`.
  - Under the pinned advisory policy (one reviewer, no validator), estimated input tokens were 1,380 minimum, 2,438 p50, 50,480 p95, and 88,121 maximum, with an 800-token output budget requested by the reviewer contract. USD remains unavailable in the deterministic source-only artifact; runtime telemetry and `/swarm costs` report observed provider usage.

## Safety and evidence

- The shared ephemeral dispatcher creates a fresh parent-bound session with a replacement system prompt, explicit read-only tool denials, byte/time bounds, abort handling, cost extraction, and awaited best-effort cleanup. Review callers measure the fully rendered request and forward its exact byte allowance under a hard 3 MiB ceiling, preserving the documented 2 MiB diff cap even when JSON escaping expands path metadata.
- The canonical diff collector uses bounded, non-interactive Git subprocesses and safely represents tracked plus NUL-delimited untracked text. A capped diff carries a separately bounded changed-file inventory in its scope hash and durable evidence. When all escaped names cannot fit the prompt ceiling, the prompt includes the largest fitting prefix plus explicit included/total/omitted counts and marks that inventory incomplete; the full bounded collector inventory remains durable. Incomplete coverage is explicit in prompts, evidence, manual output, and automatic advisories rather than silently omitted.
- Findings below `min_confidence`, outside current-side changed hunks, or not independently confirmed remain visible in durable evidence but cannot block.
- Phase dispatch persists `.swarm/evidence/<phase>/auto-review.json`; the phase gate only verifies current scope-matched evidence and never dispatches a model itself.
- Review receipts remain under `.swarm/review-receipts/`, while task-trigger events remain under `.swarm/events.jsonl`. Stage-B receipts fingerprint a bounded harness-owned scope derived from the parent session's guardrails-observed `modifiedFilesThisCoderTask`, repository HEAD, and current file bytes; architect prompt prose cannot omit changed files. Missing or unsafe scope produces no durable receipt. Runtime usage appears in delegation telemetry and `/swarm costs`.
- Task-review cooldowns, in-flight tracking, fallback registries, and finding-validation capacity are isolated per plugin instance. The shared engine preserves task auto-review's existing quota fallback advisory/telemetry and its no-fallback timeout carve-out.
- Phase completion preflights the release/trigger policy without I/O and only loads plan context when a phase or final-plan review can actually run, preserving the version-7 disabled-path latency contract.
- Final receipt, index, and evidence commits recheck the exact reviewed scope and reject symlink, junction, reparse, or ancestor-swap containment changes. Terminal gates also bind the independent receipt fingerprint to the current canonical diff and read it through descriptor/path identity checks that reject redirected ancestors.
- Trusted background completions use digest-bound ingestion leases and bounded ownership history so duplicates are idempotent, delayed parallel siblings retain exact attribution, and non-owner stale/error events cannot discard active ingestion scope or regress consumed evidence.

## Migration

Existing version-7 installations do not change reviewer prompts, parse/persist structured Stage-B receipts, or launch finding validators unless `auto_review.enabled` is set to `true`. Existing `timeout_ms` and `max_diff_kb` values continue to feed their corresponding nested `final_review` fields only when those nested values are absent.

Gate mode requires `structured_findings: true`; malformed combinations fail configuration validation. `validate_findings` stays off by default in advisory mode, while gate mode always validates eligible findings.
