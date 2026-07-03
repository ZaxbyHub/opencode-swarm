# `feat(memory)`: close the learning loop — council verdicts drive EMA confidence, suppression, and promotion

## Summary

- **Attribution (Phase A):** each memory recall bundle now carries a `unit_id` (the plan-task id), letting a phase/final council verdict or task completion reward the exact memories that were actually used for that unit of work — not merely "whatever the session touched." A task's approval (`APPROVE` → advance to `complete`) applies an upward EMA q-value update (`q ← (1-η)·q + η·reward`, η=0.10) to its recalled memories via the shared reward mechanism (A.3/A.4).
- **Precise & all-scope attribution + propagation (Phase B):** `submit_phase_council_verdicts` and `write_final_council_evidence` now reward session-recalled memories on their real overall verdict (`APPROVE`=1.0 / `CONCERNS`=0.5 / `REJECT`=0.0), trust-gated on a verified `ctx.sessionID` (never the model-suppliable `provenanceSessionId`). Soft Q-propagation (B.5) nudges *related* memories by a configurable fraction (`propagationRelatednessThreshold`, default 0.7) of the direct reward, so learning generalizes beyond the exact recalled record. A deterministic negative-terminal sweep (B.6) runs at `/swarm finalize` — tasks left non-complete (`close_reason='session_terminated'`) apply a `0.0` reward to their recalled memories, making suppression (q < 0.15) functionally reachable rather than positive-only.
- **Active exploration (Phase C):** default recall occasionally (`explorationRate`, default 0.05) resurfaces an otherwise-suppressed low-q memory, flagged `explored: true`, so it can earn its way back via the same reward path. Inclusion is strictly additive at the recall-slice layer (`sliceRecallItemsWithExploration`) — it never evicts a legitimately ranked hit; normal (non-exploring) recalls are unaffected.
- New diagnostics: `/swarm memory value-log` shows per-memory q-value evolution, recent rewards, and suppression/promotion candidacy.

## User-facing changes

- Memory usefulness now genuinely adapts to outcomes: memories that get used in approved work rise toward promotion (q > 0.85); memories tied to abandoned or rejected work drift toward suppression (q < 0.15) and stop being injected by default.
- No configuration changes required to benefit — the loop runs on the existing `memory.qLearning` defaults. New optional tunables: `qLearning.propagationRelatednessThreshold` (0–1, default 0.7) and `qLearning.explorationRate` (0–1, default 0.05).

## Migration notes

None required. All schema additions are additive with safe defaults (a new nullable `unit_id` column, backfilled; absent `metadata.qValue` defaults to 0.5), so existing memory stores and the jsonl provider behave unchanged until they start earning rewards.

## Known limitations

- **Injection-path attribution is coarser than the direct-recall path.** `unit_id` is populated for the orchestrator-session recall path; recalls injected into a subagent's own session currently fall back to session-scoped (`run_id`) attribution rather than per-task attribution, pending a follow-up prompt-parse enhancement.
- **Active exploration (Phase C) does not always reach the final injected prompt** in two pre-existing configurations: (1) under the opt-in embeddings/RRF fusion path with default `minScore`, a resurfaced item can normalize below the fusion re-gate and be dropped; (2) the injection token-budget packer fills in rank order and can drop the (necessarily lowest-ranked) explored item under budget pressure. Both are documented, deliberate trade-offs — reserving injection budget for exploration would mean evicting a legitimate higher-q memory from the model-facing prompt, which is a product decision deferred to the same follow-up as the attribution enhancement above. The default (non-embeddings) recall path and direct `swarm_memory_recall` tool calls are unaffected.
