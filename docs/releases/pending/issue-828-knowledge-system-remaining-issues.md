## fix(knowledge): chmod case-sensitivity, quarantine filter, vitest-to-bun:test migration

Addresses 3 of 6 issues from the knowledge-system deep-dive audit (#828).

### What changed

- **chmod regex case-sensitivity** (`knowledge-validator.ts`): `validateLesson` lowercases input then tested it against a case-sensitive regex. After lowering, `-R` became `-r` and did not match. Added the `i` flag to the chmod pattern. Regression test added for lowercase `chmod -r 777`.
- **vitest to bun:test migration** (`knowledge-validator.test.ts`, `knowledge-store.test.ts`, `knowledge-reader.test.ts`): Replaced all vitest imports and API calls with bun:test equivalents (`vi.fn()` to `mock()`, `vi.mock()` to `mock.module()`, etc.).
- **Quarantine status filter** (`knowledge-reader.ts`): `NORMAL_RETRIEVAL_STATUSES` was an allow-list that silently excluded entries with undefined or future status values. Replaced with a deny-list that only filters out `quarantined` entries. Regression tests added.

### Items deferred

- #3 (sentinel persistence), #5 (circuit breaker escalation), #6 (UUID fallback) — LOW severity, require deeper investigation.

### Migration

No migration required.

### Caveats

Tests use `--isolate` per AGENTS.md Invariant 7 (mock.module cross-test leakage in Bun's shared test-runner process).
