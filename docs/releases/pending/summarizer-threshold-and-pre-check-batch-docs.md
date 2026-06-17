# Context usage reduction: summarizer threshold, pre_check_batch docs, tool-gating, and knowledge_ack retirement

## What changed

### 1. Summarizer threshold lowered (Issue #1323)

`SummaryConfigSchema.threshold_bytes` default changed from **102,400 bytes (100 KB) to 16,384 bytes (16 KB)**. With the existing 1.25× hysteresis factor, summarization now fires at approximately 20 KB instead of approximately 128 KB.

This means tool outputs in the 10–60 KB range — produced by tools like `search`, `sast_scan`, `pkg_audit`, `secretscan`, and `symbols` over large code trees — are now summarized in-context with retrievable summaries, rather than persisting in full to the plan ledger. Full retrieval via `retrieve_summary` (with offset/limit) is preserved unchanged.

### 2. pre_check_batch documented as preferred Stage A aggregator

Added guidance to the architect prompt's Stage A section documenting `pre_check_batch` as the recommended approach for post-implementation verification. `pre_check_batch` runs `lint:check` + `secretscan` + `sast_scan` + `quality_budget` in parallel (up to 4 concurrent), giving faster and more comprehensive feedback than running those tools sequentially.

### 3. Retired deprecated knowledge_ack tool (Issue #1323)

The deprecated single-outcome `knowledge_ack` tool has been retired in favor of its batched successor `knowledge_receipt`. The retirement is additive-only:

- **Removed from:** tool registration, barrel exports, manifest, plugin registration, and architect prompt references.
- **Preserved:** legacy reader paths in `knowledge-events.ts` and `state.ts` so existing `.swarm/knowledge-application.jsonl` records in user projects remain readable. The source file (`knowledge-ack.ts`) is retained but no longer exported.
- `knowledge_receipt` is now the sole knowledge-acknowledgment mechanism, supporting batched applied/ignored/contradicted entries plus new-lesson persistence.

The architect base tool count is now **66** (was 78 before this PR — 11 tools gated behind feature flags + 1 retired).

### 4. Stale LeanTurboConfigSchema test corrected

The `worktree_isolation` test for `LeanTurboConfigSchema` was updated. The feature is now implemented in the lean turbo runner; the test had not been updated to reflect this and was still asserting that the field should be rejected.

### 5. Feature-flag gating of council and turbo tools (Issue #1323, #1388)

The architect agent's unconditional tool surface has been reduced from 78 to 66 tools. Council (~7) and turbo (6) tools are now gated behind their feature flags using the existing conditional-merge pattern (same as memory and external-skill tools):

- **Council-mode tools** (`submit_council_verdicts`, `submit_phase_council_verdicts`, `declare_council_criteria`, `write_final_council_evidence`) are granted only when `council.enabled` is true.
- **General-council research tools** (`convene_general_council`, `web_search`, `web_fetch`) are granted only when `council.general.enabled` is true.
- **Lean turbo tools** (`lean_turbo_*`) are granted only when a turbo configuration block is present.

No capability is lost — every gated tool remains available when its feature is enabled. The `web_search` tool retains its grants to `sme`/`researcher`/`skill_improver` agents.

## Why

Large tool outputs (10–60 KB) were being stored in full in the plan ledger even when they could be summarized. This inflated context size without adding proportionate value for subsequent reasoning steps. The lower threshold makes summarization fire earlier and more often for these mid-sized outputs, keeping context leaner without losing access to the full content via `retrieve_summary`.

`pre_check_batch` was already a production tool but was not clearly flagged as the preferred Stage A verification path in the architect's workflow. Surfacing it reduces the chance architects use slower sequential alternatives.

The `knowledge_ack` tool was deprecated in favor of `knowledge_receipt` (#1323). The single-outcome acknowledgment pattern was superseded by the batched receipt pattern which supports multiple outcomes (applied/ignored/contradicted) plus new-lesson persistence in a single call.

The unconditional tool surface for the architect agent included tools for features that may never be enabled in a given environment (council mode, lean turbo) plus a deprecated tool (`knowledge_ack`). Gating deprecated and feature-gated tools reduces confusion about available capabilities and aligns with the existing pattern used for memory and external-skill tools (#1388).

## Migration

No configuration changes required. Existing configs continue to work unchanged.

## Breaking changes

None.

## Behavioral change

The `tool_filter.overrides.architect` conflict guard that previously threw an error when council tools were omitted from a user override (with `council.enabled=true`) has been replaced with auto-merge. Council tools are now always available when `council.enabled=true`, regardless of override contents. Users who relied on the throw behavior to exclude council tools should set `council.enabled=false` instead.
