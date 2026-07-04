# Critic gate obligation traceability enforcement (issue #1628)

## What changed

### MUST/SHALL SC-### obligation traceability is now enforced at the critic gate

The plan/critic-gate workflow now enforces that every MUST or SHALL SC-###
success criterion in the spec must map to at least one plan task before the
plan can be approved. The check runs before the substantive critic rubric.

**Before**: The critic evaluated plans on their technical merit, feasibility, and
completeness, but would not automatically reject plans that left spec
obligations unaddressed. SC-### obligations could slip through the gate if
no reviewer caught them manually.

**After**: When the critic evaluates a plan, it first extracts all MUST/SHALL
SC-### obligations from the spec, then verifies that each one has at least one
plan task that addresses it. Any unmapped obligation causes the critic to
return `VERDICT: REJECTED`, enumerating each unmapped SC-### by name.
Approval is not granted until all obligations are covered by plan tasks.

The TRACEABILITY CHECK section in `src/agents/critic.ts` runs as a
pre-rubric gate. Only after all obligations are confirmed mapped does the
critic proceed to substantive evaluation (feasibility, risk, scope, etc.).

### Files changed

- `.opencode/skills/plan/SKILL.md` and `.claude/skills/plan/SKILL.md`:
  TRACEABILITY CHECK extended to cover MUST/SHALL SC-### obligations
- `.opencode/skills/critic-gate/SKILL.md` and `.claude/skills/critic-gate/SKILL.md`:
  New obligation traceability enforcement section
- `src/agents/critic.ts`: TRACEABILITY CHECK pre-rubric gate added

## Why

Issue #1628 (Skill-Improver Recommendations Triage): R3 obligation traceability.
The R3 obligation required that the plan/critic-gate workflow formally track
MUST/SHALL success criteria (SC-###) from the spec and verify they are
addressed by plan tasks before plan approval. Without this enforcement, it was
possible for obligations to be documented in the spec but never actually planned
for — a form of spec drift that the critic gate did not catch.

This change closes that gap: the critic now structurally verifies that every
binding obligation in the spec has a corresponding task before the plan can
proceed past the gate.

## Migration steps

- No migration required. Plans that already cover all MUST/SHALL obligations
  are unaffected. Plans with gaps will receive a rejection at the critic gate
  with the specific unmapped SC-### obligations enumerated.

## Breaking changes

- Plans that do not map every MUST/SHALL SC-### obligation to at least one
  task will be rejected at the critic gate with `VERDICT: REJECTED` and an
  enumeration of each unmapped obligation. Architects must add tasks to cover
  any missing obligations before re-submitting.

## Known caveats

- Only obligations with the `SC-###` identifier pattern are covered by the
  traceability check. Other obligation styles (e.g., `FR-###`, free-text
  requirements) are not included in this check and remain subject to
  substantive rubric evaluation.
- The check is a pre-rubric gate; it does not evaluate task *quality* —
  only that coverage exists. A task that nominally addresses an obligation but
  is substantively incomplete will still pass the traceability check and be
  caught by the rubric.
- SKILL.md changes in `.opencode/skills/` and `.claude/skills/` are mirrored
  pairs; drift between them is detected by `scripts/drift-check.ts` (CI
  soft-warn, enforced when `DRIFT_CHECK_ENFORCE=1`).
