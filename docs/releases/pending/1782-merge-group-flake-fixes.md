# Merge-group Flake Fixes (Parallel Init I/O + Plan-Loader Retry Hardening)

## What

Two source-level fixes for concrete merge-group CI flakes that were kicking
PRs out of the merge queue:

1. **Parallel init-path I/O** (`src/index.ts`) — the three independent
   bounded reads (`loadPluginConfigWithMetaAsync` ∥ `loadSnapshot` ∥
   `ensureSwarmGitExcluded`) now run via `Promise.all` instead of
   sequentially. Cumulative resolution-path latency drops from `sum()` to
   `max()`. Also bounds `loadPluginConfigWithMetaAsync` in a `withTimeout`
   (the only init-path I/O that was previously unbounded — Invariant 1
   compliance).

2. **Plan-loader retry hardening** (`src/hooks/utils.ts`) — `readSwarmFileAsync`
   now retries on transient Windows FS errors (`EBUSY`, `EPERM`, `EACCES`)
   with exponential backoff (10/20/40/80/160ms across 6 attempts, 310ms
   total worst-case) sized for real Windows Defender scan windows. The
   `ENOENT` branch keeps the pre-#1782 cheap budget (5 × 10ms) to avoid a
   hot-path latency regression on missing-file reads. Retry-set precedent
   is `RENAME_RETRY_CODES` at `src/evidence/documents-retention.ts:67-70`.

New helper: `getSafeDefaultConfigLoadResult()` in `src/config/loader.ts`
returns the safe-default `ConfigLoadResult` used when the config-read
times out (empty config + guardrails enabled — matches the loader's own
default path).

Extended test seam: `overrideIndexInternalsForTest` now exposes the three
parallelized I/O functions for deterministic stall/failure injection.

## Why

Issue #1782 (test-stability sprint) shipped its infrastructure layer in
PR #1784 (helpers, lint, advisory detection, runbook) and PR #1921
(quarantine retire). But the merge-group CI was still failing ~27% of
runs (3 failures in the last 11 runs, 2026-07-19 to 2026-07-21) on two
concrete defects the infrastructure detected but did not fix at the
source:

- **`repro-704` Windows T1 timeout** (4 of 7 recent failures; 455/503/1127ms
  vs 400ms deadline). The three sequential init reads summed to a cumulative
  latency that exceeded the deadline on cold Windows CI runners with
  AV/indexing interference.

- **`tests/unit/hooks/delegation-gate-resolve-task-id.test.ts` Windows flake**
  (1 failure; run 29854486821). Transient AV EBUSY on the just-written
  `.swarm/plan.json` was swallowed by `readSwarmFileAsync`'s ENOENT-only
  retry, returning null and causing `resolveEvidenceTaskId` to fall through
  to the stale session-state fallback.

## How to use

No user action required. The fixes are transparent:
- Init is faster and more deterministic on Windows.
- Plan reads self-heal on transient AV interference instead of failing open.
- If the config read ever exceeds 2s, the session continues with safe-default
  config and an `advisoryWarn` is buffered for `/swarm diagnose` to surface
  (rather than the host silently getting "no agents in TUI/GUI").
- Missing-file reads (the common case on fresh projects without `context.md`
  or `plan.md`) stay on the cheap 5 × 10ms ENOENT budget — the per-message
  system-enhancer path is unaffected.

## Limitations / next steps

- **Defect B is closed at source** (deterministic repro test added in
  `tests/unit/hooks/delegation-gate-resolve-task-id.test.ts`).
- **Defect A's structural fix is shipped**, but the "closed in production"
  claim requires the next ~5 merge-group Windows runs to confirm — tracked
  in `docs/audits/test-stability-audit.md`.
- The systemic test-stability ACs in issue #1782 (5 consecutive green
  re-queues, 2-week soak) cannot be proven in one PR; they require elapsed
  wall-clock + real PRs through the queue. This PR uses `Refs #1782`, not
  `Closes #1782` — same convention as PRs #1784 and #1921.

Refs #1782
