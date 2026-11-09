---
issue: 3358
---

# Critic-lane contract hardening: override binding, sibling admission, severity disclosure

Collates #3358, #3337, #3341 (one PR, user-authorized collation).

## What changed

- **Override activation is structural, not prose** (#3358 AC1, #3337 AC1): the critic and reviewer agent prompts no longer carry a phrase-activated PR-review exception — a plan or spec quoting "CONTROLLER-BOUND PR WORKFLOW CONTRACT" can no longer suspend PLAN REVIEW or the Stage-B mandate on non-PR runs. The suspension is now a controller-authored clause injected only into bound `swarm-pr-review:critic` lane blocks (`CRITIC_PROTOCOL_SELECTION_CLAUSE`), beside the existing reviewer clause. Non-PR critic and reviewer runs carry no PR-review text at all.
- **PR critic lanes verify the effective prompt** (#3358 AC2): admission refuses a critic agent registered with a custom prompt — both `critic.md` (replacement) and `critic_append.md` (append) from the opencode-swarm prompts directory — because neither can be mechanically verified to keep the `[CRITIC]` row contract. A belt additionally asserts every composed critic lane prompt carries the suspension clause. **Policy awaiting owner confirmation**: this is a user-visible change; remediation is to remove the file and restart OpenCode (or run the review without PR critic lanes). Non-PR critic use is unaffected.
- **Earlier-semantics verdict rows are disclosed, never silently dropped** (#3358 AC3): a reviewer row rejected only by the v1→v2 CONFIRMED/NONE tightening (`PR_REVIEW_VERDICT_SEMANTICS_VERSION = 2`) is recorded on the composition (`semanticsMismatchedItemIds`) and, while still unclaimed, blocks N-of-M settlement with a dedicated disclosure naming the items — instead of surfacing as a generic missing-verdict failure.
- **Findings write contract enforces the transport rule** (#3358 AC4): a findings record with CONFIRMED + severity NONE is rejected at the write boundary; durable records read through a read-tolerant schema so pre-rule rows keep loading.
- **One reviewer composition per critic dispatch** (#3358 AC5): the critic preflight derives order-unstable ids and reviewer severities from one shared gate context (previously composed twice).
- **Idempotent contract application** (#3358 AC6): re-applying the PR workflow prompt contract to a lane already carrying its controller block succeeds with exactly one block; recognition is strip-and-rebuild, never authentication.
- **Reviewer severities render on their own lines** (#3358 AC7): `assigned_item_ids` keeps bare ids; each severity appears as `reviewer_severity: <id>=<SEV>`. A verbatim copy of the old decorated token (`c1 (HIGH)`) no longer voids the lane as an unassigned id.
- **Uniform sibling admission** (#3358 AC8): one exported `PR_REVIEW_PHASE_ADMITTED_ROLES` table governs dispatch admission (exact membership — a user-defined `council_*`-prefixed agent is no longer admitted to council lanes), the gate recorder, and artifact integrity (launch-time normalizedAgent).
- **Side-effect-free phase admission** (#3341): PR_REVIEW council/reviewer/critic lane admission (roles, launchability, critic prompt provenance, owned-lane refusal) runs before gate activation/binding, so a refused batch consumes no durable workflow state; the side-effect-free comment states this scope precisely.
