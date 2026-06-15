# Issue #1234 WP6: Smaller validated items (A–C)

## Near-duplicate co-escalation (WP6-A)

`maybeEscalateOnViolation()` now co-counts violations on semantically near-duplicate entries (Jaccard bigram similarity >= 0.6) so equivalent lessons under different IDs accumulate toward the 2-in-30-days escalation threshold. The near-duplicate lookup is fail-open — if the knowledge store is unreadable, escalation falls back to exact-entry counting only.

## Knowledge verdict feedback → confidence (WP6-B)

New `applyKnowledgeVerdictFeedback()` bridges knowledge receipt events (applied/violated/ignored) to `entry.confidence` via the existing `bumpKnowledgeConfidenceBatch` mechanism. Runs at phase_complete alongside the skill-usage feedback bridge. Net-positive entries get +0.03 boost; net-negative entries get -0.05 decay, clamped to [0.1, 1.0].

## Override justification minimum substance (WP6-C)

`accept_violations_justification` now requires at least 10 characters of substantive reasoning (previously accepted any non-empty string after trim). Single-character or trivially short overrides are rejected.
