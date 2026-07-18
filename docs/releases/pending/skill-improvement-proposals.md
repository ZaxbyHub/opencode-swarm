---
add: skills
---

## Skill improvement proposals applied

Applied 6 critic-reviewed skill improvement proposals (origin: `/swarm finalize --skill-review` proposal `.swarm/skill-improver/proposals/2026-07-17T22-22-08-435Z.md`) across 5 skill files.

### What changed

- **editing-skills** (SR-2): Added blocking pre-flight step — classify new skill slug in `skill-mirrors.ts`, `bundled-skills.ts`, and `package.json#files` before authoring SKILL.md content. Prevents drift-check failures.
- **qa-sweep** (SR-3, SR-6, PI-2, PI-3): Added 4 sections — reviewer rejection escape hatch (escalate to `critic_sounding_board` after 2+ cycles), `SKILL_LOAD_FAILED` re-dispatch guidance, conditional inline-code fallback, one-shot docs review delegation.
- **commit-pr** (SR-5): Added "Ground-truth verification (mandatory)" subsection — verify every file path, script name, identifier, and env var in release fragments against the codebase.
- **critic-gate** (PI-4, both `.opencode` + `.claude` mirrors): Added post-approval verification — call `get_approved_plan` before first coder dispatch to confirm plan-under-execution matches the critic-approved snapshot.

### Why

The `/swarm finalize --skill-review` step identified actionable improvements to skill robustness after PR #1865 closed. Each proposal was critic-reviewed; 3 additional proposals (SR-1, SR-4, PI-1, PI-5) were skipped per critic verdict (already-covered, factually inverted, or out-of-scope).

### Migration

No migration required. All changes are additive documentation; no runtime behavior, tool signatures, or APIs changed.

### Caveats

- One pre-existing drift finding surfaces (`commit-pr-generic.test.ts:53` asserts "conventional" — removed in #908). Not introduced by this PR; documented in the PR body.
