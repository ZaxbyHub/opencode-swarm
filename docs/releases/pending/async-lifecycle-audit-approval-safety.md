# async lifecycle r11–r13 audit repair I: critic verdict, dispatch binding, atomic approval

## What

First batch of the independent source audit repairs for the native
OpenCode-2.3 async subagent lifecycle (r11–r13). This fragment covers the
approval-safety findings; crash-safe closeout and event/policy parity follow
in the sibling fragments.

### P0-1 — plan-critic verdict parser accepted non-verdicts

`extractPlanCriticVerdict` (src/plan/critic-approval.ts) matched the FIRST
`VERDICT: <TOKEN>` prefix anywhere in the text, so all three demonstrable
misclassifications released the `critic_pre_plan` gate:

1. the critic prompt's own rubric enumeration
   (`VERDICT: APPROVED | NEEDS_REVISION | REJECTED`) parsed as APPROVED;
2. a `VERDICT:` line inside a markdown code block (``` and `~~~` fences)
   parsed as APPROVED;
3. contradictory verdicts (an "Example:" APPROVED template followed by the
   real REJECTED) parsed as APPROVED.

The parser now requires a FULLY valid verdict line outside code fences,
blockquotes, and table/enumeration rows; collects every candidate verdict
(strict label, `## Verdict` heading, trailing bare token) and fails closed to
`null` on any disagreement or ambiguity. A host-truncated terminal result
(`resultTruncated`) never records an approval — a cut-off text cannot prove a
final verdict.

### P0-2 — the plan-critic dispatch hash was captured too late

The r11 code captured the plan-structure hash in the `tool.execute.after`
hook — AFTER the critic child had already started. A plan edited between
child start and the record write re-anchored the binding to the edited plan,
and the critic's older APPROVED verdict then released it. The baseline
(plan id, structural hash, and a sha256 digest of the full dispatch prompt)
is now captured in `tool.execute.before`, before the child starts, bound to
the exact parent session and call id, and the after-hook consumes exactly
that baseline — it never re-reads plan.json. Without a provable pre-execution
baseline there is NO binding and an async APPROVED can never auto-approve
(the audited `approve_plan_critic` escape hatch remains).

### P1-1 — plan-critic approval was not atomically deduplicated

`hasPlanCriticApprovalSnapshotForCall` + `takeSnapshotEvent` were two
independent operations; two racing recorders could both pass the check and
both write. The existence check and the commit now run under ONE
serialization boundary — the ledger evidence lock — via
`takeSnapshotEvent`'s (now awaitable) `preCommitCheck`, which re-verifies
both the replay fence (no snapshot for this call id) and the plan-structure
fence immediately before the append. Outcomes distinguish
`already_recorded`, `conflict`, `ledger_unreadable`, and `write_failed`;
an unreadable ledger is no longer silently conflated with "approval exists"
(fail-closed on read errors).

### P2-1 — plan-critic dispatch classification was too generous

Automatic approval recording now requires EXPLICIT plan-gate intent
(`MODE: CRITIC-GATE`, per the critic-gate skill) instead of the #2012
recall-biased substring heuristic. An ordinary critic review that merely
mentions `plan.md` or "review the plan" never auto-approves the coder gate.
The critic-gate skill now instructs the architect to use the explicit marker
(mirrored to `.claude`); a missed marker is recoverable via re-running
CRITIC-GATE or the audited `approve_plan_critic` escape hatch.

## Why

An approval snapshot recorded from a non-verdict (a template echo, a fenced
example, a truncated result) or for a plan the critic never reviewed
releases the EXECUTE-phase coder gate without a real review — the exact
authorization boundary the `critic_pre_plan` gate exists to enforce. The
async transport additionally crossed process boundaries (dispatch →
completion → ledger commit), so every check-then-write window had to close
under a durable serialization boundary.

## Testing

- tests/unit/plan/critic-approval.test.ts — strict parser matrix
  (enumeration/fence/quote/table/contradiction/truncated/prose variants,
  bold + CRLF + repeated identical verdicts still parse) and the atomic
  dedup matrix (2 and 3 parallel attempts → exactly one snapshot,
  in-fence plan edit → conflict, crash-replay → already_recorded,
  broken ledger → ledger_unreadable).
- tests/unit/hooks/delegation-gate-plan-critic-baseline.test.ts — the full
  dispatch path: pre-execution binding survives a between-child-start-and-
  after-hook plan edit, foreign-session and missing-capture shapes fail
  closed, ordinary reviews get no binding, and the sync transport passes
  the same pre-execution baseline.
- tests/unit/background/completion-observer-plan-critic-approval.test.ts —
  truncated terminal results, parallel critic reviews (no identity swap),
  imposter child sessions, and status-only plan changes.
- tests/unit/hooks/delegation-gate-plan-critic-gate.test.ts — the #2012
  recall variants are re-pinned as NON-approving ordinary reviews (P2-1);
  the F-B1 coupling guard now pins the explicit gate-intent marker.

All negative regressions were verified to fail against the pre-repair code
and pass after it.
