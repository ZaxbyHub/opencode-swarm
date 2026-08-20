# req_coverage preflight gate validates report content; export version derived from package.json

Issue: #2242 (closes #1662; supersedes PR #2188)

## What changed

- `runRequirementCoverageCheck` in `src/services/preflight-service.ts` no longer treats `coverage.exists === true` as an unconditional pass. It now reads and validates the req-coverage report's content: a zod schema (`success`, `phase`, `totalRequirements`, `coveredCount`, `missingCount` as nonnegative integers, `requirements` as an array) pins the writer's shape, and the gate walks a documented fail-branch precedence after shape validation:
  1. `success === false`
  2. `phase !== currentPhase`
  3. `totalRequirements === 0`
  4. `coveredCount + missingCount !== totalRequirements`
  5. `requirements.length !== totalRequirements`
  6. `missingCount > 0`
  7. otherwise pass, reporting `coveredCount/totalRequirements`.

  Empty/whitespace, unparseable JSON, wrong-shape, oversized (>500KB, matching `EVIDENCE_MAX_JSON_BYTES`), and unreadable reports all fail closed with a distinct, precise message. The JSON parse failure message now includes the underlying parse error text instead of a generic message. Skip-when-no-effective-spec and fail-when-report-missing-but-spec-exists behavior is unchanged.
- `src/services/export-service.ts` derives the export payload `version` from `package.json` (`import packageJson from '../../package.json' with { type: 'json' }`) instead of the hardcoded stale `'4.5.0'` literal.
- New regression suite `tests/unit/services/preflight-service-req-coverage.test.ts` (20 tests: the 11 scenarios from the original candidate fix plus finding-ID-labeled regression tests for `success:false`, phase mismatch, count-inconsistency, requirements-length-inconsistency, parse-error-message preservation, negative/float count shape rejection, and one multi-defect precedence fixture pinning that `success === false` wins over simultaneous phase-mismatch and count-inconsistency). `tests/unit/commands/export.test.ts` asserts version parity with `package.json` instead of a hardcoded literal.

## Why

The gate previously treated `coverage.exists === true` as an unconditional pass while `checkRequirementCoverage` (`src/evidence/manager.ts`) is only an `fs.access` — so an empty, malformed, or incomplete report passed the preflight gate whenever the file merely existed (issue #1662). A first candidate fix (PR #2188) added content validation but only destructured 3 of its own 6 schema fields at the enforcement site, so a report that shape-validated but declared `success: false`, an inconsistent phase, or inconsistent counts still slipped through the runtime gate — the schema validated fields the runtime didn't enforce. This PR closes that gap and adds the missing enforcement. It also fixes the export payload advertising version `4.5.0` while the package itself is several major versions ahead.

## Behavior change — read before merging

This is a real, intended behavior change on **legitimately-produced** reports, not just a message wording change: a report the `req_coverage` tool wrote honestly, with `success: true` and consistent counts but `missingCount > 0` (some requirements genuinely uncovered), now **fails** the preflight gate where it previously **passed**. Every other new failure branch (`success:false`, phase-mismatch, count-inconsistency, requirements-length-inconsistency, `totalRequirements === 0`, empty/malformed/wrong-shape/oversized/unreadable) is unreachable from the in-repo writer's normal write path (the single `fs.writeFileSync` of the report in `src/tools/req-coverage.ts` only runs when `success: true` and all counts/lengths are already internally consistent by construction) — those branches exist to catch tampered, foreign-written, or stale artifacts, not to change behavior on artifacts the writer itself produces.

## Migration steps

- **Uncovered-requirement failures** (`missingCount > 0` on an otherwise valid, `success: true` report): cover the requirements, then re-run `req_coverage` to regenerate the report before the next preflight run.
- **Empty, malformed, wrong-shape, or internally inconsistent report failures**: the in-repo `req_coverage` writer cannot produce these shapes by construction, so seeing one indicates a manual edit, a foreign writer, or a stale/corrupted file. Regenerate the report by re-running `req_coverage` rather than hand-editing the JSON.

## Known caveats

- No spec re-derivation or traceability scoring — the gate validates the Entry-shaped req-coverage report's own internal consistency; it does not re-derive requirements from the effective spec to check the report is *accurate*, only that it is *complete and self-consistent*. Explicitly out of scope for this issue (#1662).
- Spec-hash staleness (whether the report was generated against the current version of the spec, vs. an older version) is explicitly out of scope and not detected by this gate.
- Reports larger than 500KB fail as oversized by design, mirroring the evidence manager's own bound (`EVIDENCE_MAX_JSON_BYTES`).
