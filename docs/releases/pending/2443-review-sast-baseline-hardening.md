## SAST baseline: review hardening for reflow matching and absorption triage

Follow-up to the #2302 reflow/absorption work: `sast_scan` diff evidence now
round-trips the `truncated_pre_existing` / `truncated_moved_findings` flags,
merged captures disclose `dropped_triage_count` (prior triage entries orphaned
by a merge) with an advisory warning, the tool description documents
`moved_findings` (reported, never gating) and the
`baseline_absorption_blocked` status, and an explicit JSON-null
`reflow_keys` is tolerated exactly like an absent one (exact-only) instead of
diverging to `invalid_schema`. Two dead fallbacks in the reflow counters were
removed, the `sast-baseline` retention-registry anchors were re-pinned to the
current source, and the SAST test mocks now delegate to real implementations
by default so shared-worker test pollution cannot fake baseline behavior.
