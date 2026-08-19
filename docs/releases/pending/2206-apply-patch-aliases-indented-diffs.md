# swarm_apply_patch: payload aliases in tool schema + indented diff tolerance

## What changed

Two fixes for persistent `WRITE TARGET UNVERIFIABLE` failures (issue #2206, incomplete after PR #2062):

1. **Payload aliases declared in the tool schema.** `swarm_apply_patch`'s args schema now declares `patchText`, `patch_text`, and `patchPayload` as optional aliases of `patch` (`patch` itself became optional). Strict hosts (e.g. OpenCode Desktop) enforce the declared tool schema and strip undeclared argument fields before the plugin runs, so PR #2062's resolver-side alias list never saw a hallucinated `patchText` argument. With the aliases declared, the field survives host validation; `execute` resolves the payload from `patch` first, then the aliases, and still fails cleanly when all are empty.
2. **Uniform-indentation tolerance for patch payloads.** Models frequently emit unified diffs indented inside fenced markdown/YAML/JSON blocks (`  --- a/file`), which every column-0-anchored parser rejected. A new shared normalizer — `normalizePatchIndentation` (`src/utils/patch-dedent.ts`) — strips the minimum common leading whitespace across non-empty lines (and normalizes CRLF) at the entry of each LLM-payload parse site: the write-target resolver's `parsePatchPayload`, the guardrail's `extractPatchTargetPaths`, and `swarm_apply_patch`'s `parseUnifiedDiff`. No anchored regex was widened. For a column-0 patch the normalizer is a byte-identical no-op, so hunk context lines whose file content itself starts with `---` (e.g. markdown horizontal rules) can never gain a match. For uniformly indented patches the minimum is driven by the header/marker lines, so the structural context-marker space survives the strip and context-line content still cannot reach column 0 (pinned by `tests/unit/utils/patch-dedent.test.ts`, including the 1-space-wrapper case).

## Why

Both failure modes produced confusing hard blocks (`No patch payload was provided`, `patch: Native patch is missing *** Begin Patch`) on otherwise-valid patches.

## Migration

No migration required. Git-emitted diff parsers (`src/review/diff-source.ts`, `src/tools/diff.ts`, `src/tools/pre-check-batch.ts`) intentionally remain column-0-strict — they parse `git diff` output, which is never indented.
