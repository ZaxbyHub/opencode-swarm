# Pay down knowledge-test quarantine debt and add CI cross-platform lints (issue #1737)

## What changed

- **Phase 1 — quarantine debt:** fixed five genuinely broken knowledge-subsystem
  tests that had been quarantined rather than fixed (`cleanup-drift.test.ts` drift
  comment, `knowledge.adversarial.test.ts` missing `unarchiveEntry` mock,
  `knowledge-injector-drift-adversarial.test.ts` missing `confirmEntriesPhase`/
  `recordLessonsShown` stubs, `knowledge-recall.test.ts` hive-tier path and a stale
  ranking assertion). All five are un-quarantined from
  `scripts/ci/quarantined-tests.txt`.
- **`tests/integration/phase-complete-events.adversarial.test.ts`:** corrected the
  "read-only `.swarm` directory" test to match the actual documented split-fail
  behavior — `events.jsonl` writes soft-fail with a warning, `plan.json` writes
  fail closed (`success: false`) with a specific lock-failure message. The prior
  assertions expected uniform fail-open behavior across both files.
- **`src/hooks/system-enhancer.ts`:** the unified-injection-budget ledger write is
  now guaranteed via a `finally` block, so a mid-flight exception no longer skips
  the budget-ledger write. Added
  `tests/unit/hooks/system-enhancer-budget-ledger-finally.test.ts` as a regression
  test.
- **`tests/helpers/tmpdir.ts` (new):** `canonicalTmpDir()` /
  `canonicalMkdtemp(prefix)` helpers that resolve the macOS `/var` → `/private/var`
  symlink gap, plus `scripts/check-test-tmpdir.sh`, a diff-scoped lint that flags
  raw `tmpdir()` usage introduced in new/changed test-file lines.
- **`scripts/check-bash-portability.sh` (new):** a full-scan lint for bash-4+-only
  constructs (`declare/typeset/local/readonly -A`, `grep -P`/`--perl-regexp`,
  `coproc`, `mapfile`/`readarray`) that are silently unsupported on macOS's system
  bash (3.2). Prevents recurrence of the class of bug fixed in issue #1729.
  `scripts/check-cross-contamination.sh` had one genuine pre-existing PCRE
  violation (`grep -oP`), fixed to a POSIX-ERE equivalent.
- **`.github/workflows/ci.yml`:** added a `detect-paths` job that path-scopes the
  cross-OS (`macos-latest`/`windows-latest`) unit-test matrix to PRs that touch
  platform-sensitive paths (`src/worktree/`, `src/turbo/`, `src/sandbox/`,
  `src/plan/`, `src/parallel/`, `scripts/`, `.github/workflows/`) or to
  `merge_group` runs, cutting matrix cost on unrelated PRs. Added a `unit-passed`
  aggregate job that checks `needs.unit.result` across the full matrix (not yet
  wired into branch protection — see Known caveats). Corrected a stale comment
  claiming the `coverage` check was not yet a required status check.
- **`src/utils/swarm-artifact-cache.ts` / `src/evidence/task-file.ts`:** fixed a
  lost-update bug (issue #1729 class) where `atomicWriteFile`'s stat-based cache
  never invalidated on write. A same-size rewrite landing within one filesystem
  timestamp tick of a prior cached read could produce an identical
  mtime+ctime+size stamp, so a second locked read-modify-write immediately
  following a write (e.g. `bumpKnowledgeConfidenceBatch`'s confidence-delta write
  followed by its confidence-floor-flag transaction) would silently read the
  pre-write content and clobber the just-committed value back to stale data.
  Added `invalidateCachedArtifact()`, called from `atomicWriteFile` after every
  successful write, closing the gap for all ~15 callers of the shared primitive.
  Root-caused via `tests/unit/hooks/knowledge-floor-action.test.ts`'s "clears
  stale confidence_floor_demoted flag on recovery above floor" case, which failed
  deterministically (not flaky) on both this branch and clean `origin/main`.
- **`src/turbo/lean/runner.ts`:** fixed a merge-back failure misclassification —
  `_sequentialWorktreeCleanup` distinguished `'conflict'` from `'partial'` status
  via `mergeResult.conflict === true`, but `attemptMergeBackFromDirty`'s
  `DirtyMergePartial` result (`src/worktree/merge.ts`) never sets a `conflict`
  field for a real conflict; it signals one via non-empty `conflictFiles` only.
  Every dirty-worktree merge conflict reaching this path was reported as
  `'partial'` instead of `'conflict'`. Root-caused via
  `tests/unit/turbo/lean/integration-worktree.test.ts` AC-6, which also failed
  deterministically on clean `origin/main`.

## New tests

- `tests/unit/helpers/tmpdir.test.ts` — 6 cases for the new tmpdir helper.
- `tests/unit/hooks/system-enhancer-budget-ledger-finally.test.ts` — reproduces
  the missing-`finally` ledger-write bug via a marker-gated mock.

## Migration

No migration required.

## Known caveats

- The new `unit-passed` aggregate CI job is not yet added to the branch
  protection ruleset's required checks, so it does not gate merges yet — this is
  intentional, deferred to a follow-up change once this branch lands on `main`
  (adding it now would break the merge queue for every other open PR, since the
  check doesn't exist on `main` yet).
- Several plan items from issue #1737 require live CI signal (a CI-only injection
  budget test failure, remaining quarantined integration tests, and macOS
  `provisionWorktree` root-cause diagnosis) and are intentionally left for
  follow-up work once this PR provides that signal.
