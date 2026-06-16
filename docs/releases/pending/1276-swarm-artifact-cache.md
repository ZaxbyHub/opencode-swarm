# Swarm Artifact Cache

- Added a bounded stat-metadata keyed read-through cache for frequently read swarm artifacts on the chat injection path.
- Reused cached parsed plan and knowledge JSONL forms when files are unchanged, while returning cloned parsed values so callers cannot mutate cached state.
- Hardened cache invalidation for same-size rewrites and mid-read file changes, kept eviction FIFO as documented, and split text/parsed eviction counters for clearer diagnostics.
- Preserved fail-open behavior: stat/read/parse failures continue through the existing fallback paths instead of blocking hook execution.
- Focused regression coverage shows unchanged raw `.swarm` reads drop from two direct reads to one cached read, and repeated parsed `plan.json` / `knowledge.jsonl` loads drop to one parsed read until rewrite invalidation.
- Fixed reviewer `SKILL_COMPLIANCE` capture so verdict lines no longer require a trailing space to be recorded.
- Restored the architect prompt's `6k. SPEC-STALENESS GUARD` guidance so spec-drift prompts continue to surface `removed_task_ids`, `SPEC_DRIFT_BLOCKED_TOOLS`, and `SPEC_DRIFT_BLOCK`.
- No migration is required.
