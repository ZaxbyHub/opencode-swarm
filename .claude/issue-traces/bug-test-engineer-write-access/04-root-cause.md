# Root Cause

## Summary
The `test_engineer` agent's default write-authority rule in `DEFAULT_AGENT_AUTHORITY_RULES`
(src/hooks/guardrails.ts, ~line 3354) has `allowedPrefix: ['tests/', '.swarm/evidence/']`.
The prefix check uses `normalizedPath.startsWith(prefix)`, where `normalizedPath` is the
write-target path made relative to the project root (the `effectiveDirectory` passed to
`createGuardrailsHooks`). In multi-crate or monorepo layouts, tests live at a sub-path
such as `src-tauri/tests/` — that path does NOT start with `tests/` and is therefore
blocked before reaching the zip-code check.

## Exact Location
- File: `src/hooks/guardrails.ts`
- Symbol: `DEFAULT_AGENT_AUTHORITY_RULES.test_engineer`
- Lines: 3354–3359 (original)

## Broken Contract
The invariant "test_engineer can write to test files" was only honoured for
`tests/<anything>` paths rooted at the project root, not for the broader pattern
"any `tests/` directory anywhere in the project tree."

## Triggering Conditions
Any project where test files reside in a subdirectory named `tests/` or `test/` below
the project root (e.g. Cargo workspaces, Yarn/npm workspaces, Python packages with
`backend/test/`, or any test-inside-src layout like `src/__tests__/` or inline `.test.ts`
co-located files).

## Evidence Chain
1. Issue report: `WRITE BLOCKED: Agent "test_engineer" is not authorised to write
   "/workspace/src-tauri/tests/scoring_adversarial_test.rs". Reason: Path
   src-tauri/tests/scoring_adversarial_test.rs not in allowed list for test_engineer`
2. `checkFileAuthorityWithRules` step 7: `allowedPrefix` check with `startsWith` —
   `src-tauri/tests/...` does not start with `tests/`
3. The `allowedGlobs` field (Step 5) already exists in the `AgentRule` type and is
   evaluated *before* `allowedPrefix`, making it the correct insertion point.
4. Adding `allowedGlobs: ['**/tests/**', '**/test/**', '**/__tests__/**', '**/*.test.*',
   '**/*.spec.*']` makes all 8 new regression tests pass; pre-existing failures unchanged.
