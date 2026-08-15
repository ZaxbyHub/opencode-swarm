# Preflight: req-coverage gate now validates report content; export version derived from package.json

## What changed

- `runRequirementCoverageCheck` in `src/services/preflight-service.ts` now reads and validates the req-coverage report's content instead of passing on file existence alone. Fails on: empty/whitespace file, unparseable JSON, schema-shape mismatch (zod schema pinning the writer's `success/phase/totalRequirements/coveredCount/missingCount/requirements` fields), `totalRequirements === 0`, and `missingCount > 0`. Passes only on a genuinely complete report and reports `coveredCount/totalRequirements`. Read bound is 500KB, matching `EVIDENCE_MAX_JSON_BYTES`.
- `src/services/export-service.ts` derives the export payload `version` from `package.json` instead of the hardcoded stale `'4.5.0'`.
- New regression suite `tests/unit/services/preflight-service-req-coverage.test.ts` (11 tests); `tests/unit/commands/export.test.ts` asserts version parity with `package.json`.

## Why

The gate previously treated `coverage.exists === true` as an unconditional pass while `checkRequirementCoverage` (`src/evidence/manager.ts`) is only an `fs.access` — so an empty, malformed, or incomplete report passed the preflight gate whenever the file merely existed (issue #1662). The export payload advertised version `4.5.0` while the package is at 7.x.

## Migration steps

None. Behavior change is fail-closed: preflight phases that previously passed with a garbage report will now fail with a precise message.

## Known caveats

- The status/schema guard validates the Entry-shaped req-coverage report only; no spec re-derivation or traceability scoring (explicitly out of scope in #1666-adjacent discussions; see issue #1662).
- Reports larger than 500KB fail as oversized by design, mirroring the evidence manager's own bound.
