import { REPO_MEMORY_FILENAME } from '../../tools/repo-graph/indexed-storage';

export const NO_RECEIPT_PHASE_CLOSE_SCOPE_DETAIL =
	'no exact receipt lifecycle scope exists for phase closure';
export const CLOSE_SKILL_REVIEW_TIMEOUT_MS = 120_000;
export const CLOSE_REFLECTION_TIMEOUT_MS = 90_000;
/**
 * Flat-file artifacts to include in the archive bundle.
 * Each entry is a relative path under .swarm/.
 *
 * plan-ledger.jsonl is included so the archive bundle is a self-contained
 * forensic snapshot of the session: the ledger holds the full audit trail of
 * task state transitions and snapshot events that plan.json/plan.md don't
 * preserve.
 */
export const ARCHIVE_ARTIFACTS = [
	'plan.json',
	'plan.md',
	'plan-ledger.jsonl',
	'context.md',
	'events.jsonl',
	'events-authority-index.json',
	'handoff.md',
	'handoff-prompt.md',
	'handoff-consumed.md',
	'escalation-report.md',
	'close-lessons.md',
	'knowledge.jsonl',
	'knowledge-rejected.jsonl',
	// Project-local receipt authority is copied for forensics but deliberately
	// omitted from ACTIVE_STATE_TO_CLEAN: live/within-grace state survives close.
	'knowledge-receipts-v2.jsonl',
	'knowledge-receipts-v2.snapshot.json',
	'knowledge-receipts-v2-archive.jsonl',
	// Per-attempt task outcomes written by update_task_status. Plan-scoped (keyed
	// by task IDs like "1.1"), so it is archived for forensics and then cleaned —
	// carrying it into the next plan would label an unrelated task 1.1 as failed.
	'run-memory.jsonl',
	'repo-graph.json',
	// #2483: the repo-graph fingerprint sidecar rides with its sibling
	// repo-graph.json (archive + clean) so close can no longer orphan it.
	'repo-graph.fingerprint.json',
	'doc-manifest.json',
	'dark-matter.md',
	// telemetry.jsonl (active) AND telemetry.jsonl.1 (rotated) are archived as a
	// set so the bundle is a complete ordered telemetry snapshot. Only one `.1`
	// generation ever exists (rotateTelemetryIfNeeded produces no `.2`), so
	// archiving both is complete and non-overlapping. The active stream is
	// flushed before archiving via flushAndDrainTelemetry (issue #2030 item 8).
	'telemetry.jsonl',
	'telemetry.jsonl.1',
	'swarm.db',
	'epic-state.json',
	'turbo-state.json',
	// swarm.db-shm / swarm.db-wal are intentionally NOT listed: the VACUUM INTO
	// snapshot needs no sidecar content. They are never archived, but since
	// #2483 they ARE removed right after the swarm.db unlink by
	// removeSqliteSidecarsAfterClose (reversing #1692 — see the
	// ACTIVE_STATE_TO_CLEAN docblock below).
	// repo-memory.sqlite (issue #1534): the derived index maintained when
	// repo_graph.storage === 'indexed'. Mirrors swarm.db exactly — snapshotted
	// via archiveSqliteSnapshot (VACUUM INTO), and its -shm/-wal sidecars are
	// likewise deliberately NOT listed here (transient, recreated on next open).
	REPO_MEMORY_FILENAME,
	'close-summary.md',
	'session-reflection.md',
	'spec.md',
	'spec-staleness.json',
	'spec-snapshot.md',
	// Background-delegation durable store (issue #2034): archived as a set
	// (ledger + checkpoint + manifest + health) so the forensic bundle holds
	// the complete recoverable state and terminal audit summaries. Deliberately
	// omitted from ACTIVE_STATE_TO_CLEAN — the store is cross-session state;
	// compaction (not close) is its bounded-retention mechanism.
	'background-delegations.jsonl',
	'background-delegations.checkpoint.json',
	'background-delegations.manifest.json',
	'background-delegations-health.json',
	// Context-map telemetry store (issue #2037): the bounded single-file store
	// (manifest header + retained window) is archived as a defined, validated
	// cut for forensics. The tail is folded/finalized before archiving via
	// finalizeContextTelemetry, parallel to flushAndDrainTelemetry. Deliberately
	// omitted from ACTIVE_STATE_TO_CLEAN — the store is cross-session state and
	// its bounded-retention mechanism is compaction (not close), so active state
	// stays usable after close.
	'context-telemetry.jsonl',
	// workspace-snapshot.digest (issue #2472 W7 / PR #2588 PRR-015): the
	// content-digest skip marker written by captureWorkspaceSnapshotAsync
	// (SNAPSHOT_DIGEST_MARKER_FILENAME, src/background/workspace-snapshot.ts —
	// bare name here because the constant is module-private). Archived then
	// cleaned with the other session-generated markers so a stale digest from
	// the closed session can never influence the next session's
	// shouldSkipSnapshot decision.
	'workspace-snapshot.digest',
];
/**
 * Active-state flat files to clean after archiving so future swarms start clean.
 *
 * plan.json, plan.md, and plan-ledger.jsonl are all removed so the next /swarm
 * session starts with a clean slate. The user's original ask for /swarm close
 * was to "archive plan files so future swarms aren't confused" — leaving a
 * terminal-state plan.json in place violates that invariant because the next
 * session's loadPlan() would pick it up as if it were still active.
 *
 * CRITICAL: the ledger must also be removed. Without this, loadPlan()'s Step 4
 * would see no plan.json but a surviving ledger, call replayFromLedger(), and
 * materialize the CLOSED plan back into plan.json on the next session. The
 * ledger is a second backing store for the same "terminal-state plan" and
 * leaving it behind re-enables the exact bug this cleanup is meant to fix.
 * The archive-first guard below ensures we only delete files we successfully
 * copied to the archive bundle, so the audit trail is preserved in the bundle.
 *
 * knowledge-rejected.jsonl, repo-graph.json, doc-manifest.json,
 * dark-matter.md, telemetry.jsonl, and swarm.db are
 * session-generated artifacts that do not persist meaningfully across sessions —
 * they are recreated on next session init and must be removed to avoid stale-state
 * interference.
 *
 * The SQLite WAL sidecars swarm.db-shm and swarm.db-wal are deliberately NOT in
 * either list (the archive-first guard would preserve them anyway): since #2483
 * they are removed immediately AFTER the swarm.db unlink by
 * removeSqliteSidecarsAfterClose, deliberately reversing #1692. Post-unlink the
 * sidecar paths are meaningless for future opens (no new opener can attach),
 * live processes keep their already-open fds so deleting the PATH cannot
 * corrupt them, and a Windows open-handle collision yields EBUSY which the
 * helper skips fail-open.
 *
 * Note: knowledge.jsonl is intentionally NOT cleaned because it contains cumulative
 * project knowledge (lessons learned) that should persist across sessions and finalize
 * cycles. The archive step still creates a backup for safety.
 * close-summary.md is NOT cleaned because it is written as the final close output
 * AFTER the clean stage runs. spec.md IS cleaned: it is single-session state coupled
 * to the plan lifecycle (the plan it produced is removed above), so leaving it behind
 * makes the next session pick up a stale spec via readEffectiveSpecSync and mis-route
 * the architect into CLARIFY-SPEC/overwrite prompts. It is archived first (archive-first
 * guard), so the forensic copy is preserved in the bundle. The earlier "spec.md may not
 * exist" rationale was wrong — handoff.md is equally optional and is cleaned the same way.
 * session-reflection.md is a single-session snapshot (not cumulative like
 * knowledge.jsonl) so it IS cleaned to maintain the clean-slate invariant.
 * spec-staleness.json and spec-snapshot.md are the same class of single-session
 * spec-drift state as spec.md. spec-staleness.json is an existence-only gate
 * checked unconditionally by enforceSpecDriftGate, which hard-blocks the core
 * write tools (save_plan, update_task_status, phase_complete,
 * lean_turbo_run_phase, lean_turbo_acquire_locks) with SPEC_DRIFT_BLOCK — a
 * survivor would block the NEXT session against drift that no longer applies.
 * spec-snapshot.md is its companion diff source, feeding the mismatch shown in
 * the SPEC_DRIFT_BLOCK message. Both are archived first (archive-first guard),
 * then cleaned so the next session starts drift-free.
 */
export const ACTIVE_STATE_TO_CLEAN = [
	'plan.json',
	'plan.md',
	'plan-ledger.jsonl',
	'events.jsonl',
	'events-authority-index.json',
	'handoff.md',
	'handoff-prompt.md',
	'handoff-consumed.md',
	'escalation-report.md',
	'knowledge-rejected.jsonl',
	// Plan-scoped per-attempt outcomes — see the ARCHIVE_ARTIFACTS note above.
	// Archived first, then cleaned so the next plan starts with no run memory.
	'run-memory.jsonl',
	'repo-graph.json',
	// #2483: archived + cleaned with its sibling repo-graph.json (above).
	'repo-graph.fingerprint.json',
	'doc-manifest.json',
	'dark-matter.md',
	'telemetry.jsonl',
	// telemetry.jsonl.1 is the rotated generation (rotateTelemetryIfNeeded
	// renames telemetry.jsonl → telemetry.jsonl.1). Without it in the clean
	// set, a rotated generation would be orphaned on disk after close. Paired
	// with its ARCHIVE_ARTIFACTS entry so it is archived then cleaned.
	'telemetry.jsonl.1',
	'session-reflection.md',
	'spec.md',
	'spec-staleness.json',
	'spec-snapshot.md',
	'swarm.db',
	// swarm.db-shm / swarm.db-wal intentionally omitted from this list — the
	// archive-first guard never admits them, so they are removed separately
	// right after the swarm.db unlink by removeSqliteSidecarsAfterClose
	// (#2483, reversing #1692). See docblock above.
	// repo-memory.sqlite (issue #1534): same treatment as swarm.db — its
	// -shm/-wal sidecars are intentionally omitted for the same reason.
	REPO_MEMORY_FILENAME,
	// #2483 (R5): close ends epic-mode runtime state — the epic lane and turbo
	// bookkeeping must not leak into the next session.
	'epic-state.json',
	'turbo-state.json',
	// workspace-snapshot.digest (PRR-015): paired with its ARCHIVE_ARTIFACTS
	// entry above so the archive-first guard can remove it — a stale skip
	// marker must not survive into the next session.
	'workspace-snapshot.digest',
];
/**
 * Terminal plan-state files that must be removed at finalize UNCONDITIONALLY — even
 * when archiving them failed — so the next session cannot resurrect the CLOSED plan
 * (loadPlan Step 1 / replayFromLedger have no terminal-status filter). Kept as a
 * shared constant so the archive-failure diagnostics and the unconditional removal
 * below agree on the set; otherwise the "Preserved …" warning would contradict the
 * removal that always follows for these files.
 */
export const TERMINAL_STATE_FILES = [
	'plan.json',
	'plan-ledger.jsonl',
	// spec-staleness.json / spec-snapshot.md are unconditionally removed even when
	// archive fails. They are the existence-only drift-gate input for
	// enforceSpecDriftGate; if archive-failed the file would survive and
	// hard-block save_plan etc. in the next session. Mirror coverage in
	// tests/unit/commands/close-cleanup.test.ts.
	'spec-staleness.json',
	'spec-snapshot.md',
] as const;
/**
 * Knowledge-family artifacts whose backing store redirects to a shared link
 * directory when the worktree is linked (`.swarm/link.json`). A single
 * worktree's `/swarm close` must NOT archive or delete the cohort-shared store —
 * peers may still be active, and the shared store is durable with its own
 * lifecycle (curation/hive-promotion already run on it, link-aware, during
 * close). When the worktree is NOT linked these are handled normally (local).
 *
 * Scope: this set lists exactly the knowledge-family files that close otherwise
 * archives/cleans — i.e. the intersection with `ARCHIVE_ARTIFACTS` /
 * `ACTIVE_STATE_TO_CLEAN`. The other redirected files (retractions, counters,
 * quarantine, unactionable, application, knowledge-events) appear in neither
 * list, so close never touches them and they need no guard here. Note the two
 * stages cover different members: the archive-stage guard fires for both
 * `knowledge.jsonl` and `knowledge-rejected.jsonl` (both in `ARCHIVE_ARTIFACTS`),
 * while the clean-stage guard is only reachable for `knowledge-rejected.jsonl`
 * (`ACTIVE_STATE_TO_CLEAN` has no `knowledge.jsonl`).
 */
export const KNOWLEDGE_FAMILY_ARTIFACTS = new Set([
	'knowledge.jsonl',
	'knowledge-rejected.jsonl',
]);
/**
 * Artifacts whose absence is a genuine state anomaly (vs the normal "optional,
 * session-generated, may simply not exist" case). `plan.json`/`plan-ledger.jsonl`
 * back the authoritative plan state (plan-durability invariant 5); their
 * absence in a plan-based session warrants a warning. All other artifacts —
 * including `swarm.db`, which `getProjectDb` creates lazily only when a
 * DB-backed tool actually runs — are optional: a fresh or plan-free session
 * legitimately has none of them, and an absent optional artifact is reported
 * as `source_disposition: 'absent'`, NOT as a failure (issue #2030 item 7).
 */
export const REQUIRED_ARTIFACTS = new Set(['plan.json', 'plan-ledger.jsonl']);
/**
 * Active-state directories to archive and clean after archiving.
 * These contain session-generated data that must be removed so future
 * swarms start clean. Each entry is a relative path under .swarm/.
 */
export const ACTIVE_STATE_DIRS_TO_CLEAN = [
	'coder-settlements',
	'council',
	'evidence',
	'session',
	'scopes',
	'spec-archive',
	'task-repairs',
	'task-terminals',
	// #2483 (R5): close ends epic-mode runtime state — per-run memory logs and
	// the rebuildable epic diagnostics (calibration/divergence) are archived
	// into the session bundle, then the live copies are reset. Between closes
	// the writer caps and the retention sweep bound them. recovery/ stays out
	// (the sweep owns it).
	'runs',
	'epic',
];
/**
 * STAGE 3: CLEAN
 *
 * Removes active-state files and directories that were successfully archived
 * (archive-first guard), plus stale config-backup/ledger-sibling/SWARM_PLAN/.tmp
 * artifacts. Resets context.md for the next session. All state mutations are
 * written back to ctx so the caller can build the close summary.
 */
export const ACTIVE_STATE_UNLINK_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;
