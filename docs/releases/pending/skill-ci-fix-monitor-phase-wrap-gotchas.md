# Skill updates: ci-fix-monitor and phase-wrap gate gotchas

## What changed
- Added `ci-fix-monitor` skill: structured protocol for monitoring CI on a PR, diagnosing failures by type, applying the correct fix, and re-pushing until green
- Added two GOTCHA warnings to `phase-wrap` skill:
  - Drift evidence `summary` field must not contain verdict keywords like "NEEDS_REVISION" (gate scans the entire evidence JSON)
  - `write_final_council_evidence` normalizes CONCERNS to "rejected" — a CONCERNS verdict in the final council blocks `phase_complete` even with zero required fixes

## Why
Both additions come from real failures encountered during PRs #1082 and #1085. The drift-evidence gotcha caused a false gate rejection that required evidence rewriting to work around. The final-council CONCERNS normalization was surprising behavior that blocked phase completion. The ci-fix-monitor skill codifies the "monitor → diagnose → fix → re-push" loop that was done manually.

## Migration
No migration required. These are skill-only changes with no runtime impact.

## Known caveats
None.
