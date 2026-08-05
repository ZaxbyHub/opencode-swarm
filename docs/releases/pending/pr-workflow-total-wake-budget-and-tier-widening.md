## PR workflow: total wake budget + widened depth tiers (#1967 Ship 2)

**Problem A — auto-resume loop unbounded:** The PR-workflow auto-resume loop had only a consecutive-unproductive counter (5) that reset to 0 whenever the durable gate's `revision` advanced. There was no total-wake cap, so any state-mutating controller call bought 5 fresh wakes, allowing unbounded compaction loops on large-context models.

**Fix:** Added a total per-session wake budget (totalWakes) alongside the existing consecutive budget. The total counter increments on every attempted wake (including failures and timeouts) and is never reset by revision progress. When exhausted, the session suspends with a distinct total-cap notice (not the consecutive-unproductive wording) naming all three recovery paths.

The ceiling is context-aware (Option C): scaled by the PR-review depth tier, with per-tier values derived from each tier's consolidation-floor workload: Small (S): 12, Medium (M): 54, Large (L): 102 (>=100, above the ~40-55 healthy minimum). Configurable via createPrWorkflowResponseGate({ totalWakeCeiling }). The bound is per-process (in-memory Map, resets on plugin reload).

**Problem B — depth tiers rarely engaged:** The depth-tier thresholds (Small <=50 lines/<=3 files, Medium <=500 lines/<=20 files) were so tight that most real PRs landed at tier Large.

**Fix:** Widened to Small <=100 lines/<=5 files, Medium <=1500 lines/<=50 files. All six base dimensions and all eleven risk families remain mandatory at every tier. Fail-strict-to-Large on unknown stats and submodule changes preserved.