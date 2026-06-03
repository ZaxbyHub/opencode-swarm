# fix(test-impact): combine alternation and pass-rate variance for flaky scoring

## What changed

`src/test-impact/flaky-detector.ts` now computes flaky score as the average of:

- alternation score (`alternationCount / totalRuns`)
- pass-rate variance score (`4 * passRate * (1 - passRate)`)

This keeps alternation as a primary signal while adding a complementary pass/fail
distribution signal for intermittent patterns.

Unit coverage was updated in:

- `src/test-impact/__tests__/flaky-detector.test.ts`
- `src/test-impact/__tests__/flaky-detector.adversarial.test.ts`

including non-alternating intermittent histories.

## Why

Alternation-only scoring missed instability signal from pass-rate variance in
non-perfectly alternating histories.

## Migration

No migration required. This changes internal flaky score computation and may
change quarantine outcomes for some historical test-result patterns.

## Known caveats

None.
