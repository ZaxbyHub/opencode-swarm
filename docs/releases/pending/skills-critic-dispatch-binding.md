# `fix(skills)`: bind the critic dispatch to the harness's pinned cross-model critic

## Summary

- Added a **"Critic role binding (all profiles)"** paragraph to the Phase 8 Critic Challenge of `.opencode/skills/swarm-pr-review/SKILL.md` — the critic dispatch must resolve to an ELIGIBLE pinned critic (not the reviewer's model family where identity is exposed); a same-family pinned critic still serves under the degraded disclosure; the generic fallback is Profiles B/C only (no pinned type on the roster, or a Hard Rule 14 failed dispatch), and a degraded gate restricts the verdict to REQUEST_CHANGES or INCOMPLETE
- The policy binds harness adapters declaratively (mechanical enforcement is tracked in #3537): a condensed/installed skill copy whose routing note names a generic agent for this role without the pinned-first rule is defective and must be corrected, not followed

## User-facing changes

Binding routing-policy change to the swarm-pr-review skill text (prose-only; no runtime code): orchestrators following installed condensed copies no longer get a generic-agent routing note to follow for the critic role; an ineligible (same-family) pinned critic now requires the degraded-independence disclosure instead of passing silently; a degraded critic gate restricts the verdict to REQUEST_CHANGES or INCOMPLETE. Installed copies change only when someone corrects them — enforcement is #3537's scope.

## Migration notes

None required. Installed copies that carry a generic-agent critic routing note should be corrected to the pinned-first policy (the canonical paragraph is the reference wording).

The feedback round hardened the binding (eligible-type selection, same-family disclosure, Hard Rule 14 failure definition + BLOCKED exception, identity-not-exposed rule, Profile A carve-out, exhaustive gate slot + provenance bullet), moving the canonical's ratchet baselines pinning `.opencode/skills/swarm-pr-review/SKILL.md` to 1716 in `tests/unit/skills/progressive-disclosure-ratchet.test.ts` and `tests/unit/skills/swarm-pr-review-partial-settlement-2859.test.ts`; the new `tests/unit/skills/critic-role-binding-pin.test.ts` text pin guards the binding clauses independently of the ratchet. The paragraph is binding policy that installed copies must carry inline, so it stays in the canonical rather than moving into `references/`; the skill's progressive-disclosure debt grows by the same lines.
