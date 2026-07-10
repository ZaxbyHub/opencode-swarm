# Test-Stability Audit — opencode-swarm

> Deliverable artifact (issue #1782, Phase 0). Lives under `docs/audits/` as a
> version-controlled record of the known flaky-test inventory. The contributor
> runbook is at `docs/testing/test-stability.md`.

## Summary statistics

- **Total known flaky tests (from issue #1782 audit baseline):** 7
- **By root-cause class:**
  - Class 1 (time-sensitive): 2 (#1 skill-scoring-e2e, #3 cross-process-scope) + suspected #5 (skill-scoring-workflow)
  - Class 2 (coverage sensitivity): 3 (#1, #4 swarm-artifact-cache, #6 test-runner Pester)
  - Class 3 (cross-platform runtime): 2 (#2 infra runner starvation, #4 Windows bun exit-code)
  - Class 4 (subprocess/env): 1 (#6 test-runner Pester)
- **By quarantine status:** 4 quarantined (#4, #5, + 4 macOS lean-turbo in macos list), 3 fixed-at-root (#1, #2/#3, #6 Pester case-gated).

## Flake inventory

| # | Test file | Test / area | Root-cause class | First/last seen | Proposed fix | Quarantined? | Status |
|---|-----------|-------------|------------------|-----------------|--------------|--------------|--------|
| 1 | `tests/unit/hooks/skill-scoring-e2e.test.ts` | "scoring results are deterministic" / "idempotency" | 1, 2 | 2026-07-08/09 | Freeze `Date.now()` | No | **FIXED** — migrated to `withFrozenClock` (PR #1784) |
| 2 | merge-group `quality`+`rust-sandbox-runner` jobs | n/a (infra) | 3 | 2026-07-08/10 | n/a (transient infra) | No | Infra — not a test flake; retry handles it |
| 3 | `tests/integration/cross-process-scope.test.ts` | "TTL of zero is treated as already expired" | 1 | 2026-07-08 | `now >= expiresAt` (was `>`) | No | **FIXED** — `src/scope/scope-persistence.ts:295` (PR #1767) |
| 4 | `tests/unit/utils/swarm-artifact-cache.test.ts` | whole file (Windows bun exit-code quirk) | 2, 3 | 2026-07-09 | bun/Windows quirk | **Yes** (`quarantined-tests.txt`) + per-case `skipIf` | Quarantined (double-protected) |
| 5 | `tests/unit/hooks/skill-scoring-workflow.test.ts` | `computeSkillRelevanceScore` workflow boost | 1 (suspected) | 2026-07-09 | Freeze clock | **Yes** (`quarantined-tests.txt`) | **FIXED (PR #1784)** — wrapped in `withFrozenClock`; STAYS quarantined until merge-group confirms green (plan critic H1) |
| 6 | `tests/unit/tools/test-runner.test.ts` | Pester convention-scope case (~L543) | 2, 4 | 2026-07-09 | gate on `hasPwsh` | No (case-gated) | **FIXED** — `test.skipIf(!hasPwsh)` guards the subprocess case |
| 7 | (unknown — the "next to surface") | unknown | unknown | future | TBD | — | Addressed structurally by the flake-detection workflow (PR #1784) |

### macOS-only quarantined (not in the issue's baseline, but related — issue #1729 follow-up)

| Test file | Root cause | Status |
|-----------|-----------|--------|
| `tests/unit/turbo/lean/integration-worktree.test.ts` | macOS lane-provisioning (provisionWorktree mock not called) | Quarantined (`quarantined-tests-macos.txt`) — needs macOS env to diagnose |
| `tests/unit/turbo/lean/retroactive-adversarial.test.ts` | same cluster | Quarantined |
| `tests/unit/turbo/lean/runner.adversarial.test.ts` | same cluster | Quarantined |
| `tests/unit/turbo/lean/runner.test.ts` | same cluster | Quarantined |

## Priority ranking

- **P0 (blocking the queue right now):** none remaining after this PR — the
  systemic fixes (freezeClock + detection + lint) address the recurring class.
- **P1 (next most likely to surface):** #5 (skill-scoring-workflow) if the
  freeze proves incomplete cross-platform; the 4 macOS lean-turbo tests.
- **P2 (latent/rare):** #2 (infra runner starvation — transient, retried).

## Acceptance-criteria status (issue #1782 §10)

This PR (partial delivery of the 6-phase sprint) meets the criteria achievable
without elapsed wall-clock; the rest are explicitly tracked as open:

| AC | Status | Evidence |
|----|--------|----------|
| 1 (audit complete) | **MET** | this document (committed under `docs/audits/`) |
| 2 (bulk quarantine + 5 green re-queues) | **NOT MET** | 5 consecutive green merge-group re-queues require elapsed wall-clock + multiple real PRs through the queue |
| 3 (freezeClock adopted) | **PARTIAL** | helper + lint exist and work (PR #1784); 4 confirmed flaky sites migrated; the lint forces all NEW time-touching tests to use the helper. "Every Class 1 test" (~465 pre-existing files) is not migrated — diff-scoped lint is non-blocking for those by design |
| 4 (coverage isolation) | **PARTIAL** | per-file coverage isolation already exists (`run-coverage-gate.sh`); `withIsolatedState` helper added. Coverage gate remains merge-group-only (extending to PR-branch is a separate change) |
| 5 (cross-platform/subprocess) | **LARGELY PRE-EXISTING** | OS-specific quarantine lists + per-case `skipIf` guards already exist (#1729). Runbook documents the convention |
| 6 (detection gate) | **PARTIAL** | detection workflow runs on failed merge-group runs; produces suggestion artifact + best-effort tracking issue. Auto-quarantine PR (needs PAT + branch-protection bypass) is out of scope |
| 7 (runbook) | **MET** | `docs/testing/test-stability.md` |
| 8 (2-week soak) | **NOT MET** | requires elapsed wall-clock with no new flakes |

**This PR does NOT close #1782.** It delivers the systemic tooling layer
(Phases 0, 2, 5, 6 of the sprint) and the prevention/detection infrastructure.
AC2 and AC8 require ongoing CI observation over weeks; AC3/AC4/AC6 are
partially met and have clear follow-up work. The issue should remain open
until those criteria are satisfied.
