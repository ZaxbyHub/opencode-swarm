## PR workflow: total wake budget + widened depth tiers (#1967 Ship 2)

**Problem A — auto-resume loop unbounded:** The PR-workflow auto-resume loop had only a consecutive-unproductive counter (5) that reset to 0 whenever the durable gate's `revision` advanced. There was no total-wake cap, so any state-mutating controller call bought 5 fresh wakes, allowing unbounded compaction loops on large-context models.

**Fix:** Added a total wake budget (totalWakes) alongside the existing consecutive budget, scoped to one process lifetime and running until the durable gate clears via complete/abort — note it deliberately survives the PR_REVIEW → PR_FEEDBACK handoff, which mints a new workflow activation without clearing the gate. The total counter increments on every attempted wake (including failures and timeouts) and is never reset by revision progress. When exhausted, the session suspends with a distinct total-cap notice (not the consecutive-unproductive wording) naming all three recovery paths, and appends a `pr_workflow_wake_suspended` record to `.swarm/events.jsonl` carrying the reason, counters, tier, and ceiling in force.

The ceiling is context-aware (Option C): scaled by the PR-review depth tier, with per-tier values derived from each tier's consolidation-floor workload: Small (S): 12, Medium (M): 54, Large (L): 102 (>=100, above the ~40-55 healthy minimum). Configurable via createPrWorkflowResponseGate({ totalWakeCeiling }). The bound is per-process (in-memory Map, resets on plugin reload).

**Problem B — depth tiers rarely engaged:** The depth-tier thresholds (Small <=50 lines/<=3 files, Medium <=500 lines/<=20 files) were so tight that most real PRs landed at tier Large.

**Fix:** Widened to Small <=100 lines/<=5 files, Medium <=1500 lines/<=50 files. All six base dimensions and all eleven risk families remain mandatory at every tier. Fail-strict-to-Large on unknown stats and submodule changes preserved.

---

### Publish-time obligation (do not copy stale values)

The review of the first attempt at this change found that its PR body carried
quantitative claims and `src/hooks/pr-workflow-response-gate.ts` line citations
that were never measured or re-derived at publish time, and were wrong by the
time it merged. Before publishing any PR that carries this fragment:

1. **Re-measure, do not copy.** Run `bun test` over the explicit list of the 11
   `tests/unit/hooks/pr-workflow-response-gate*.test.ts` files plus
   `tests/unit/tools/dispatch-lanes-pr-workflow-gate.test.ts` (explicit list —
   AGENTS.md invariant 7 forbids `bun test <dir>`), and run `bun run lint:ci`.
   Put those counts in the PR body. Any count carried over from an earlier
   revision is stale by construction.
2. **Re-derive every line citation** in the PR body's invariant audit against
   the exact publish HEAD. Line numbers shift with every commit, so a citation
   copied from a prior revision is wrong even when the claim it supports is
   right.

Delete this section when the fragment is consumed at release time.