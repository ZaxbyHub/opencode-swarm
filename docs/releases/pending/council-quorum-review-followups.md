# fix(council): address review findings for quorum integrity and stale verdict detection

## What changed

- Fixed stale-verdict bypass in `submit_council_verdicts` when `verdictRound` is omitted on round 2+ submissions; omitted `verdictRound` now defaults to round 1 and is correctly rejected.
- Added `verdictRound` support to `submit_phase_council_verdicts` and ported the same stale-verdict guard so task-level and phase-level councils have consistent freshness checks.
- Hardened `criteria-store` path-traversal test to assert the sanitized filename on disk, not just JSON round-trip of the raw task ID.

## Why

PR review surfaced two integrity gaps in the council quorum hardening:

1. Optional `verdictRound` could be silently omitted to evade the stale-verdict check introduced by the PR.
2. Phase-level council accepted `roundNumber` but had no member-level `verdictRound` schema or stale-verdict detection, creating an asymmetry with task-level council.
3. An existing path-traversal test validated the wrong property, giving false confidence about filesystem containment.

## Migration steps

No user action required. Existing callers that omit `verdictRound` at round 1 continue to work unchanged.

## Breaking changes

None.

## Known caveats

None.
