## Skill-Usage Feedback Robustness (closes #1297)

Closes two robustness gaps in the skill-usage feedback chain. Processing the
same batch twice is now a guaranteed no-op, and compliance attribution no longer
guesses under interleaved delegations.

### Gap 1 — marker-loss idempotency
- Removed the `.swarm/skill-usage-last-processed.json` sidecar marker; idempotency is now provided exclusively by `feedback_applied` markers written into `.swarm/skill-usage.jsonl`
- `pruneSkillUsageLog` now preserves `feedback_applied` marker lines across prune cycles so idempotency survives log rotation
- Deleting `.swarm/skill-usage.jsonl` is no longer a recovery step — reprocessing the same batch is safe

### Gap 2 — explicit compliance attribution
- Reviewer prompt now instructs the LLM to output a `TASK: <task-id>` line immediately before `SKILL_COMPLIANCE` so attribution is explicit, not heuristic
- Eliminates reliance on "latest delegation" fallback under interleaved or parallel delegations

### Tests
- New "interleaved delegations" fixture in `tests/unit/hooks/skill-propagation-gate.test.ts` covers both the positive case (explicit `TASK:` → correct attribution, including `skillPath`) and the negative control (omitted `TASK:` → fallback picks the latest delegation)
- New "prune preserves feedback_applied markers" test in `tests/unit/hooks/skill-usage-feedback.test.ts` proves idempotency survives `pruneSkillUsageLog`
- Existing "processed entry markers prevent marker-loss reapplication" test continues to pass
