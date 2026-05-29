# fix(analyzer): rank and return all fuzzy suffix matches in fallback impact lookup

## What changed

The test-impact analyzer's fallback path previously short-circuited on the first
suffix-matching source entry in `analyzeImpact`. When the same filename existed
under multiple directories (e.g. `src/unit/foo.ts`, `unit/foo.ts`, `foo.ts`),
only the first matching entry was used, silently discarding valid test mappings.

This release makes fallback matching exhaustive and deterministic:

- All suffix-compatible candidates are collected instead of stopping on the first match.
- Candidates are ranked by directory proximity: exact directory match → nearest
  sibling (most shared trailing segments) → other matches; lexical tie-break for
  stable ordering.
- A new `sharedTrailingSegments` helper computes proximity rank.
- The `found` flag is now set from `suffixMatches.length > 0` before the
  collection loop, making the "file has at least one candidate" decision
  independent of budget exhaustion during collection.

## Why

The old early-exit behaviour could miss test coverage for files with aliased or
shallow paths in the impact map, leading to false "untested" classifications and
incomplete test-impact results.

## Migration

No migration required. The change is internal to `analyzeImpact`; callers see a
superset of the previously returned `impactedTests` when multiple suffix matches
exist.

## Known caveats

None. The `found` flag fix is a clarity improvement; the `if (budgetExceeded) break`
guard already prevented `untestedFiles` from receiving false entries in all cases.
