## Summary
- Closed the post-merge review follow-ups on PR #2457 (issue #1994 corrections):
  - critic-gate PLAN FREEZE: added a DEFAULT-MATERIAL catch-all naming the hashed fields neither the MATERIAL nor BOOKKEEPING-GRADE bullets covered (`schema_version`, `swarm`, `migration_status`, `execution_profile`, phase-level `id`/`name`/`required_agents`), and corrected the `removed_task_ids` framing (it is a `save_plan` argument; the hash captures removals through the task array). Both critic-gate mirrors remain byte-identical.
  - execute skill 5b: added a recovery-precedence rule so a bookkeeping-grade violation routes to `approve_plan_critic` while substantive changes still re-critic.
  - New schema-bound ratchet tests derive the plan-freeze taxonomy from the real `computePlanStructureHash` (flip-each-field hash differentials) instead of hardcoded strings.
  - `placeholder_scan` evidence now discloses scoping metadata (`diff_scoped`, `added_lines_files`, `added_lines_total`) when an `added_lines` map was supplied, closing the audit trail gap for diff-scoped verdicts.
  - `approve_plan_critic` tool description now matches the sanctioned bookkeeping-repair use under the PLAN FREEZE rule.
  - FR-009 provenance record pairs the canonical commit `b7e12d36` with its post-rewrite twin `d82c7172` and describes #1691 accurately as the investigation issue behind PR #1978's branch.
  - architect prompt Stage A one-line pipeline now annotates `placeholder_scan (diff-scoped)`.

## Why
- Post-merge swarm-pr-review audits of PR #2457 (the maintainer-run post-hoc audit comment and the independent follow-up review) confirmed the corrections were sound but left these gaps: an incomplete hashed-field taxonomy that made the bookkeeping escape hatch rationalizable for genuinely material fields, a `removed_task_ids` misframing, a ratchet suite weaker than its name, missing scoping audit metadata, and fragile provenance citations.

## Migration
- No migration required. Skill/prompt text is additive; the placeholder_scan evidence fields are additive optional evidence metadata; no runtime gate behavior changed.

## Caveats
- The scoping metadata records bounded counts, not the `added_lines` map itself; to recover the exact suppressed-line set, recompute the caller's `git diff -U0 HEAD -- <files>` from the same task context.
