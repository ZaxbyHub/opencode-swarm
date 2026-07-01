# Issue #1248: close remaining follow-up gaps from PR #1194 review

## Fixed

- `tests/unit/tools/syntax-check.test.ts`'s `saveEvidence` mock no longer leaks across test files: `src/tools/syntax-check.ts` now calls `saveEvidence` through `src/evidence/manager.ts`'s existing `_internals` DI seam, and the test restores it via plain property assignment in `afterEach` instead of an unrestorable `vi.mock()` module registration.
- The Semgrep subprocess overflow-kill test now verifies the child process is actually terminated (via a new optional `onSpawn` hook on `executeWithTimeout` and a real process-liveness poll), instead of only checking a placeholder exit code that was set independently of whether the kill succeeded.
- Documented in `AGENTS.md` invariant 7 that `src/lang/backends/php.ts` intentionally omits an `_internals` DI seam (public-API testing is used instead; no external consumer needs the seam).

15 of the original 17 follow-up items from the PR #1194 review were already resolved by a prior merge; this closes the remaining 2.
