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

## Host-transport recovery (recorded as salvage)

Collection preserves a strict evidence hierarchy: the complete immutable
`output_ref` artifact outranks its bounded inline preview. Consequently,
`result.truncated` is not a failure when that artifact still passes identity,
digest, exact-head, scope, ownership, and row-coverage validation. The affected
workflow lane is recorded in `salvaged_workflow_lanes` even when no parser repair
was necessary. That compatibility list is paired with typed per-lane metadata in
`salvaged_workflow_lane_recoveries`.

A host `session.status` timeout means readiness is **unknown**, not busy and not
complete. Status and message calls receive separate fair bounded budgets so one
lane cannot starve later lanes. For unknown readiness, a readable transcript is
accepted only when the newest assistant message proves terminal completion; a
mid-run snapshot remains pending. Invalid output also remains pending while
readiness is unknown, because the agent may still be producing its protocol row.

When the host message window is incomplete, independently validated positive
`[CANDIDATE]` rows may be recovered only for base and micro discovery lanes;
their exact owned workflow lanes are marked salvaged. Council, reviewer, and
critic outputs remain fail-closed and require retry when incomplete. `[CLEAN]`
is absence evidence and therefore requires a complete transcript. One positive
row in a consolidated lane never salvages a sibling dimension whose only
evidence is `[CLEAN]` or missing. Recovery reasons are lane-scoped and use four
kinds: `parser-normalization`, `parser-row-recovery`,
`truncated-preview-durable-artifact`, and
`transcript-incomplete-terminal-candidate`.

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

## Bounded merge-base fallback (`base_verification`)

Every v2 receipt now records how its `base_sha` was verified at write time:

- **`live`** — the writer re-derived the merge base with a bounded
  `git merge-base -- <base_ref> <pr_head_sha>` and it matched the supplied
  `base_sha` exactly. This is the normal path.
- **`bound_fallback`** — that re-derivation was **unavailable**, and the writer
  proceeded because the supplied `base_ref`/`base_sha` exactly equalled the
  review scope already bound durably at dispatch time.

The distinction matters because the git helper collapses every failure mode
into a bare `null`: a timed-out git call, a git process that failed to spawn, a
`base_ref` that is unresolvable in this checkout, and a ref rejected as an
unsafe revision token are indistinguishable to the caller. Treating that `null`
as *refutation* rather than *unavailability* made review completion permanently
unsatisfiable — every retry re-failed identically, the trigger-eval receipt was
never written, an omission dispatch could not repair it, and the only exit was
`abort_pr_workflow`. The bound scope is not a weaker fact: it was itself derived
by a real `git merge-base` at dispatch and only trimmed/lowercased on the way
into durable state, so re-deriving it at write time is a redundant re-check.

What `bound_fallback` does and does not mean:

- It does **not** widen what was reviewed. The reviewed range stays SHA-scoped
  (`base_sha...pr_head_sha`), identical to the `live` path.
- It does mean post-bind movement or deletion of the base ref would go
  undetected for this run — the one staleness signal the live re-check provides.
- It never relaxes a mismatch. If the re-check is unavailable **and** the
  supplied scope differs from the bound scope in either half, the writer fails
  closed with an enriched message naming the possible causes and the recovery
  options. If the gate has no bound base at all, the writer fails closed before
  attempting resolution.

**Synthesis obligation (skill-directed):** when the trigger-eval result or the persisted receipt
reports `base_verification: bound_fallback`, the final review report MUST
disclose it. State that the merge base could not be re-verified live at write time and that the review was
scoped to the durably bound base. Do not silently present the review as if the
base had been re-verified. (Unlike `coverage_degradations`, which the workflow gate reads as a machine-enforced waiver filter, `bound_fallback` disclosure is skill-directed.)

## Provenance fields: dispatch ledger vs. writer rows

Two different row shapes carry the trigger evaluation, and mixing them up is a
recurring source of first-dispatch failures:

- **Dispatch-time `trigger_evaluation` rows** (the inline ledger frozen by the
  first micro dispatch) use the strict inline schema: `trigger_id`, `result`,
  and `evidence`, and nothing else. Adding `source_batch_id` or
  `source_lane_id` there is rejected — at dispatch time no lane has run yet, so
  there is no provenance to cite, and the frozen-ledger digest is computed over
  exactly those three fields.
- **Writer `rows`** (passed to `write_pr_review_trigger_eval` after the lanes
  settle) carry the provenance: every `MATCHED` row adds the `source_batch_id`
  and `source_lane_id` returned by its completed micro lane, and every
  `NOT_TRIGGERED` row must omit both.

Classifications must be identical across the two — the writer rejects
classification drift from the frozen ledger — while `evidence` may be reworded
in the writer call and is simply ignored (the frozen values are authoritative).

## Gate-level recovery: stuck lanes, corrupted state, amended inventory

Three wedge states used to leave a workflow with no exit through any tool. Each
now degrades with disclosure; the contradiction cases still fail closed.

### Stale lanes no longer block abort or completion

A lane whose background process dies without writing a terminal snapshot used to
count as "in flight" forever, and the same predicate gates `abort_pr_workflow`,
the PR_REVIEW to PR_FEEDBACK transition, and `complete_pr_workflow` — so the
escape hatch was refused by the very condition it exists to resolve.

A lane whose delegation record has not advanced its `updatedAt` for 30 minutes is
now **presumed stale** and settles instead of blocking. The disclosure appears as
`presumed_stale_lanes` / `presumed_stale_disclosure` on the `abort_pr_workflow`
and `complete_pr_workflow` responses, as a `pr_workflow_lanes_presumed_stale`
record in `.swarm/events.jsonl`, and on the `pr_workflow_aborted` audit event.
The delegation record itself is transitioned to `stale`.

A lane with a **recent** `updatedAt` still blocks — a check that can run and
reports "still progressing" is not softened. Collect it with
`collect_lane_results`, or wait for the horizon.

### A corrupted gate state no longer defeats abort

If the durable gate-state file fails schema validation but is still valid JSON,
`abort_pr_workflow` and `pr_workflow_status` read it through a **recovery-only**
reader that salvages `sessionID`, `mode`, `prHeadSha`, and — when each is
individually well-formed — `revision`, `prFeedbackReadyToPublish` and
`checkoutRecovery`. Every other reader, including all write and completion paths,
still refuses the file, so a salvaged view can never be acted on as if it were
valid. `stateSalvaged` / `stateSalvageDisclosure` name the schema errors.

Boundaries that deliberately did NOT soften:

- **Unparseable bytes fail everywhere.** There is nothing to salvage.
- **Unreadable identity fails everywhere.** Without a readable `sessionID` and
  `mode` there is no provable subject to act on.
- **An unreadable `prFeedbackReadyToPublish` is treated as ARMED**, so abort
  still refuses. Corrupting that one record must never become a way past the
  armed-abort refusal.
- When `revision` cannot be salvaged, abort takes the documented
  compare-and-swap escape and says so:
  `state revision unsalvageable; cleared without compare-and-swap`.

### The PR_FEEDBACK inventory is append-only, not immutable

A finding discovered after `declarePrFeedbackInventory` used to require
`abort_pr_workflow` plus a full restart, discarding completed verification work
for correctly-declared items. Re-declaring with **additional** items is now
accepted; every previously-declared entry must still be present, so mutation and
removal still hard-fail (`inventory is append-only after declaration`).

What an amendment costs, and what it preserves:

- Completed **verification** batches for the original items are preserved. Cover
  the appended item with a new verification batch owning just that item.
- Stage A must be re-recorded over the full amended inventory, and each ordered
  gate phase must be re-run with a lane owning every current inventory item —
  a gate batch recorded before the amendment no longer settles its phase. This
  is deliberate: it is the control that stops an appended item reaching
  publication with no verdict.
- Publication is disarmed by an amendment (the armed record attested coverage of
  the pre-amendment inventory). Re-arm with one `complete_pr_workflow` call.
- Every appended entry is recorded in an audit ledger surfaced as
  `inventory_amendments` on the completion response and `inventoryAmendments` on
  `pr_workflow_status`. The ledger is bounded at 128 entries and is never pruned;
  further amendments are refused at the cap.
