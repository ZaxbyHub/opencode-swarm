# Test-stability audit — issue #1908 resolution

> Version-controlled inventory for the merge-group flake backlog consolidated by
> issue #1908. The systemic detection and soak program remains tracked by #1782;
> the contributor runbook is `docs/testing/test-stability.md`.

## Current status

- Tracked files investigated: **19** (9 ordinary candidates and 10 quarantined files).
- Active global quarantines: **0**.
- Active macOS-only quarantines: **0**.
- Active integration quarantines: **0**.
- Validation rule: an empty quarantine list is not proof by itself. Changes to
  `scripts/` force the pull request's full Ubuntu/macOS/Windows unit matrix, and
  merge-group validation owns the integration/coverage/smoke proof.

## Resolution inventory

| Test or cluster | Resolution | Evidence source |
| --- | --- | --- |
| `pr-monitor-status.test.ts` | Cross-session CLI state fixed | `53b7fb90` |
| `stale-delegation-guard.test.ts` | Exact-boundary clock frozen | `7ab0a109` |
| `update-command.test.ts` | Cross-platform path depth fixed; security fixtures now use unprivileged Windows junctions | `39c97866`, #1908 |
| `knowledge-query.test.ts` | Scope-filter regression fixed | `5480cd62` |
| `path-security.test.ts` | Drive-letter fallback fixed; asymmetric existence is simulated through a restored DI seam instead of writing to a drive root | `36bea060`, #1908 |
| `knowledge-injector-shown-set.test.ts` | Real-host identity and receipt accounting fixed | `554d4972` |
| `check-gate-status.gates.test.ts` | Platform-specific safe-miss categories accepted | `4fbcb7f4`, #1908 |
| `suggest-patch.adversarial.test.ts` | Nonexistent-target containment fixed | `4fbcb7f4` |
| `test-impact.adversarial.test.ts` | Windows separators normalized in every sibling assertion | `4fbcb7f4`, `d47d4e4e` |
| `swarm-artifact-cache.test.ts` | Platform assertion semantics fixed; cleanup now retries transient Windows handle contention | `980e4a72`, #1908 |
| `skill-scoring-workflow.test.ts` | Time-dependent workflow score frozen | `3c3bbadb` |
| `test-runner.test.ts` | Pester test gates on the complete capability, not merely `pwsh` presence | #1908 |
| `test-runner-impact.adversarial.test.ts` | Leaking module mocks replaced with restored dependency seams | #1908 |
| `finalize-reward-sweep-multi-runid.test.ts` | Reward propagation uses the deterministic reward timestamp for recency | `e453e4c5` |
| four Lean Turbo macOS tests | Removed from quarantine and required to execute in exact-head macOS CI | #1908 three-OS matrix |
| `phase-complete-events*.test.ts` | Event-focused fixtures disable unrelated knowledge and curator pipelines | #1908 |
| `unified-injection-budget.test.ts` | Fixture uses valid host messages/identity and a canonical external temp root | #1908 |

## Adjacent current-main recurrence

After the #1908 branch was rebased, the current `main` gates exposed four
shell-script test files that resolved bare `bash` to the Windows WSL relay, two
fixtures that still required privileged symbolic links, and three integration
assertions that assumed POSIX paths, a stale TypeScript label, or an executable
Unix package shim. The shell tests now share a Git-installation-derived Bash
resolver, use bounded non-interactive spawns, and normalize native Git paths
for MSYS coreutils. Link fixtures use unprivileged junctions or hard links on
Windows, and integration fixtures resolve host-specific paths and binaries:

- `trace-init.test.ts`
- `scan-deferred.test.ts`
- `check-test-file-cap.test.ts`
- `check-test-tmpdir-project-relative.test.ts`
- `reset-backup.test.ts`
- `delegation-gate-worktree-isolation.lane-teardown-fr205.supplemental.test.ts`
- `issue-629-skill-improver.test.ts`
- `lang/prompt-injection.test.ts`
- `pre-check-batch.test.ts`
- `subprocess-injection*.test.ts`
- `checkpoint-schema-adversarial.test.ts`

This adjacent recurrence repair does not change the original 19-file backlog
count above; it prevents newly landed tests from reintroducing the same
capability-detection and host-privilege failure classes while #1908 is open.

## Recurrence prevention

- `scripts/check-test-tmpdir.sh` now rejects newly added project-relative test
  temp roots as well as uncanonicalized system-temp paths.
- Privilege-sensitive path regressions use DI seams or Windows junctions; they
  do not require Developer Mode or drive-root write access.
- Optional-runtime tests probe the complete capability they execute.
- Shell-script tests resolve Git Bash from the active Git installation on
  Windows instead of invoking the optional WSL relay by name.
- Message-transform fixtures identify agents through the SDK-supported user
  message/session paths enforced by `resolveMessageTransformContext`.
- Impact-scope tests override restored `_internals` dependencies instead of
  leaking `mock.module` replacements into later files.
- Every test-runner detector and wiring suite now restores those `_internals`
  dependencies after each case; no detector suite retains a module-scoped
  discovery or filesystem mock.
- Focused integration fixtures explicitly disable unrelated background work
  when it is outside the behavior under test.
- Checkpoint configuration rejects forbidden own keys and non-plain prototypes
  before Zod can rebuild and erase the attack shape.
- Shared test-environment isolation redirects `XDG_DATA_HOME` alongside the
  existing config/home variables, so hive locks and data never reach a user's
  real global store even under constrained-memory test runs.

## Relationship to #1782

Issue #1908 retires the concrete tracked backlog. It does **not** close #1782:
that issue owns systemic flake detection, five consecutive green requeues, and
the two-week soak. Those elapsed-time acceptance criteria remain separate from
the code and quarantine debt resolved here.

## Addendum: 2026-07-21 source-level fixes for two residual merge-group flakes

After #1908 landed, the merge-group CI was still failing ~27% of runs (3
failures in 11 runs, 2026-07-19 to 2026-07-21) on two concrete defects the
infrastructure layer detected but did not fix at the source. Both are now
fixed; rows appended to the resolution inventory.

| Test or cluster | Resolution | Evidence source |
| --- | --- | --- |
| `repro-704` Windows T1 timeout (`smoke (windows-latest)` leg; 4 of 7 recent failures; elapsed 455/503/1127ms vs 400ms deadline) | Structural: parallelize the three independent bounded init-path I/O reads (`loadPluginConfigWithMetaAsync` ∥ `loadSnapshot` ∥ `ensureSwarmGitExcluded`) via `Promise.all` in `src/index.ts`. Cumulative latency drops from `sum()` to `max()`. Also bounds the previously-unbounded config read via `withTimeout(2_000)` (Invariant 1 compliance). **Status: structural fix shipped; "closed in production" requires the next ~5 merge-group Windows runs to confirm.** Local `node scripts/repro-704.mjs` T1 = 299ms post-fix (vs 455–1127ms pre-fix in CI). | `src/index.ts` (init parallelization); `src/config/loader.ts:getSafeDefaultConfigLoadResult` (timeout fallback); `tests/unit/index.test.ts` (5b timeout-fallback + 5c parallel-execution tests) |
| `tests/unit/hooks/delegation-gate-resolve-task-id.test.ts` (1 failure; run 29854486821; both retries exhausted) | Source-level: extended `readSwarmFileAsync` retry set in `src/hooks/utils.ts` to include `EBUSY`/`EPERM`/`EACCES` (alongside `ENOENT`), with exponential backoff 10/20/40/80/160ms across 6 attempts (310ms total worst-case). Retry-set precedent: `RENAME_RETRY_CODES` at `src/evidence/documents-retention.ts:67-70`. **Status: closed at source.** Deterministic repro test added at `tests/unit/hooks/delegation-gate-resolve-task-id.test.ts:332`. | `src/hooks/utils.ts:282-330` (retry hardening); `tests/unit/hooks/utils-read-swarm-file.test.ts` (retry-set + latency-bound tests) |

The systemic elapsed-time acceptance criteria (5 consecutive green requeues,
two-week soak) remain tracked by issue #1782 and cannot be proven in one PR.
The fix PR uses `Refs #1782` (not `Closes`) per the same convention as PRs
#1784 and #1921.
