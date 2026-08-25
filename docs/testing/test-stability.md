# Test Stability Runbook

How to write tests that stay green on the merge-group CI matrix
(Windows × 4 + macOS × 4 + coverage + full integration), not just the
PR-branch Ubuntu-only CI.

> Origin: issue #1782 (test-stability sprint). This document is the
> contributor-facing runbook for the four root-cause classes of flaky tests
> and the helpers/conventions that prevent them.

## TL;DR — the four rules

1. **Time-sensitive test?** Freeze the clock with `withFrozenClock` — never
   assert on a value derived from `Date.now()` against a live clock.
2. **Test needs isolated state?** Use `withIsolatedState` — one call covers
   env vars + temp dir + clock.
3. **Platform-specific behavior?** Gate with `test.skipIf(process.platform ...)`
   and explain why in a comment.
4. **Test invokes a real subprocess?** Prefer an `_internals` DI seam over
   running the real binary; if the binary is required, mark it and quarantine
   coverage-sensitive cases.

---

## The four root-cause classes

### Class 1 — Time-sensitive assertions

**Symptom:** test passes standalone but flakes under coverage instrumentation,
because the real clock advances between the call under test and a later
equality assertion (e.g. `computeRecencyScore` in `src/hooks/skill-scoring.ts`
is a continuous function of `Date.now()`).

**Fix:** freeze the clock deterministically.

```typescript
import { withFrozenClock } from '../../helpers/test-clock.js';

test('score is deterministic', () => {
  withFrozenClock(() => {
    const a = computeScore();
    const b = computeScore();
    expect(a).toBe(b); // deterministic — clock is frozen
  }, { fixedNow: 1_700_000_000_000 });
});
```

For `beforeEach`-scoped freezing (when a whole describe block needs a frozen
clock), use `freezeClock()` and restore in `afterEach`:

```typescript
import { freezeClock, type Restore } from '../../helpers/test-clock.js';

describe('plan.md sync', () => {
  let restoreClock: Restore | null = null;
  beforeEach(() => {
    restoreClock = freezeClock({ isoNow: '2026-01-01T00:00:00.000Z' });
  });
  afterEach(() => { restoreClock?.(); restoreClock = null; });
});
```

**Helpers:** `tests/helpers/test-clock.ts` — `freezeClock()`, `withFrozenClock()`,
`withFrozenClockAsync()`. See the file's header for the full API.

**Why `spyOn` and not `FakeTime`:** bun's `bun:test` does not export `FakeTime`
(verified absent on 1.3.13/1.3.14). The repo's only proven time-mock surface is
`spyOn(Date, 'now')` and `spyOn(Date.prototype, 'toISOString')`, which is what
the helper uses internally.

**Enforcement:** `scripts/check-test-clock.sh` (diff-scoped — runs in the
`quality` CI job). Any NEW test file that touches `Date.now()` / `new Date()` /
`spyOn(Date` without referencing `freezeClock` / `withFrozenClock` /
`withIsolatedState` fails the build. Pre-existing files are non-blocking
warnings.

### Class 2 — Coverage-instrumentation sensitivity

**Symptom:** test passes in a plain run but fails under `--coverage`, because
instrumentation changes timing, module-load order, or mock-call counting.

**Fix:**
- Timing-dependent cases → route to Class 1 (`freezeClock`).
- Module-load-order cases → reset module state in `afterEach`, or `await import`
  dynamically. Use `_internals` DI seams (see `src/utils/gitignore-warning.ts`
  and AGENTS.md invariant 7) instead of `mock.module` (which leaks across files
  in Bun's shared test-runner process).
- Shared global state → reset in `afterEach`.
- For full isolation (env + temp dir + clock), use `withIsolatedState`:

```typescript
import { withIsolatedState } from '../../helpers/test-isolation.js';

test('isolated', async () => {
  await withIsolatedState(async (state) => {
    // state.dir = realpath temp dir, state.configDir = isolated HOME/XDG
    // clock frozen if you passed { clock: true }
  }, { clock: { fixedNow: 0 } });
});
```

**Why it works:** the merge-queue coverage gate (`scripts/ci/run-coverage-gate.sh`)
already runs each test file in its own process (`bun test --isolate`), so
file-scoped mocks cannot contaminate later files (issue #1712). The helpers
above handle the per-test state that the process boundary doesn't.

### Class 3 — Cross-platform runtime (Windows/macOS)

**Symptom:** test passes on Ubuntu but fails on the Windows or macOS
merge-group leg (path separators, bun exit-code quirks, filesystem timestamp
semantics, runner environment).

**Fix:** gate the test to the platform it actually tests, with a comment:

```typescript
test.skipIf(process.platform !== 'win32')(
  'Windows ctime behavior',
  () => { /* ... */ },
);
```

If the failure is a genuine bun/platform bug that can't be fixed at the root,
quarantine it (see "Quarantine convention" below) with a clear reason.

### Class 4 — Subprocess / environment dependency

**Symptom:** test invokes a real subprocess (Pester, pytest, cargo, the
test-runner tool itself) and asserts on its output; sensitive to the runtime
environment and coverage instrumentation.

**Fix:**
- Prefer mocking the subprocess at an `_internals` DI seam over running the
  real binary.
- Where a real binary is required (end-to-end tests), gate the case on binary
  availability (`test.skipIf(!hasBinary)`) and quarantine coverage-sensitive
  cases.

---

## Quarantine convention

When a test is genuinely flaky and cannot be fixed at the root immediately,
add it to a quarantine list so the merge-group CI stops blocking on it:

- **Unit/coverage tests:** `scripts/ci/quarantined-tests.txt`
- **macOS-only unit tests:** `scripts/ci/quarantined-tests-macos.txt`
- **Windows-only unit tests:** `scripts/ci/quarantined-tests-windows.txt`
- **Integration tests:** `scripts/ci/quarantined-integration-tests.txt`

Format: one repo-relative test file path per line; blank lines and `#` lines
ignored. **Always add a comment explaining why** (root cause, related issue,
validation tier). CI reads these lists and subtracts them from the discovered
test set (`comm -23`) at `.github/workflows/ci.yml`.

Do NOT un-quarantine without a merge-group validation run confirming the fix.

## Auto-detection (the flake-detection workflow)

When a merge-group CI run fails, `.github/workflows/flake-detection.yml`
(`workflow_run` trigger) downloads every `flake-annotations-*` artifact
ci.yml uploads — the per-shard unit annotations AND the coverage shards'
`flake-annotations-coverage-shard-N` artifacts (all of these jobs run a bounded
retry, two retries / three attempts total, before treating a failure as real) —
concatenates them, and runs `scripts/ci/detect-and-quarantine-flakes.sh`.
The script:

1. Extracts candidate flaky/hard-failed test files from the annotations.
2. Drops candidates that are already quarantined, have an infra-signature
   failure (runner starvation, cancellation), or are in core trees
   (`tests/unit/{scope,agents,hooks}/**` — flagged for human review).
3. Writes survivors to a `flake-suggestions` artifact and best-effort opens a
   tracking issue (best-effort because the Actions token's `issues:write` may
   be restricted by repo settings).

**The detection is advisory — it never fails a run.** A maintainer reviews the
suggestion and, if warranted, appends the line to the appropriate quarantine
file in a follow-up PR. Auto-appending directly to the quarantine file would
require a PAT + branch-protection bypass and is intentionally out of scope.

**A self-healed flake is not always auto-surfaced.** `flake-detection.yml`
only runs when the triggering `ci` run's overall conclusion is `failure`. A
flake that passes on retry makes its job succeed, so if nothing else in that
merge-group run failed, the run goes green and detection never fires — the
retry is logged in that job's own step output but is not auto-surfaced as a
quarantine suggestion. This is a property of the trigger, not of any one job:
it applies to the **unit shards' annotations exactly as much as the coverage
job's**. Detection only ever sees annotations from runs that failed for some
reason; a run that self-heals everywhere is invisible to it.

## Known limitations

- **`process.hrtime.bigint()` / `performance.now()` are NOT frozen by
  `freezeClock`.** The helper spies only `Date.now()` and
  `Date.prototype.toISOString()`. Code that measures elapsed wall-clock via
  `hrtime`/`performance.now()` (e.g. `src/tools/pre-check-batch.ts` duration
  measurements) needs a separate seam. No current test asserts on those
  durations; if you add one, add a dedicated mock at the call site rather than
  relying on `freezeClock`.
- **Merge-group greenness requires real queue runs.** A local
  `SHARD_INDEX=1 SHARD_COUNT=1 bash scripts/ci/run-coverage-gate.sh` followed by
  `COVERAGE_PARTS_DIR=. EXPECTED_SHARDS=1 SHARD_JOB_RESULT=success bash scripts/ci/finalize-coverage-gate.sh`
  approximates the coverage leg but cannot prove Windows/macOS stability —
  only a real merge-group run on the 3-OS matrix can.
- **The test-clock lint is diff-scoped.** It only blocks NEW violations; the
  ~465 pre-existing files that touch the clock without the helper are
  non-blocking warnings. Migrate them opportunistically when you touch a file.

## Reference

- Helpers: `tests/helpers/test-clock.ts`, `tests/helpers/test-isolation.ts`
- Lint: `scripts/check-test-clock.sh`
- Detection: `scripts/ci/detect-and-quarantine-flakes.sh`,
  `.github/workflows/flake-detection.yml`
- Coverage gate (per-file isolation): `scripts/ci/run-coverage-gate.sh`
- Audit table (current flake inventory): `docs/audits/test-stability-audit.md`
- Issue: #1782
