# Phase 1 & 2 safety fixes — transient retry, subprocess hardening, and atomic state writes

Phase 1 (HIGH-severity): bounded transient retry (ETIMEDOUT only, up to 5 retries with exponential backoff) to git/gh subprocess calls, plus post-mortem robustness hardening.

Phase 2 (MEDIUM-severity): idempotent finalize, archive stage safety filters, SQLite-safe db copy, per-file error reporting in session cleanup, rollback ledger-lock warning, and atomic temp+rename for all state/config writes.

## What changed

### Transient retry for git/gh subprocess calls

All git and GitHub CLI subprocess calls now implement bounded transient retry for `ETIMEDOUT` errors:

- **`src/git/branch.ts` (`gitExec`)** — ETIMEDOUT errors retry up to 5 times with 200ms base exponential backoff. ENOENT is **not** retried (indicates "git binary not at this candidate path" — the windowsGitCandidates loop handles that).
- **`src/git/pr.ts` (`ghExec`)** — Now follows canonical safety pattern: `result.error` checked first (not `result.status`), `maxBuffer: 5MB`, `windowsHide: true`, and ETIMEDOUT retry with backoff. Also added `spawnSyncWithTransientRetry` helper for `git status` and `git push` in `commitAndPush`.
- **`src/tools/checkpoint.ts` (local `gitExec`)** — Same transient retry pattern applied to the checkpoint tool's internal git calls.

### checkpoint tool warning improvements

- **`isGitRepo`** now returns `GitRepoProbe { isRepo: boolean; warning?: string }` instead of a bare boolean. Callers receive a warning message when the git probe fails for transient reasons.
- **`saveCheckpointRecord`** surfaces a warning when the recorded SHA is empty (directory is not a git repository or HEAD is unavailable) instead of silently recording an empty SHA.

### Post-mortem unknown-planId fix

**`src/hooks/curator-postmortem.ts`** — When `plan.json` is absent or unreadable, the post-mortem now uses a timestamped `effectivePlanId` (`"unknown-${Date.now()}"`) instead of the static string `"unknown"`. This prevents a stale `post-mortem-unknown.md` from a prior run from permanently blocking regeneration.

---

## Phase 2 changes

### `/swarm finalize` is now idempotent

**`src/commands/close.ts`** — Running finalize when no active state remains (already cleaned up or never created) is a clean no-op. A second finalize call during the same session no longer produces an error — it returns success with a `"nothing to finalize"` indicator.

### Archive stage ENOENT filter + EBUSY/EPERM/ENOSPC warnings

**`src/commands/close.ts`** — The archive stage now silently skips `ENOENT` errors (target already removed or never present). `EBUSY`, `EPERM`, and `ENOSPC` errors are surfaced as warnings rather than hard errors, allowing archive to complete for remaining files.

### SQLite-safe `swarm.db` copy with WAL checkpoint verification

**`src/commands/close.ts`** — When archiving `swarm.db`, the file is now copied using a SQLite-safe approach: before copying, a `PRAGMA wal_checkpoint(TRUNCATE)` command is issued via `sqlite3` to ensure the WAL checkpoint is flushed. The copy is verified by checking `sqlite3 CLI stdout` for the expected output format. This prevents corrupt or WAL-hot databases from being archived.

### Per-file session cleanup with reporting

**`src/commands/reset-session.ts`** — Session cleanup now wraps each file operation in an individual `try/catch` and reports success/failure per file. There is no silent short-circuit on the first error — every file attempted is reported.

### Rollback warns on locked ledger

**`src/commands/rollback.ts`** — If the ledger file is locked (e.g., another process holds it), rollback emits a warning suggesting `/swarm reset-session` as the recovery action instead of failing silently.

### Atomic temp+rename for all state writes

**`src/memory/jsonl-migration.ts` and `src/commands/simulate.ts`** — All state and configuration file writes now use atomic temp+rename: write to a temporary file first, then rename over the target. This prevents partial writes from corrupting state files on crash or concurrent access. `simulate.ts` applies this to plan and ledger outputs; `jsonl-migration.ts` applies it to `.swarm/` ledger and plan files.

## Why

- **ETIMEDOUT on subprocess calls** is a transient host contention error — antivirus interception, cold filesystem latency, or network latency can cause git/gh to time out even when the binary is present and working. Retrying resolves these transient failures without user intervention.
- **ENOENT is not transient** — it means the binary was not found at any candidate path. Retrying ENOENT would waste time on every subsequent attempt.
- **ghExec pattern alignment** — `result.error` must be checked before `result.status` because a spawn failure sets `error` but leaves `status` null. The previous order caused silent failures when gh was not on PATH.
- **checkpoint probe warnings** — Silent boolean returns obscured whether a failure was transient or permanent, making debugging difficult.
- **post-mortem blocking** — Without the timestamp suffix, a failed post-mortem run for an unknown plan would leave a stale report that caused all subsequent runs to skip (idempotent dedup check).

## Migration steps

None. The behavior changes are transparent. Git/gh operations that previously failed on transient timeouts will now succeed after retry.

## Known caveats

- The retry budget (5 attempts) is sized for transient host contention. Persistent failures (binary genuinely unavailable, network down) will still fail after all retries exhaust.
- The exponential backoff (200ms × 2^attempt) adds up to ~6 seconds of total retry delay in the worst case. This is bounded and only occurs on ETIMEDOUT.
- SQLite-safe copy requires `sqlite3` CLI to be available on PATH. If unavailable, the copy falls back to a plain file copy without WAL checkpoint.
- Atomic writes require filesystem rename support. On some network-mounted filesystems, rename may not be atomic; the temp+rename pattern still provides best-effort durability.
- Archive EBUSY/EPERM/ENOSPC warnings indicate files that could not be archived. These do not block finalize, but the warnings should be reviewed if archival completeness is required.

---

## Phase 3 — bare-catch sweep (FR-009)

All bare `catch` blocks in `src/commands/` are now either ENOENT-filtered or documented with a justification comment explaining why the catch is intentionally broad.

### What changed

- **`src/commands/close.ts`** — 6 bare catches converted to ENOENT-filtered pattern. ENOENT is silently skipped; all other errors are surfaced with context.
- **10 files across `src/commands/`** — bare catches documented with inline justification comments explaining the safety rationale for catching broadly (e.g., "must not throw — called from finally block", "idempotent cleanup — errors are advisory").

### Files affected

`src/commands/close.ts`, `src/commands/reset-session.ts`, `src/commands/reset.ts`, `src/commands/rollback.ts`, `src/commands/handoff.ts`, `src/commands/write-retro.ts`, `src/commands/acknowledge-spec-drift.ts`, `src/commands/full-auto.ts`, `src/commands/post-mortem.ts`, `src/commands/_shared/url-security.ts`

### Why

Bare catches that swallow all errors silently can mask real failures and make debugging difficult. FR-009 requires that every catch block either:
1. Filters expected non-errors (ENOENT for missing files) and re-throws the rest, or
2. Documents why catching all errors is the correct behavior

### Migration steps

None. This is a documentation and defensive-coding improvement with no behavior changes.

---

## Phase 4 — advisory follow-ups (FR-006/007/008 coverage)

Phase 4 completes the remaining advisory items from the plan: deduplication of retry helpers, release-fragment corrections, and test quality improvements.

### What changed

- **`src/utils/transient-retry.ts` (NEW)** — Extracted shared `isTransientSpawnError`, `transientBackoff`, and retry constants (`MAX_TRANSIENT_RETRIES`) into a dedicated utility module, eliminating duplication across `src/git/branch.ts`, `src/git/pr.ts`, and `src/tools/checkpoint.ts`. All three now import the shared helpers.
- **Release fragment Phase 3 file list corrected** — Fixed `transient-retry-subprocess-hardening.md` to correctly list 10 files (not 9) across `src/commands/`.
- **2 stale test assertions corrected** — Updated assertions in new coverage tests that referenced incorrect error shapes or stale constants.
- **15 new coverage tests added** — Full coverage for FR-006 (transient retry), FR-007 (atomic writes), and FR-008 (idempotent finalize/archive) scenario coverage.

### Files affected

`src/utils/transient-retry.ts` (new), `src/git/branch.ts`, `src/git/pr.ts`, `src/tools/checkpoint.ts`

### Why

DRY reuse of retry logic prevents subtle divergence where one call-site evolves a fix that is not propagated to others. Centralizing `spawnSyncWithTransientRetry` in a dedicated module makes the retry policy auditable in one place.

### Migration steps

None. This is a refactoring and test quality improvement with no behavior changes.
