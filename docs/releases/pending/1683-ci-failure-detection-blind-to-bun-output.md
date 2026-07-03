# `fix(ci)`: CI failure detection blind to bun 1.3 output; close-suite and pre-existing test failures fixed

## Summary

- **CI failure detection is now exit-code-primary**, not coupled to a specific bun-version output marker string. Both the `unit` job's per-file loop and the `Integration tests` step now gate on the actual process exit code; the marker-grep is kept as a non-gating informational line only.
- **The `coverage` job no longer silently discards test failures.** Replaced `|| true` (which, combined with `set -e`, could abort the step before the diagnostic ever ran) with `|| test_exit=$?` plus an explicit post-threshold check, so a real test failure fails the job instead of being swallowed.
- **Fixed the close-suite tests** (`close-cleanup.test.ts`, `close-finalizer.test.ts`, `close-terminal-write.test.ts`) that CI's broken detection had been hiding as green on `main`. Root causes: an incomplete mock missing `_internals`/`getGitRepositoryStatus` exports, a stale WAL-sidecar assertion (production preserves `swarm.db-shm`/`-wal` in place, doesn't archive them), an errno-suffix message mismatch, a fixture-reachability bug in a finalize-stage test, and — the recurring root cause across this whole investigation — call sites that route through `close.ts`'s `_internals` DI seam, which a plain `mock.module()` re-registration from a different test file cannot retroactively intercept.
- **Fixed 45 additional genuine pre-existing test failures** across 16 files under `tests/unit/commands/` (`memory`, `pr-subscribe`, `knowledge` + adversarial, `dark-matter` + adversarial, `reset-session` + enoent, `cleanup-drift`, `coupling`, `simulate`, `issue-command`, `deprecation-warning`, `design-docs`, `deep-dive-registration.adversarial`, `create-swarm-command-handler.first-run`) that CI's broken detection had also been hiding. Most were stale assertions left behind by legitimate refactors (command-registry restructuring, message-format changes, deprecation aliasing) or incomplete/stale `mock.module()` factories — but three were genuine production bugs:
  - `src/commands/reset-session.ts` — `validateSwarmPath` was called twice (once inside a try/catch, once unguarded), so a gracefully-reported failure on the first call could re-throw uncaught on the second, crashing the entire best-effort session cleanup — contradicting the function's own documented "continue on failure" contract.
  - `src/commands/coupling.ts` — JSON output embedded a `path.relative(...)` result without POSIX-normalizing Windows backslashes, inconsistent with the convention already used at ~18 other call sites in the codebase.
  - `src/hooks/knowledge-validator.ts` — cosmetic comment-only fix so a drift-prevention meta-test's context-window heuristic correctly recognizes an already-accounted-for `.swarm/` write.

## User-facing changes

None. This is a CI-infrastructure and test-suite fix; no runtime command behavior changes for end users, except that `/swarm memory evaluate` and `/swarm reset-session` are now more robust on Windows (see production bugs above).

## Migration notes

None required.

## Known caveats

- CI's OS-matrix behavior (Windows/macOS/Linux runners) was verified locally but not yet demonstrated on an actual GitHub Actions run — this should be confirmed once this PR's checks run.
- A sibling test outside this PR's scope, `tests/unit/memory/recall-evaluation.test.ts:120`, asserts the identical stale `noisy_injection_count === 0` check that `memory.test.ts` fixed here, and is genuinely red on current `main` for the same reason (introduced by an earlier commit that added new fixtures without updating this assertion). Left out of this PR's scope; worth a small separate follow-up.
- This PR does not fix all pre-existing test debt in the repository. `tests/unit/tools/` and `tests/unit/hooks/` have substantial additional pre-existing failures (confirmed reproducing on clean `origin/main`, unrelated to this PR's file scope) — a natural, larger consequence of this same CI-detection bug that is out of scope here.

## Discovery context

Investigating GitHub issue #1683 ("CI failure detection is blind to bun 1.3 output; close-suite tests are red on main") surfaced that CI's failure-marker grep pattern no longer matched bun 1.3's actual failure-line format, so failing tests were silently reported as passing. Once detection was fixed, a regression sweep found a large body of genuinely pre-existing, silently-red tests across the repo — this PR resolves the close-suite tests named in the issue plus the pre-existing failures within `tests/unit/commands/`, since a merge-blocking requirement was that CI's now-honest failure detection not immediately go red on unrelated pre-existing debt in that directory.
