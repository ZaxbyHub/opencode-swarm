## What changed

- Added `opt-in-tool-registration` skill — pattern guide for adding opt-in/gated tools disabled by default and activated via config flag. Covers tool metadata registration, manifest handler wiring, separate agent tool map, conditional merge, execute() guard ordering, and gating tests.
- Updated `pr-readiness` skill — added Step 8 (PR Body Claim Verification) requiring test counts, pattern counts, storage format, and config field names to be verified against source before merging. Renumbered steps 8-12 to 9-13.
- Updated `swarm-pr-review` skill — added Phase 0A (Existing PR Comment Ingestion) to fetch, classify, and merge existing human/bot review comments as candidate findings before review lanes start. Added Phase 0B (Merge Conflict Detection and Resolution) to check mergeability, resolve simple conflicts, and route semantic conflicts to coder before investing review effort.

## Why

1. Opt-in tool registration has a specific ordering requirement (config check before arg validation) that was violated and fixed during the External Skill Curation Pipeline (PR #1211).
2. Bot reviews caught 3 documentation inaccuracies in PR body text that local testing missed — `pr-readiness` now requires verification.
3. PR reviews often ignore existing bot/human comments and proceed to full review even when the PR has merge conflicts — both waste review effort.

## Migration

No migration required — skill files only, no runtime impact.
