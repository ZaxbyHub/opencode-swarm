# Host task tool id engaged across the plugin (issue #2529)

## What changed

- **Configured subagent `fallback_models` now actually engage.** The OpenCode host invokes its native subagent tool with the lowercase id `task`, but the task-model route registration gate compared exclusively against the capitalised `'Task'`, so no route was ever registered for a real host dispatch — a provider 429/503 failed the lane outright instead of rolling over to the configured fallback model. The gate now routes through the shared task-tool boundary, and the session-error signal extractor descends into SDK-shaped `error.data` payloads so a real 429 classifies as retryable and advances the fallback chain.
- **A single dot-safe boundary.** New `isTaskToolId` in `src/hooks/normalize-tool-name.ts` (defined on top of the existing shared normalizer): accepts `task`, legacy `Task`, and colon-namespaced ids (`opencode:task`); a filesystem-loaded custom tool id containing a dot (`notes.task`) is never truncated into the task tool. Eight production comparison sites converted (model-route gate, delegation telemetry, denied-settlement rollback, incremental-verify, memory-recall prompt extraction, loop detector, spawn circuit, gate-denial streaks).
- **Memory recall recovers real delegation prompts.** `extractTaskToolPrompt` now matches the lowercase `task` name in tool_use blocks AND host-shaped `{type:'tool', tool:'task', state:{input}}` parts (every ToolState variant carries `input`), so `agentTask` no longer degrades to the latest user text.
- **Two guardrails so the class cannot silently return:** a repo-wide ratchet test fails if a bare `=== 'Task'` / `!== 'Task'` comparison is reintroduced anywhere in `src/`, and a pinned host-contract test asserts the installed `@opencode-ai/*` versions and the host's real task tool id (provenance-pinned to host source v1.18.3), so a host-side rename fails loudly.

## Why it matters

Users who configured `fallback_models` for subagents got a failed lane on the first provider 429 with no indication the fallback was never registered; the loop detector fixed for one spelling in #2507 left four sibling guards dead against the real host. Coordinated with #2507 (the shared normalizer lands second and adopts it everywhere).
