---
title: Close the knowledge feedback loop
issue: 1715
---

## What changed

The knowledge feedback loop was an open circuit — outcome signals were
recorded but nothing acted on them. Three gaps fixed:

- **Phase-failure outcomes now record (G1).** `phase-complete` previously
  called `updateRetrievalOutcome(dir, name, true)` with a hardcoded `true`,
  so a failed phase could never emit a `'failure'` outcome event and
  `failed_after_shown_count` was structurally dead. The call now runs after
  the phase's real `success` value is determined and passes that value.
- **Confidence-floor action (G2).** Confidence feedback bumped
  `entry.confidence` but nothing acted on low confidence — the bumps
  dead-ended. Now a just-bumped entry clamped to the floor (0.1) with a
  net-negative outcome signal is demoted (`confidence_floor_demoted` flag,
  which strips retrieval `statusBoost`) or quarantined per config. Defaults
  are conservative: requires ≥3 outcome events and a net-negative signal.
- **Contradiction signals unified (G3).** `contradicted_count` (incremented
  only via `knowledge_receipt`) and the curator's `flag_contradiction`
  (tag-only) were disconnected. The curator now emits `contradicted` events
  post-transaction (with `agent: 'curator'` for audit), and a new
  `maybeQuarantineOnContradiction` auto-quarantines entries whose in-window
  contradicted count crosses the threshold (default 3 in 30d).

## New config knobs

- `knowledge.confidence_floor_action`: `'none' | 'demote' | 'quarantine'`
  (default `'demote'`).
- `knowledge.confidence_floor_min_outcomes`: minimum outcome evidence before
  acting (default `3`).
- `knowledge.confidence_floor_signal_threshold`: outcome-signal threshold
  below which a floor entry is acted on (default `0` = net-negative).
- `knowledge.contradiction_threshold_action`: `'tag_only' | 'quarantine'`
  (default `'quarantine'`).
- `knowledge.contradiction_quarantine_threshold`: default `3`.
- `knowledge.contradiction_quarantine_window_days`: default `30`.

## Why

The genuinely-closed sub-loop was only the violation-count → escalator →
enforce-block path. The confidence/contradiction/phase-failure halves were
wired to record signal but nothing consumed it — counters bumped, behavior
barely changed. This closes all three.

## Migration

No migration required. New config fields default to conservative behavior
(`demote` is reversible; quarantine requires 3+ events). Existing entries
without the new `confidence_floor_demoted` field read as `undefined` →
treated as not-demoted (legacy behavior). Users who want the legacy dead-end
behavior can set `confidence_floor_action: 'none'` and
`contradiction_threshold_action: 'tag_only'`.

## Known caveats

- Floor-action quarantine applies only to swarm-tier entries (the quarantine
  mechanism reads the swarm knowledge file). Hive floor-entries still get the
  `confidence_floor_demoted` flag (honored by retrieval regardless of tier).
- The negative-outcome signal depends on phase-failure outcomes actually
  firing, which requires `policy === 'enforce'` + missing required agents.
  Blocked phases never reach the outcome-recording call (pre-existing
  behavior, unchanged here).
