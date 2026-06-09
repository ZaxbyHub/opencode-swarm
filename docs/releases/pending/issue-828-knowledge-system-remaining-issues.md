## fix(knowledge): chmod case-sensitivity, quarantine filter, vitest-to-bun:test migration

Addresses 3 of 6 issues from the knowledge-system deep-dive audit (#828), plus review-fix improvements.

### What changed

- **chmod regex case-sensitivity** (`knowledge-validator.ts`): `validateLesson` lowercases input then tested it against a case-sensitive regex. After lowering, `-R` became `-r` and did not match. Added the `i` flag to the chmod pattern. Regression tests for both lowercase `chmod -r 777` and uppercase `chmod -R 777`.
- **vitest to bun:test migration** (`knowledge-validator.test.ts`, `knowledge-store.test.ts`, `knowledge-reader.test.ts`): Replaced all vitest imports and API calls with bun:test equivalents (`vi.fn()` to `mock()`, `vi.mock()` to `mock.module()`, etc.).
- **Quarantine status filter** (`knowledge-reader.ts`): `NORMAL_RETRIEVAL_STATUSES` was an allow-list that silently excluded entries with undefined or future status values. Replaced with a deny-list that only filters out `quarantined` entries. Regression tests added for `undefined`, `null`, `established`, and `promoted` status inclusion.
- **Archived exclusion** (`search-knowledge.ts`): Added explicit archived-status exclusion alongside the quarantined filter, restoring the pre-change behavior where archived entries are hidden from search results. Regression test added.
- **Biome CI fixes** (`semantic-diff-injection.ts`, `diff-summary.ts`): Replaced `as any` casts with `child_process.ExecFileOptionsWithStringEncoding` to resolve pre-existing `noExplicitAny` warnings.
- **CI infrastructure** (`.github/workflows/ci.yml`, `scripts/check-cross-contamination.sh`, `scripts/mock-allowlist.txt`): Isolated `knowledge-reader.test.ts` in the mock.module CI step to prevent cross-test leakage. Added `src/evidence/task-file` and `src/proper-lockfile` to the mock allowlist.

### Items deferred

- #3 (sentinel persistence), #5 (circuit breaker escalation), #6 (UUID fallback) — LOW severity, require deeper investigation.

### Migration

No migration required.

### Caveats

Tests use `--isolate` per AGENTS.md Invariant 7 (mock.module cross-test leakage in Bun's shared test-runner process).
