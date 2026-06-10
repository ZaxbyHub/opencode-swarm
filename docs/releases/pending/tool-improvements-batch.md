# Tool Improvements Batch

## What changed

- **New `git_blame` tool** — per-line git blame metadata via `git blame --porcelain`; returns sha (abbreviated), author, date (ISO), summary, and content for each line; supports optional `start`/`end` line range filtering; rejects binary files and validates paths
- **`suggest_patch`** — added `format` parameter (`'json'`|`'unified'`); unified mode outputs valid unified diff with `diff --git` headers, hunks, and context lines for `apply_patch` parser compatibility
- **`test_runner`** — added `bail` parameter (boolean, default false); injects framework-specific bail flags for early exit on first test failure
- **`symbols`** — added `workspace` (boolean) and `name` (string) parameters for multi-file symbol search across the workspace
- **`diff`** — added `summaryOnly` parameter; returns file list with additions/deletions counts without full diff content
- **Tool descriptions** — expanded 7 short tool descriptions in `tool-metadata.ts` for better agent guidance
- **New skills** — `safe-rename` (safe symbol renaming workflow) and `pr-readiness` (pre-merge PR readiness checklist)
- **`BuildTestCommandOpts`** — extended with `bail` field in `src/lang/backend.ts` and `src/lang/default-backend.ts`

## Why

Issue #1107 (tool auto-registration via single manifest) was the catalyst for a broader tool hygiene pass: new tools needed metadata, enhanced tools needed fuller descriptions, and two new skills were needed for common workflows.

## Migration

No migration required. All changes are additive or internal. Existing tool signatures retain full backward compatibility — new parameters are additive and optional.
