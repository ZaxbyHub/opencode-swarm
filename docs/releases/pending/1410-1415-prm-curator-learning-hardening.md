Fixes PRM trajectory durability, Curator recommendation retention, and `/swarm learning` timeout handling.

- PRM session trajectories now update cache only after durable disk writes, refill cache from disk on cold reads, bound cached sessions, expose path helper coverage, and reset PRM/trajectory in-memory state during `/swarm reset-session` and close/reset flows.
- Curator phase summaries now accumulate recommendations, cap retained phase digests, compliance observations, and knowledge recommendations, report malformed recommendation lines and structured JSON blocks through debug-gated logs, filter unknown knowledge IDs, and document current defaults/configuration.
- Existing projects with more than 50 stored phase digests will retain the most recent 50 the next time the curator writes `curator-summary.json`; older phase digests are intentionally dropped to bound summary size.
- Curator gains config fields for `postmortem_enabled`, `min_skill_confidence`, and `min_skill_confirmations`.
- `/swarm learning` now defaults to a 30 second timeout, supports `--timeout-ms`, passes cancellation into metrics computation, and returns structured timeout output for markdown and JSON modes.
