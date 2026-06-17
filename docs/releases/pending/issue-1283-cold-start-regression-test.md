# Test coverage for Issue #1283 (cold-start bonus contract violation)

## What changed

Added a regression test for Issue #1283 in `tests/unit/hooks/search-knowledge-cold-start.test.ts`:

- New test: "does not treat explicitly-applied entries as cold-start (Issue #1283)"
- Test verifies that the cold-start exploration bonus correctly reads `applied_explicit_count` (v2) instead of the frozen v1 legacy field `applied_count`
- Also updated existing test to set `applied_explicit_count` to align with the v2 contract

## Why

Issue #1283 identified a contract violation where the cold-start exploration bonus was reading the frozen v1 legacy field `applied_count` instead of the proper v2 field `applied_explicit_count`. The code fix was already applied (part of Changes 1–6 for the Knowledge system), but the regression test specified in the issue was missing.

This test ensures that:
1. An entry with explicit applications (`applied_explicit_count > 0`) does NOT receive the cold-start bonus, even if young
2. The gap between never-applied and explicitly-applied entries is approximately the bonus (~0.08)
3. The contract from `src/hooks/knowledge-types.ts:28-36` is honored going forward

## Test coverage

All 28 search-knowledge tests pass (cold-start, MMR, trigger-recall, and main search-knowledge tests).

## Migration

No migration required. This is a test-only change with no impact on runtime behavior.

## Known caveats

None.
