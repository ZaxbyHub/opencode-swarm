# Full-auto critic parser: direct unit tests and JSDoc

## Overview

Follow-up to `full-auto-non-blocking-review-fixes.md`. Adds the test coverage
and documentation that the shared critic-response parser was missing.

## Changes

- Added 15 direct unit tests for `parseCriticResponseFields` in
  `tests/unit/full-auto/critic-response-parser.test.ts`, covering:
  - All 8 default verdicts accepted
  - Custom `validVerdicts` override: accepts custom-list verdicts, rejects
    default verdicts not in the custom list (including PENDING)
  - `onUnknownVerdict` callback: invoked on unknown verdicts, not invoked on
    valid verdicts, invoked when a default verdict is excluded by override
  - Field parsing edge cases: `"none"` → empty array, multi-line reasoning
    continuations, backtick/asterisk stripping from verdict, missing VERDICT
    field, `rawResponse` preservation
- Added `parses PENDING verdict` test to `tests/unit/full-auto/oversight.test.ts`
  for the v2 `parseFullAutoCriticResponse` wrapper path (previously only the
  legacy intercept path had PENDING coverage)
- Added JSDoc to `parseCriticResponseFields` documenting the `rawResponse`
  format, `validVerdicts` override semantics, and `onUnknownVerdict` callback
  contract
- Added inline comment in `dispatchCriticAndWriteEvent` noting that a write
  failure also skips the v2 mirror step, so phase-approval evidence coherence
  depends on the event write succeeding

## Migration

No migration required.
