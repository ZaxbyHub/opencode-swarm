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

- **Skip results treated as non-pass**: Intermittent `skip` results are treated as non-pass for variance calculation and count as state transitions for alternation. A test with pattern P,S,P,S,P scores 0.88 even though no actual failures occurred. This is an intentional design tradeoff — all-skips correctly scores 0.
- **Recommendation tier threshold shift**: The combined formula produces higher scores than alternation-only, especially for non-alternating patterns. Tests that previously scored below 0.5 may now cross the "severely flaky" threshold via variance contribution alone (e.g., F,F,F,F,P went from 0.2 to 0.42). Recommendation thresholds remain at 0.3 / 0.5.
