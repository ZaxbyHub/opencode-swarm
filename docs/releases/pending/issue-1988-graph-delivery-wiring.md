# Graph delivery wiring: agent prompts, lane orientation, deep-dive reuse, delivery dedupe persistence

## What changed

The repo graph is now delivered to the agents and workflows that need it (issue #1988, plan PR4):

- **Explorer, coder, and reviewer prompts are graph-first.** Explorer's ACTIONS block now leads with `repo_map action="ask"` / `action="context_pack"` (orientation first — read the located files before reporting), with blind tree/glob/grep scanning reserved for gaps the graph does not cover (`stale: true`, missing files, non-code assets). Coder is directed to `repo_map action="localization"` before editing shared or cross-imported files (covering the undeclared-scope case the injected block does not), and reviewer to `repo_map action="blast_radius"` for changed files not covered by an injected REPO GRAPH block.
- **Lane dispatch gains a bounded orientation block.** `dispatch_lanes` and `dispatch_lanes_async` accept an optional `orientation` boolean (no schema default — availability depends on graph state; omitted means "attempt when a fresh graph exists"). When emitted, a deterministic, cache-prefix-positioned block — top mission-relevant files (single `ask` over the concatenated lane missions), repo hubs, and a one-line freshness statement — is appended to `common_prompt` so lanes start graph-oriented instead of blind. Emission is gated by a relevance floor (normalized top-3 share ≥ 0.35), a 600-token budget, per-session novelty dedupe (bounded 128 pointers, silent suppression on repeats), and a pre-append `MAX_PROMPT_CHARS` overflow check that drops the block rather than failing dispatch.
- **deep-dive no longer re-pays the full graph build.** Its scope-resolution step now runs `repo_map action="graph_health"` first and only builds when the graph is missing or incomplete, and prefers `ask`/`key_files` over manual symbol/import walks. Both skill trees updated byte-identically.
- **Lane-output redelivery dedupe survives restarts.** Delivery keys are now session-scoped and persisted to `.swarm/lane-delivery-cache.json` (bounded 1024 entries, cross-session FIFO, best-effort atomic write, fail-open load with corrupt-file quarantine), fixing both the restart re-delivery gap and the documented cross-session false-suppression bug of the old in-memory Set.

## Why

The repo-graph subsystem was capable but undelivered: zero agent prompts mentioned `repo_map`, lane prompts were pure `common_prompt` concatenation, deep-dive rebuilt the graph unconditionally, and the lane-output dedupe fell open across restarts. Curated, bounded, relevance-gated orientation is the delivery layer that makes the graph felt (plan §7; AOrchestra/Anthropic multi-agent evidence summarized in the issue).

## Migration

No migration required. The new `orientation` dispatch argument is optional; behavior defaults to "emit when a fresh, relevant graph exists". The lane-delivery cache file appears under `.swarm/` automatically and is safe to delete at any time (fail-open).

## Known caveats

- The 0.35 relevance floor is applied to the normalized top-3 score share because raw `ask` scores are graph-size-dependent PageRank probabilities (a perfectly-targeted mission on this 3.4k-node repo scores ~0.01 absolute). The constant remains the plan's starting value and is re-tuned in PR6 (#1989's measurement work).
- Suppressed repeat orientation blocks emit nothing by design (dedupe); a dispatch with entirely novel missions still emits.
