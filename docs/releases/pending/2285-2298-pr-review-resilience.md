# Harden PR-review prompts, wake boundaries, retries, and read-only search

PR review now treats controller prompt fields as single-line data, so newline-bearing lane metadata cannot forge authoritative labels such as `pr_head_sha` or `final_response_char_budget`.

Automatic workflow resumes are coalesced behind a bounded turn-boundary lease. Recent parent output and in-flight tool calls defer the wake until a safe boundary, while an absolute watchdog still recovers genuinely silent sessions. Duplicate idle events no longer inject competing resume turns.

Medium and large PR reviews use a configurable canary-first base-wave protocol. The controller snapshots the policy for the workflow, verifies liveness before fan-out, carries every unresolved obligation into at most two retry attempts, and opens a shared circuit when distinct lanes fail with the same terminal signature. Circuit-open or exhausted workflows fail before publishing another batch or creating child sessions and must be aborted as BLOCKED rather than returning a partial review.

The PR-review read-only gate now accepts the `search` tool's `literal` and `regex` selector modes, reports the exact unsafe argument path when a named observation tool is rejected, and retains the existing controller-owned protection for genuine writes under `.swarm`.

The new `pr_review_resilience` configuration block ships **disabled by default**, with a five-minute probe, a two-second status timeout, a two-failure shared-circuit threshold, and two retry attempts after the initial attempt once enabled. Projects keep the legacy single-wave base dispatch unless they explicitly set `enabled: true`.
