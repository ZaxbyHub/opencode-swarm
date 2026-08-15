# PR review lane-contract recoverability — repairs instead of dead-ends

A real `/swarm pr-review` run (MiniMax M3 orchestrator, v7.140.1) aborted and
discarded 16 already-validated base-lane candidates after four substantively
correct micro-lane outputs were all parser-rejected. Root causes were format
perfection requirements no frontier model reliably meets, plus a persistence
chain that turned any single lane defect into an unrecoverable workflow abort.

## What changed for users

- **Pipes in `[CLEAN]` evidence no longer break the row.** A literal `|` inside
  evidence prose (regex text like `,;|`) is tail-merged into the evidence field
  at the parser boundary and recorded as salvage. Escaping with `\|` still
  works and is still preferred.
- **Non-contract marker rows (`[LANE_SUMMARY]`, `[NOTE]`, `[DONE]`, …) are
  dropped before parsing** instead of being miscounted as malformed candidate
  rows that voided an otherwise-valid clean attestation.
- **Consolidated lanes may mix `[CANDIDATE]` and per-family `[CLEAN]` rows.**
  The CLEAN+candidate conflict is now scoped per lane/obligation (the #2131
  prompt contract the parser previously contradicted), and a duplicate
  attestation for a *different* owned lane is skipped instead of failing the
  artifact.
- **A degraded micro lane no longer aborts the whole review.** The trigger
  evaluation still enforces the full provenance chain (identity, ownership,
  exact head, retained artifact) but records coverage-quality failures
  (`error`/`cancelled` status, degraded/truncated output, no covered row) on
  the durable `trigger-eval.json` receipt as `coverage_degradations` entries
  and proceeds. The tool result reports `coverage_degradation_count`; the
  review report must disclose every degraded family.
- **The initial base-dispatch BLOCKED error now names the six valid dimension
  IDs** (`intent-architecture`, `correctness-state`, `tests-falsifiability`,
  `security-trust`, `reliability-performance`, `compatibility-delivery`), so an
  orchestrator can correct its next call without grepping plugin source.
- **`[REVIEWED]`, `[CRITIC]`, and `[FEEDBACK-VERIFIED]` verdict rows tolerate
  literal pipes** in their trailing free-text fields via the same deterministic
  tail-merge. Fidelity boundary: content is preserved exactly when the extra
  pipes sit in the trailing field; a pipe in a mid-row prose field still
  authenticates (machine-checked positions are untouched) but trailing prose
  fields may be re-arranged. The raw lane emission is always retained verbatim.

## What did not change

Provenance enforcement is intact: wrong lane, wrong mode, head mismatch,
missing/foreign artifact, or ownership violations still fail closed, and
retries (max 2) remain the first resort before the degraded path applies.
Reviewer/critic substantive coverage gates are unchanged.
