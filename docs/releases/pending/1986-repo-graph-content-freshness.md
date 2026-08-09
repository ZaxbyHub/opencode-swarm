---
category: Added
---

- Replace repository-graph age checks and unconditional session rebuilds with a bounded, cached workspace fingerprint probe. Unchanged sessions reuse the persisted graph, small complete drift refreshes incrementally, large or manifest drift rebuilds safely, and incomplete walks never authorize deletion.
- Add `repo_graph.enabled`, `init_refresh`, `refresh_cap`, `walk_budget_ms`, and `max_files` configuration. Repository-map queries and coder/reviewer context share the same freshness state; uncertified and over-cap graph guidance is suppressed, while incomplete probes stay read-only and freshness-unknown.
