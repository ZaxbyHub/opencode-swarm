# Issue #1248: close remaining follow-up gaps from PR #1194 review

## Fixed

- **Item 16** (per issue #1248 table): `tests/unit/tools/syntax-check.test.ts`'s `saveEvidence` mock no longer leaks across test files: `src/tools/syntax-check.ts` now calls `saveEvidence` through `src/evidence/manager.ts`'s existing `_internals` DI seam, and the test restores it via plain property assignment in `afterEach` instead of an unrestorable `vi.mock()` module registration.
- **Item 3** (per issue #1248 table): The Semgrep subprocess overflow-kill test now verifies the child process is actually terminated (via a new optional `onSpawn` hook on `executeWithTimeout` and a real process-liveness poll), instead of only checking a placeholder exit code that was set independently of whether the kill succeeded.
- **Item 6** (per issue #1248 table): Documented in `AGENTS.md` invariant 7 that `src/lang/backends/php.ts` intentionally omits an `_internals` DI seam (public-API testing is used instead; no external consumer needs the seam).

## What is NOT in this PR

Issue #1248 enumerates 14 follow-up items (1-14 in its table). This PR addresses items 3, 6, and 16. The remaining 11 items (1, 2, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14) are tracked in the issue but not addressed here. See issue #1248 for status of the deferred items.

A PR-body claim about "17 items" / "15 of 17 resolved" was incorrect — the actual item count in the issue is 14.

## Caveats

- Item 3's `waitForProcessDeath` real-assertion path is automatically skipped on Windows (`process.platform === 'win32'` early-return). Windows-specific kill-path coverage is tracked under issue #1248 item 14.
- The Semgrep SIGKILL-escalation test now also asserts real process death via `waitForProcessDeath` (previously only asserted placeholder exit code).
