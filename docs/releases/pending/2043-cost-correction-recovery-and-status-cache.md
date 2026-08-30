## Summary
- Fixes cost-correction restart recovery so unrelated rejected telemetry no longer poisons later recovery attempts, and matching child sessions are recovered by digest when multiple delegated children exist.
- Preserves configured estimates when provider reports are malformed instead of dropping the estimate path entirely.
- Keeps legacy telemetry key coverage aligned with the emitted delegation-end payload and avoids re-folding the full telemetry history on every status refresh.
- Tightens atomic-write/evidence cleanup and adds regression coverage for the new recovery, cache, and cleanup behavior.

## Migration
No migration required.

## Caveats
- The restart-recovery behavior now prefers a matching child-session digest when one is available; unrelated rejected corrections remain rejected and do not affect recovery.
