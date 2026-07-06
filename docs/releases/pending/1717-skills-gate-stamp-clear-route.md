# Skills: gate activation on eval, stamp draft sources, route curator archive through shared invalidator, clear retire links

## What changed

Four fidelity fixes in the knowledge→skill pipeline (issue #1717), each closing
a gap that allowed skills to activate unvalidated, recompile repeatedly, get
silently orphaned, or retain stale back-pointers:

- **G8 — Eval gate now surfaces `unevaluated` and requires confirmation.**
  `activateProposal` and the `skill_apply` tool gained a `confirmUnevaluated` /
  `confirm_unevaluated` option (default false). When evaluation returns
  `unevaluated` (no eval set exists), activation is blocked with a surfaced
  reason unless the caller explicitly opts in. Generated skills now also
  auto-derive an eval stub (`.swarm/skills/evals/<slug>/auto-stub.json`) from
  their source directives (`required_actions`/`forbidden_actions`/
  `verification_checks`), so the gate has something real to check in the common
  case. The full-auto paths (`autoApplyProposals`, post-mortem triage) pass
  `confirmUnevaluated:true` to preserve their headless semantics.

- **G10 — Draft proposals now stamp source entries.** `stampSourceEntries`
  gained a `mode: 'active' | 'draft'` parameter; the draft generation branch
  stamps `draft_generated_skill_slug`/`draft_generated_skill_path`.
  `selectCandidateEntries` honors the draft marker, so a cluster already
  compiled into a draft is not recompiled every phase. The `autoApplyProposals`
  REJECT branch clears the draft marker via `clearDraftSkillLinks` so the
  cluster can be recompiled after a proposal is rejected.

- **G11 — Curator archive now routes through the shared invalidator.** A new
  `src/hooks/skill-invalidator.ts` extracts the tombstone + retire/stale
  sequence that was inlined in `knowledge-archive.ts` and `knowledge-remove.ts`.
  `applyCuratorKnowledgeUpdates`'s archive arm now calls it, so
  curator-archived knowledge writes an audit tombstone and triggers the
  `retireOrMarkStale` microtask for linked skills (previously it silently
  orphaned them). The real pre-mutation status is captured for the tombstone.

- **G12 — `retireSkill` now clears the bi-directional link.** A new
  `clearRetiredSkillLinks` helper reads the retired skill's
  `sourceKnowledgeIds`, clears `generated_skill_slug`/`generated_skill_path`
  on those source entries, and records the retired slug in a new
  `retired_skill_history` field (capped at 50). All retire callers benefit
  automatically; `restoreEntry` can no longer round-trip a stale pointer.

## Why

These four gaps were confirmed by code inspection in the issue. Skills are the
user-visible output of the learning system; each gap degraded quality in a
distinct way — unvalidated activation, repeated recompilation churn, silent
orphaning, and stale links surviving retirement. The fixes are the smallest
patches that close each gap without unwired functionality or hidden regressions.

## Impact

- Generated skills now ship with an auto-derived eval stub, so the activation
  gate can validate them against their source directives instead of
  fail-opening to `unevaluated`.
- The interactive `skill_apply` tool now blocks unevaluated activation by
  default; pass `confirm_unevaluated: true` to opt in (preserves the old
  behavior when explicitly desired).
- Curator-archived knowledge no longer silently orphans its generated skills;
  the same audit tombstone + retire/stale invalidation that the
  `knowledge_archive` tool uses now fires for curator recommendations too.
- Retired skills no longer leave stale back-pointers on source knowledge
  entries.

## Migration

- The three new schema fields (`draft_generated_skill_slug`,
  `draft_generated_skill_path`, `retired_skill_history`) are additive and
  optional — no migration, no break to existing entries.
- Existing call sites of `activateProposal` that did not pass
  `confirmUnevaluated` continue to work; only the interactive `skill_apply`
  tool's default behavior changes (now blocks unevaluated unless
  `confirm_unevaluated: true`).
- The shared invalidator preserves `knowledge_remove`'s historical
  no-tombstone behavior via `skipTombstone: true`.

## Breaking changes

- The interactive `skill_apply` tool now defaults `confirm_unevaluated` to
  false, so activating a proposal with no eval set (and no auto-stub) returns
  `{ activated: false, reason: 'unevaluated: ...' }` instead of activating
  silently. Pass `confirm_unevaluated: true` to restore the old behavior.
  Generated directive-backed skills are unaffected (their auto-stub makes the
  gate return `passed` or `rejected`, not `unevaluated`).
