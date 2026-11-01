# `fix(skills)`: bind the critic dispatch to the harness's pinned cross-model critic

## Summary

- Added a **"Critic role binding (all profiles)"** paragraph to the Phase 8 Critic Challenge of `.opencode/skills/swarm-pr-review/SKILL.md` — the critic dispatch must resolve to the harness's pinned cross-model critic agent type when one exists (model-independent from the reviewer where the harness exposes model identity); a generic agent type is a fallback only when no pinned type exists or the pinned dispatch fails, and the substitution is disclosed in the synthesis as a degraded independence gate
- The policy binds harness adapters declaratively (mechanical enforcement is tracked in #3537): a condensed/installed skill copy whose routing note names a generic agent for this role without the pinned-first rule is defective and must be corrected, not followed

## User-facing changes

Binding routing-policy change to the swarm-pr-review skill text (prose-only; no runtime code): orchestrators following installed condensed copies no longer get a generic-agent routing note to follow for the critic role; an ineligible (same-family) pinned critic now requires the degraded-independence disclosure instead of passing silently; a degraded critic gate restricts the verdict to REQUEST_CHANGES or INCOMPLETE. Installed copies change only when someone corrects them — enforcement is #3537's scope.

## Migration notes

None required. Installed copies that carry a generic-agent critic routing note should be corrected to the pinned-first policy (the canonical paragraph is the reference wording).

The canonical grows by 21 lines (1692 -> 1712) after the feedback round hardened the binding (eligible-type selection, same-family disclosure, Hard Rule 14 failure definition, Profile A carve-out, gate + provenance slots), so the progressive-disclosure ratchet baselines pinning `.opencode/skills/swarm-pr-review/SKILL.md` are bumped to 1712 in `tests/unit/skills/progressive-disclosure-ratchet.test.ts`, `tests/unit/skills/swarm-pr-review-partial-settlement-2859.test.ts`, and the new `critic-role-binding-pin.test.ts` text pin. The paragraph is binding policy that installed copies must carry inline, so it stays in the canonical rather than moving into `references/`; the skill's progressive-disclosure debt grows by the same lines (the ratchet test's issue-#2131 tracker reference is CLOSED upstream — its header wording is pre-existing and out of this PR's scope).
