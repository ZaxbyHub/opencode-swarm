# Lane-output recoverability (repairs and recorded degradation)

Supplement to the main `SKILL.md` (progressive disclosure per the issue #2131
criterion-G ratchet). This file documents the recoverability contract added to
keep substantively-correct but format-imperfect runs completable.

## Parser-boundary repairs (recorded as salvage)

Two benign shape defects are repaired automatically at the parser boundary and
are never a reason to retry by themselves:

- **`clean-evidence-pipe-tail-merge`** — literal unescaped pipes inside a
  `[CLEAN]` row's evidence text (regex character classes like `,;|`, shell
  snippets) are tail-merged into the evidence field instead of splitting the
  row past the 4-field contract. Deterministic: evidence is the trailing field.
- **`summary-row-dropped`** — pipe-bearing non-contract marker rows
  (`[LANE_SUMMARY]`, `[NOTE]`, `[DONE]`, …) are dropped before parsing; they
  were previously miscounted as malformed candidate rows that voided an
  otherwise-valid clean attestation. Pipe-free lines are preserved (they may be
  continuation fragments).

Both repairs are recorded as salvage on the lane record. Lanes should still
escape pipes as `\|` where practical, but the review no longer fails when they
do not. The per-obligation CLEAN rules: a `[CLEAN]` conflicts with `[CANDIDATE]`
rows only for the SAME lane; a valid CLEAN for a different lane in an unscoped
parse is skipped, not an error; duplicates for the same lane still fail.

## Verdict-row pipe tolerance and its fidelity boundary

`[REVIEWED]` (10-field), `[CRITIC]` (6-field), and `[FEEDBACK-VERIFIED]`
(4-field) rows tail-merge extra pipe separators into the trailing free-text
field. Fidelity boundary: content-preserving when the extra pipes sit in the
trailing field; a pipe in a mid-row prose field still authenticates (all
machine-checked positions are untouched) but trailing prose fields may be
re-arranged. A debug-gated warn fires on every applied merge; the raw lane
emission is always retained verbatim in the lane-output store, so repairs are
re-derivable.

## Recorded coverage degradation (trigger evaluation)

The trigger-eval writer accepts only an exact eleven-row v2 receipt whose
`MATCHED` rows are backed by exact-head artifacts from lanes that declared
ownership of their families through a verifiable provenance chain (identity,
ownership, digest, retained artifact). A lane whose coverage QUALITY is
imperfect — it ended `error`/`cancelled` after exhausting retries, or its
artifact has no covered `[CANDIDATE]`/`[CLEAN]` row for the row's own family —
no longer dead-ends the run: the writer records the failure on the durable
receipt as a `coverage_degradations` entry (trigger id, source lane, reason,
row-scoped so a consolidated lane's covered families are never misattributed)
and proceeds. The tool result reports `coverage_degradation_count`; the
synthesis phase MUST disclose every degraded family, with its recorded reason,
in the final review report. Retries remain the first resort (COVERAGE GATE); a
missing provenance chain still fails closed, and the reviewer/critic inventory
skips exactly the receipt-disclosed dispatch tuples.
