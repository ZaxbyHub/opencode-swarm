# Bounded reviewer directive-compliance block (#2628)

## What changed

- The reviewer `<directives_to_verify>` block is now **per-entry bounded**.
  Previously the block carried one obligation per receipt membership — one per
  `(trace_id, entry_id)` pair — so a long-lived cohort where knowledge entries
  were retrieved across many traces grew the block O(entries × trace_ids)
  (measured 813 KB in the field) until the reviewer's session could not be
  created and the verification gate permanently blocked.
- `readPhaseDirectivesToVerify` now returns at most one obligation per entry:
  a membership whose terminal is `violated` or `contradicted` is preferred
  (it carries the remediation obligation), otherwise the most recently
  committed membership;
  ties break by greatest trace_id.
- The rendered block obeys a hard character ceiling
  (`min(inject_char_budget ?? 24000, DIRECTIVE_COMPLIANCE_HARD_CHAR_CAP)`,
  mirroring the #2045 delegate-block bound). Overflow drops non-critical
  directives first (lowest priority first) with a count note; **critical
  directives are always rendered**, and when criticals alone exceed the budget
  the block carries a distinct `critical overflow` notice instead of hiding a
  phase-blocking obligation. Per-entry lesson/verification_predicate prose is
  truncated to 400 characters; pair identity and priority stay exact.
- Violation-class terminals now reach the reviewer for remediation: a
  membership whose terminal is `contradicted` (like `violated`) is shown in the
  compliance block as a remediation obligation, so a contradicted critical
  directive can be resolved by a later reviewer verification instead of
  permanently blocking the phase.
- The phase-complete critical-directive gate now resolves obligations per
  ENTRY rather than per membership: verifying a directive once (on the shown
  representative) satisfies the entry's other exposures in the same phase
  window. An unremediated violation still blocks the phase, and a later
  `applied` terminal remediates an earlier violated one (an earlier applied
  never hides a later violation). Architect overrides behave exactly as
  before.
- The reviewer output-contract text no longer asks for "one verdict per
  trace_id × entry_id combination"; it asks for one verdict per listed
  obligation, copied exactly as before.
- New guardrail: `tests/unit/hooks/prompt-block-budget-guardrail.test.ts`
  statically verifies that every prompt-block builder under `src/` references
  an explicit bounding mechanism (char cap, char/token budget, or item cap),
  so the next injection surface cannot ship unbounded.

## Why

Long-lived projects with heavy knowledge usage accumulated one verification
obligation per historical retrieval exposure. The injected block crossed the
model's input window at reviewer session creation, so review/verification
gates could never start and the swarm stalled. Bounding the obligation unit to
the directive (entry) removes the unbounded axis; the hard cap protects the
remaining vertical axis.
