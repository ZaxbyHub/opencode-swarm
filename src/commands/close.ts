import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadPluginConfigWithMeta } from '../config';
import type { Plan } from '../config/plan-schema';
import {
	type KnowledgeConfig,
	KnowledgeConfigSchema,
	type PluginConfig,
	SkillImproverConfigSchema,
} from '../config/schema';
import { closeProjectDb } from '../db/project-db';
import { archiveEvidence } from '../evidence/manager';
import { isFullAutoRunActive } from '../full-auto/state.js';
import {
	getGitRepositoryStatus,
	resetToMainAfterMerge,
	resetToRemoteBranch,
} from '../git/branch';
import { createCuratorLLMDelegate } from '../hooks/curator-llm-factory';
import { runCuratorPostMortem } from '../hooks/curator-postmortem';
import { extractCurrentPhaseFromPlan } from '../hooks/extractors.js';
import { checkHivePromotions } from '../hooks/hive-promoter';
import { curateAndStoreSwarm } from '../hooks/knowledge-curator';
import { isLinked } from '../hooks/knowledge-link';
import {
	reconcilePhaseClose,
	recordPhaseCloseIntent,
} from '../hooks/knowledge-receipt-ledger.js';

/** Narrow seam for receipt/plan ordering tests. */
export const closeReceiptLifecycleInternals = {
	recordPhaseCloseIntent,
	reconcilePhaseClose,
};

import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types';
import { validateSwarmPath } from '../hooks/utils';
import { runFinalizeRewardSweep } from '../memory/finalize-reward-sweep';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { clearAllScopes } from '../scope/scope-persistence';
import {
	buildActionMenu,
	runSessionReflection,
	type SessionReflectionResult,
	writeSessionReflection,
} from '../services/session-reflection';
import {
	runSkillImprover,
	type SkillImproveRequest,
	type SkillImproveResult,
} from '../services/skill-improver';
import { readEarliestSessionStart } from '../session/session-start-store.js';
import {
	endAgentSession,
	hasActiveFullAuto,
	resetSwarmStatePreservingSingletons,
	swarmState,
} from '../state';
import { telemetry as telemetryEmit } from '../telemetry';
import { executeWriteRetro } from '../tools/write-retro';
import { log } from '../utils/logger';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache';
import {
	type CloseTerminalResult,
	reconcileCloseTerminalState,
} from '../workflow/close-terminal.js';
import { archiveSqliteSnapshot, type SqliteRowCounts } from './archive-sqlite';

interface PlanPhase {
	id: number;
	name: string;
	status: string;
	tasks: Array<{
		id: string;
		status: string;
		close_reason?: string;
	}>;
}

interface PlanData {
	title: string;
	phases: PlanPhase[];
}

const NO_RECEIPT_PHASE_CLOSE_SCOPE_DETAIL =
	'no exact receipt lifecycle scope exists for phase closure';

/**
 * Close-command wrapper around the exact-task terminal reconciliation service.
 *
 * Deliberately NOT named `closePlanTerminalState`: `src/plan/manager.ts` exports a
 * distinct function by that name (ledger-first phase/projection persistence), which
 * `reconcileCloseTerminalState` itself calls downstream. Keeping the two identifiers
 * distinct avoids a same-name collision across close.ts / close-terminal.ts /
 * plan/manager.ts. The `_internals` key below stays `closePlanTerminalState` so the
 * existing test seam is unchanged.
 */
async function reconcileCloseTerminalStateForPlan(
	directory: string,
	targetPlan: Plan,
	options: {
		actor: string;
		requestedClosedTaskIds: string[];
		closedPhaseIds: number[];
		originalStatuses?: Map<string, string>;
	},
): Promise<CloseTerminalResult | undefined> {
	return reconcileCloseTerminalState(directory, targetPlan, options);
}

function hardStopTerminalization(
	ctx: CloseStageContext,
	message: string,
): void {
	ctx.warnings.push(message);
	ctx.terminalizationError = message;
}

interface CloseCommandOptions {
	sessionID?: string;
	skillReviewTimeoutMs?: number;
}

interface CurationCounts {
	stored: number;
	/** Issue #2077: surfaced for the reflection knowledge-delta report. */
	reinforced: number;
	skipped: number;
	rejected: number;
	quarantined: number;
}

interface CloseKnowledgeEntry {
	created_at?: string;
}

// ── Structured archive result (issue #2030) ────────────────────────────────
// One result per archived artifact. This is the single source of truth from
// which the user-facing prose, the clean-stage gate (archivedActiveStateFiles),
// the failure map, AND the `close_archive_result` telemetry event are all
// derived — so none of them can disagree (issue item 6 acceptance: "Archive
// prose and canonical event are derived from the same result object and cannot
// disagree").
export type ArchiveRequiredness = 'required' | 'optional';
export type ArchiveAttempt = 'not_attempted' | 'succeeded' | 'failed';
export type ArchiveValidation = 'not_applicable' | 'passed' | 'failed';
export type ArchiveSourceDisposition = 'absent' | 'retained' | 'removed';

export interface ArtifactArchiveResult {
	artifact: string;
	requiredness: ArchiveRequiredness;
	attempt: ArchiveAttempt;
	validation: ArchiveValidation;
	source_disposition: ArchiveSourceDisposition;
	method: string; // 'copy' | 'vacuum_into' | 'none'
	reason_code: string;
	/** Counts only (no row content), present for validated sqlite snapshots. */
	row_counts?: SqliteRowCounts;
	/** Non-sensitive diagnostic. */
	detail?: string;
}

export interface ArchiveStageContext {
	directory: string;
	swarmDir: string;
	config: PluginConfig;
	warnings: string[];
}

export interface CloseStageContext {
	directory: string;
	swarmDir: string;
	planData: PlanData;
	planExists: boolean;
	planAlreadyDone: boolean;
	config: KnowledgeConfig;
	projectName: string;
	warnings: string[];
	closedPhases: number[];
	closedTasks: string[];
	sessionStart: string | undefined;
	isForced: boolean;
	runSkillReview: boolean;
	options: CloseCommandOptions;
	phases: PlanPhase[];
	inProgressPhases: PlanPhase[];
	curationSucceeded: boolean;
	curationResult: CurationCounts | undefined;
	allLessons: string[];
	explicitLessons: string[];
	retroLessons: string[];
	knowledgeSkillHint: string;
	skillReviewSummary: string;
	postMortemSummary: string;
	sessionReflection: SessionReflectionResult | undefined;
	hivePromoted: number;
	sessionKnowledgeCreated: number;
	fallbackKnowledgeCreated: number;
	/** Issue #2077: FR-015 dedup drop count (retro lessons dropped as already-known). */
	dedupDropped: number;
	/** Issue #2077: false when the dedup knowledge read failed (fail-open). */
	dedupAvailable: boolean;
	/** Issue #2077: total retro lessons before dedup. */
	retroLessonTotal: number;
	/** Issue #2077: full-auto state computed once, reused at reflection + menu render. */
	fullAuto: boolean;
	originalStatuses: Map<string, string>;
	guaranteeResult: { closedPhaseIds: number[]; closedTaskIds: string[] };
	terminalizationError?: string;
	archiveResult: string;
	archivedFileCount: number;
	archivedActiveStateFiles: Set<string>;
	archivedActiveStateDirs: Set<string>;
	archiveFailureReasons: Map<string, string>;
	/** Structured per-artifact results — single source of truth (issue #2030). */
	archiveResults: ArtifactArchiveResult[];
	/** True when the archive STAGE threw wholesale (e.g. mkdir EACCES/ENOSPC). */
	archiveStageFailed: boolean;
	timestamp: string;
	archiveDir: string;
	archiveSuffix: string;
	args: string[];
}

const CLOSE_SKILL_REVIEW_TIMEOUT_MS = 120_000;
const CLOSE_REFLECTION_TIMEOUT_MS = 90_000;

async function runAbortableReflection(
	input: Parameters<typeof runSessionReflection>[0],
	timeoutMs: number,
): Promise<Awaited<ReturnType<typeof runSessionReflection>>> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const reflectionPromise = runSessionReflection({
		...input,
		signal: controller.signal,
	});
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			reject(new Error(`session_reflection exceeded ${timeoutMs}ms budget`));
			controller.abort();
		}, timeoutMs);
	});

	try {
		return await Promise.race([reflectionPromise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function runAbortableSkillReview(
	req: SkillImproveRequest,
	timeoutMs: number,
): Promise<SkillImproveResult> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const skillReviewPromise = runSkillImprover({
		...req,
		signal: controller.signal,
	});
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			reject(new Error(`skill_review exceeded ${timeoutMs}ms budget`));
			controller.abort();
		}, timeoutMs);
	});

	try {
		return await Promise.race([skillReviewPromise, timeoutPromise]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function normalizeLessonText(text: string): string {
	return (text ?? '').trim().toLowerCase();
}

function countSessionKnowledgeEntries(
	entries: CloseKnowledgeEntry[],
	sessionStart: string | undefined,
	fallbackCount: number,
): number {
	if (!sessionStart) return fallbackCount;
	const sessionStartMs = Date.parse(sessionStart);
	if (!Number.isFinite(sessionStartMs)) return fallbackCount;

	return entries.filter((entry) => {
		if (typeof entry.created_at !== 'string') return false;
		const createdAtMs = Date.parse(entry.created_at);
		return Number.isFinite(createdAtMs) && createdAtMs >= sessionStartMs;
	}).length;
}

async function copyDirRecursiveWithFailures(
	src: string,
	dest: string,
): Promise<{ copied: number; failures: string[] }> {
	let count = 0;
	const failures: string[] = [];
	const entries = await fs.readdir(src);
	await fs.mkdir(dest, { recursive: true });
	for (const entry of entries) {
		const srcEntry = path.join(src, entry);
		const destEntry = path.join(dest, entry);
		try {
			const stat = await fs.stat(srcEntry);
			if (stat.isDirectory()) {
				const subResult = await copyDirRecursiveWithFailures(
					srcEntry,
					destEntry,
				);
				count += subResult.copied;
				failures.push(...subResult.failures);
			} else {
				try {
					await fs.copyFile(srcEntry, destEntry);
					count++;
				} catch (err) {
					const errno = (err as NodeJS.ErrnoException)?.code;
					if (errno !== 'ENOENT') {
						failures.push(
							`${srcEntry}: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}
		} catch (err) {
			const errno = (err as NodeJS.ErrnoException)?.code;
			if (errno !== 'ENOENT') {
				failures.push(
					`${srcEntry}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
	return { copied: count, failures };
}

/**
 * Backward-compatible wrapper that returns only the copied count.
 * Direct callers (including tests) that expect a number continue to work.
 * Use copyDirRecursiveWithFailures when per-file failure tracking is needed.
 */
async function copyDirRecursive(src: string, dest: string): Promise<number> {
	const result = await copyDirRecursiveWithFailures(src, dest);
	return result.copied;
}

/**
 * Flat-file artifacts to include in the archive bundle.
 * Each entry is a relative path under .swarm/.
 *
 * plan-ledger.jsonl is included so the archive bundle is a self-contained
 * forensic snapshot of the session: the ledger holds the full audit trail of
 * task state transitions and snapshot events that plan.json/plan.md don't
 * preserve.
 */
const ARCHIVE_ARTIFACTS = [
	'plan.json',
	'plan.md',
	'plan-ledger.jsonl',
	'context.md',
	'events.jsonl',
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
	// swarm.db-shm / swarm.db-wal are intentionally NOT listed: they are
	// transient SQLite sidecars recreated on next open. They are never archived
	// and never cleaned (preserved on disk). See the ACTIVE_STATE_TO_CLEAN
	// docblock below.
	'close-summary.md',
	'session-reflection.md',
	'spec.md',
	'spec-staleness.json',
	'spec-snapshot.md',
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
 * either list: they are transient internals that SQLite recreates on next open,
 * so they are neither archived nor cleaned — they are left in place. (An earlier
 * revision listed them here as "must be removed"; that was never true — the
 * archive stage skipped them, so the clean stage never reached them.)
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
const ACTIVE_STATE_TO_CLEAN = [
	'plan.json',
	'plan.md',
	'plan-ledger.jsonl',
	'events.jsonl',
	'handoff.md',
	'handoff-prompt.md',
	'handoff-consumed.md',
	'escalation-report.md',
	'knowledge-rejected.jsonl',
	// Plan-scoped per-attempt outcomes — see the ARCHIVE_ARTIFACTS note above.
	// Archived first, then cleaned so the next plan starts with no run memory.
	'run-memory.jsonl',
	'repo-graph.json',
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
	// swarm.db-shm / swarm.db-wal intentionally omitted — preserved on disk
	// (transient SQLite sidecars, recreated on next open). See docblock above.
];

/**
 * Terminal plan-state files that must be removed at finalize UNCONDITIONALLY — even
 * when archiving them failed — so the next session cannot resurrect the CLOSED plan
 * (loadPlan Step 1 / replayFromLedger have no terminal-status filter). Kept as a
 * shared constant so the archive-failure diagnostics and the unconditional removal
 * below agree on the set; otherwise the "Preserved …" warning would contradict the
 * removal that always follows for these files.
 */
const TERMINAL_STATE_FILES = [
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
const KNOWLEDGE_FAMILY_ARTIFACTS = new Set([
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
const REQUIRED_ARTIFACTS = new Set(['plan.json', 'plan-ledger.jsonl']);

/**
 * Active-state directories to archive and clean after archiving.
 * These contain session-generated data that must be removed so future
 * swarms start clean. Each entry is a relative path under .swarm/.
 */
const ACTIVE_STATE_DIRS_TO_CLEAN = [
	'coder-settlements',
	'council',
	'evidence',
	'session',
	'scopes',
	'spec-archive',
	'task-repairs',
	'task-terminals',
];

/**
 * Guarantee all phases and tasks in a plan are marked complete/closed.
 * Mutates planData in place. Returns actual IDs of newly closed phases and
 * tasks so the caller can track only genuinely new closures (idempotent).
 */
function guaranteeAllPlansComplete(planData: PlanData): {
	closedPhaseIds: number[];
	closedTaskIds: string[];
} {
	const closedPhaseIds: number[] = [];
	const closedTaskIds: string[] = [];

	for (const phase of planData.phases ?? []) {
		const wasComplete =
			phase.status === 'complete' ||
			phase.status === 'completed' ||
			phase.status === 'closed';
		if (!wasComplete) {
			phase.status = 'closed';
			closedPhaseIds.push(phase.id);
		}

		for (const task of phase.tasks ?? []) {
			const wasTaskDone =
				task.status === 'completed' ||
				task.status === 'complete' ||
				task.status === 'closed';
			if (!wasTaskDone) {
				task.status = 'closed';
				task.close_reason = 'session_terminated';
				closedTaskIds.push(task.id);
			}
		}
	}

	return { closedPhaseIds, closedTaskIds };
}

export interface GitAlignResult {
	gitAlignResult: string;
	prunedBranches: string[];
}

export interface CleanStageResult {
	cleanedFiles: string[];
	configBackupsRemoved: number;
	swarmPlanFilesRemoved: number;
	tmpFilesRemoved: number;
}

/**
 * Emit the single `close_archive_result` telemetry event whose payload is the
 * SAME `ctx.archiveResults` array the user-facing prose derives from, so the
 * two cannot disagree (issue #2030 item 6). Called AFTER `runCleanStage` so
 * `source_disposition` can be finalized truthfully: artifacts that were
 * successfully archived AND then unlinked by the clean stage report `'removed'`;
 * artifacts preserved (absent, or failed/retained) keep their archive-time
 * disposition. Counts only — no row content (issue items 4/9).
 */
export function emitCloseArchiveResult(
	ctx: CloseStageContext,
	cleanResult: CleanStageResult,
): void {
	// Finalize dispositions: any artifact the clean stage actually removed is
	// 'removed' — regardless of whether its archive attempt succeeded or failed
	// (terminal-state files like plan.json are unlinked unconditionally even on
	// archive failure; reporting those as 'retained' would be factually false
	// about on-disk state). The attempt/reason_code fields still carry the
	// archive-outcome truth, so the tuple (failed, removed, copy_failed) reads
	// truthfully as "archive failed, source file removed, no archive copy".
	const cleaned = new Set(cleanResult.cleanedFiles);
	const failedCount = ctx.archiveResults.filter(
		(r) => r.attempt === 'failed',
	).length;
	const sqliteSnapshots = ctx.archiveResults.filter(
		(r) => r.method === 'vacuum_into' && r.attempt === 'succeeded',
	);
	const archiveEmpty =
		sqliteSnapshots.length > 0 &&
		sqliteSnapshots.every(
			(r) =>
				(r.row_counts?.project_constraints ?? 0) === 0 &&
				(r.row_counts?.qa_gate_profile ?? 0) === 0,
		);
	// archive_valid must be false when the stage threw wholesale (empty
	// archiveResults would otherwise make failedCount === 0 and invert the
	// alarm signal PR 16 depends on).
	const archiveValid = !ctx.archiveStageFailed && failedCount === 0;

	try {
		telemetryEmit.closeArchiveResult({
			archive_valid: archiveValid,
			archive_empty: archiveEmpty,
			file_count: ctx.archivedFileCount,
			bundle: `swarm-${ctx.timestamp}-${ctx.archiveSuffix}`,
			artifacts: ctx.archiveResults.map((r) => {
				const removed = cleaned.has(r.artifact);
				return {
					artifact: r.artifact,
					requiredness: r.requiredness,
					attempt: r.attempt,
					validation: r.validation,
					source_disposition: removed
						? ('removed' as ArchiveSourceDisposition)
						: r.source_disposition,
					method: r.method,
					reason_code: r.reason_code,
					...(r.row_counts ? { row_counts: r.row_counts } : {}),
				};
			}),
		});
	} catch (telemetryErr) {
		// Telemetry must never block close; record and continue.
		log(
			'[close-command] close_archive_result telemetry emit failed:',
			telemetryErr,
		);
	}
}

/**
 * STAGE 1: FINALIZE
 *
 * Writes retrospectives for in-progress phases (or a session-level retro for
 * plan-free closes), curates lessons, promotes to hive, runs skill review,
 * persists terminal plan state, and runs post-mortem. All state mutations are
 * written back to ctx so the caller can build the close summary.
 */
export async function runFinalizeStage(ctx: CloseStageContext): Promise<void> {
	// ─── PER-PHASE RETROSPECTIVE WRITES ───────────────────────────────
	if (!ctx.planAlreadyDone) {
		for (const phase of ctx.inProgressPhases) {
			ctx.closedPhases.push(phase.id);

			let retroResult: string | undefined;
			try {
				retroResult = await executeWriteRetro(
					{
						phase: phase.id,
						summary: ctx.isForced
							? `Phase force-closed via /swarm close --force`
							: `Phase closed via /swarm close`,
						task_count: Math.max(1, (phase.tasks ?? []).length),
						task_complexity: 'simple',
						total_tool_calls: 0,
						coder_revisions: 0,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
					},
					ctx.directory,
				);
			} catch (retroError) {
				ctx.warnings.push(
					`Retrospective write threw for phase ${phase.id}: ${retroError instanceof Error ? retroError.message : String(retroError)}`,
				);
			}

			if (retroResult !== undefined) {
				try {
					const parsed = JSON.parse(retroResult);
					if (parsed.success !== true) {
						ctx.warnings.push(
							`Retrospective write failed for phase ${phase.id}`,
						);
					}
				} catch {
					// Non-JSON response is not an error
				}
			}

			for (const task of phase.tasks ?? []) {
				if (task.status !== 'completed' && task.status !== 'complete') {
					ctx.closedTasks.push(task.id);
				}
			}
		}
	}

	// Derive session start time for session-scoping.
	// This prevents taxonomy noise from residual evidence bundles of prior sessions (#444 item 9).
	// Use the earliest lastAgentEventTime from in-memory swarmState — this is reliable because
	// it reflects the current process's session lifecycle and is not affected by .swarm/ directory
	// persistence across /swarm close cycles (the directory is preserved, only files are removed).
	{
		let earliest = Infinity;
		for (const [, session] of swarmState.agentSessions) {
			if (
				session.lastAgentEventTime > 0 &&
				session.lastAgentEventTime < earliest
			) {
				earliest = session.lastAgentEventTime;
			}
		}
		if (earliest < Infinity) {
			ctx.sessionStart = new Date(earliest).toISOString();
		}
	}

	// Cross-process fallback: if ctx.sessionStart is still undefined (no in-memory sessions
	// because /swarm close is running in a different process from the session), read the
	// persisted session-start file.
	if (!ctx.sessionStart) {
		ctx.sessionStart = readEarliestSessionStart(ctx.directory) ?? undefined;
	}

	// Session-level retrospective for plan-free closes. The user's original ask
	// included "run retrospective" — the per-phase loop above skips this case
	// because there are no phases. We write a dedicated retro-session bundle so
	// the archive + knowledge curator still have something to work with.
	const wrotePhaseRetro = ctx.closedPhases.length > 0;
	if (!wrotePhaseRetro && !ctx.planExists) {
		try {
			const sessionRetroResult = await executeWriteRetro(
				{
					phase: 1,
					task_id: 'retro-session',
					summary: ctx.isForced
						? 'Plan-free session force-closed via /swarm close --force'
						: 'Plan-free session closed via /swarm close',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 0,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					metadata: {
						session_scope: 'plan_free',
						...(ctx.sessionStart ? { session_start: ctx.sessionStart } : {}),
					},
				},
				ctx.directory,
			);
			try {
				const parsed = JSON.parse(sessionRetroResult);
				if (parsed.success !== true) {
					ctx.warnings.push(
						`Session retrospective write failed: ${parsed.message ?? 'unknown'}`,
					);
				}
			} catch {
				// Non-JSON response is not an error
			}
		} catch (retroError) {
			ctx.warnings.push(
				`Session retrospective write threw: ${retroError instanceof Error ? retroError.message : String(retroError)}`,
			);
		}
	}

	// Read explicit lessons from .swarm/close-lessons.md if present
	const lessonsFilePath = path.join(ctx.swarmDir, 'close-lessons.md');
	try {
		const lessonsText = await fs.readFile(lessonsFilePath, 'utf-8');
		ctx.explicitLessons = lessonsText
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#'));
	} catch {
		// File absent or unreadable — use empty array
	}

	// Read lessons from retro evidence bundles
	try {
		const evidenceDir = path.join(ctx.swarmDir, 'evidence');
		const evidenceEntries = await fs.readdir(evidenceDir);
		const retroDirs = evidenceEntries
			.filter((e) => e.startsWith('retro-'))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		for (const retroDir of retroDirs) {
			const evidencePath = path.join(evidenceDir, retroDir, 'evidence.json');
			try {
				const content = await fs.readFile(evidencePath, 'utf-8');
				const parsed = JSON.parse(content);
				// Evidence format: { entries: [{ lessons_learned: string[] }] }
				// or flat: { lessons_learned: string[] }
				const entries = parsed.entries ?? [parsed];
				for (const entry of entries) {
					if (Array.isArray(entry.lessons_learned)) {
						for (const lesson of entry.lessons_learned) {
							if (typeof lesson === 'string' && lesson.trim().length > 0) {
								ctx.retroLessons.push(lesson.trim());
							}
						}
					}
				}
			} catch {
				// Per-file failure is non-blocking
			}
		}
	} catch {
		// evidence dir may not exist — non-blocking
	}

	// FR-015: exclude retro lessons already committed in the knowledge store
	let dedupedRetroLessons = ctx.retroLessons;
	ctx.retroLessonTotal = ctx.retroLessons.length;
	ctx.dedupAvailable = true;
	try {
		const existingEntries = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(ctx.directory),
		);
		const existingLessonTexts = new Set(
			existingEntries
				.map((e) => normalizeLessonText(e.lesson))
				.filter((t) => t.length > 0),
		);
		if (existingLessonTexts.size > 0) {
			dedupedRetroLessons = ctx.retroLessons.filter(
				(l) => !existingLessonTexts.has(normalizeLessonText(l)),
			);
		}
	} catch {
		dedupedRetroLessons = ctx.retroLessons; // fail-open
		ctx.dedupAvailable = false; // issue #2077: distinguish "0 deduped" from "dedup did not run"
	}
	// Issue #2077: capture the dedup drop count so the reflection report can
	// surface "N deduped as already-known" instead of dropping it invisibly.
	ctx.dedupDropped = ctx.retroLessons.length - dedupedRetroLessons.length;

	ctx.allLessons = [
		...new Set([...ctx.explicitLessons, ...dedupedRetroLessons]),
	];

	ctx.curationSucceeded = false;
	try {
		// Change 4 (Task 4.2): close-time lessons also pass the Layer-5
		// actionability gate — enrich via the curator LLM when available.
		ctx.curationResult = await _internals.curateAndStoreSwarm(
			ctx.allLessons,
			ctx.projectName,
			{ phase_number: 0 },
			ctx.directory,
			ctx.config,
			{
				llmDelegate: _internals.createCuratorLLMDelegate(
					ctx.directory,
					'phase',
					ctx.options.sessionID,
				),
				enrichmentQuota: {
					maxCalls: ctx.config.enrichment.max_calls_per_day,
					window: ctx.config.enrichment.quota_window,
				},
			},
		);
		ctx.curationSucceeded = true;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.warnings.push(`Lessons curation failed: ${msg}`);
		log('[close-command] curateAndStoreSwarm error:', error);
	}

	if (ctx.curationSucceeded && ctx.allLessons.length > 0) {
		await fs.unlink(lessonsFilePath).catch(() => {});
	}

	// ─── HIVE PROMOTION ──────────────────────────────────────────────
	// Promote swarm lessons to cross-project hive knowledge.
	// Non-blocking: failures are logged as warnings, close still succeeds.
	if (ctx.curationSucceeded) {
		if (ctx.config.hive_enabled === false) {
			// Hive disabled by configuration — skip promotion entirely
		} else {
			try {
				const entries = await readKnowledge<SwarmKnowledgeEntry>(
					resolveSwarmKnowledgePath(ctx.directory),
				);
				const result = await _internals.checkHivePromotions(
					entries,
					ctx.config,
					ctx.directory,
				);
				ctx.hivePromoted = result.new_promotions;
			} catch (hiveErr) {
				const msg =
					hiveErr instanceof Error ? hiveErr.message : String(hiveErr);
				ctx.warnings.push(`Hive promotion failed: ${msg}`);
			}
		}
	}

	ctx.fallbackKnowledgeCreated = ctx.curationResult?.stored ?? 0;
	ctx.sessionKnowledgeCreated = ctx.fallbackKnowledgeCreated;
	try {
		const knowledgePath = resolveSwarmKnowledgePath(ctx.directory);
		const entries = await readKnowledge<CloseKnowledgeEntry>(knowledgePath);
		ctx.sessionKnowledgeCreated = countSessionKnowledgeEntries(
			entries,
			ctx.sessionStart,
			ctx.fallbackKnowledgeCreated,
		);
	} catch (knowledgeErr) {
		const msg =
			knowledgeErr instanceof Error
				? knowledgeErr.message
				: String(knowledgeErr);
		ctx.warnings.push(`Knowledge session count failed: ${msg}`);
	}

	ctx.knowledgeSkillHint =
		ctx.sessionKnowledgeCreated > 0
			? `${ctx.sessionKnowledgeCreated} knowledge entries created this session. Consider running skill_improve or skill_generate to compile mature entries into skills.`
			: '';

	if (ctx.runSkillReview) {
		try {
			const { config: loadedConfig } = _internals.loadPluginConfigWithMeta(
				ctx.directory,
			);
			const skillImproverConfig = SkillImproverConfigSchema.parse(
				loadedConfig.skill_improver ?? {},
			);
			const skillReviewResult = await runAbortableSkillReview(
				{
					directory: ctx.directory,
					config: skillImproverConfig,
					targets: ['skills', 'knowledge'],
					mode: 'proposal',
					sessionId: ctx.options.sessionID,
					enrichmentQuota: {
						maxCalls: ctx.config.enrichment.max_calls_per_day,
						window: ctx.config.enrichment.quota_window,
					},
				},
				ctx.options.skillReviewTimeoutMs ?? CLOSE_SKILL_REVIEW_TIMEOUT_MS,
			);
			if (skillReviewResult.ran) {
				const proposal = skillReviewResult.proposalPath
					? ` Proposal: ${skillReviewResult.proposalPath}.`
					: '';
				const source = skillReviewResult.source
					? ` Source: ${skillReviewResult.source}.`
					: '';
				ctx.skillReviewSummary = `Skill review proposal generated.${proposal}${source}`;
			} else {
				const reason = skillReviewResult.reason ?? 'unknown reason';
				ctx.skillReviewSummary = `Skill review skipped: ${reason}`;
				ctx.warnings.push(ctx.skillReviewSummary);
			}
		} catch (skillReviewErr) {
			const msg =
				skillReviewErr instanceof Error
					? skillReviewErr.message
					: String(skillReviewErr);
			ctx.skillReviewSummary = `Skill review failed: ${msg}`;
			ctx.warnings.push(ctx.skillReviewSummary);
		}
	}

	// ─── SESSION REFLECTION ─────────────────────────────────────────
	// Architect reviews the entire session: tool problems, gate failures, error
	// patterns, skill gaps. Uses the skill_improver LLM delegate when available,
	// deterministic fallback otherwise. The architect report is surfaced directly
	// in the finalize output so the user can act on it immediately.
	try {
		ctx.sessionReflection = await runAbortableReflection(
			{
				directory: ctx.directory,
				toolAggregates: swarmState.toolAggregates,
				agentSessions: swarmState.agentSessions,
				sessionId: ctx.options.sessionID,
				sessionStart: ctx.sessionStart,
				// Issue #2077: thread the configured dedup threshold so a
				// user-tuned threshold (e.g. 0.8) does not cause contradiction-
				// candidate false negatives for pairs in [0.6, 0.8) that can
				// coexist in the active store (the write paths dedup at the
				// configured value, not the 0.6 default).
				dedupThreshold: ctx.config.dedup_threshold,
				// Issue #2077: pass the knowledge delta (close-time curation
				// counts + FR-015 dedup state) into the reflection service.
				// Realtime admission counts are recovered read-only inside the
				// service from durable markers (the in-memory DrainSummary is
				// discarded at index.ts; tracked in #1821).
				knowledgeDelta: {
					sessionKnowledgeCreated: ctx.sessionKnowledgeCreated,
					dedupDropped: ctx.dedupDropped,
					dedupAvailable: ctx.dedupAvailable,
					retroLessonTotal: ctx.retroLessonTotal,
					curation: ctx.curationResult
						? {
								stored: ctx.curationResult.stored,
								reinforced: ctx.curationResult.reinforced ?? 0,
								skipped: ctx.curationResult.skipped ?? 0,
								rejected: ctx.curationResult.rejected ?? 0,
								quarantined: ctx.curationResult.quarantined ?? 0,
							}
						: undefined,
				},
			},
			CLOSE_REFLECTION_TIMEOUT_MS,
		);
		await writeSessionReflection(ctx.directory, ctx.sessionReflection);
	} catch (reflectionErr) {
		const msg =
			reflectionErr instanceof Error
				? reflectionErr.message
				: String(reflectionErr);
		ctx.warnings.push(`Session reflection failed: ${msg}`);
	}

	// ─── ALL-PLANS-COMPLETE GUARANTEE ────────────────────────────────
	if (ctx.planExists) {
		// Capture original task statuses before guaranteeAllPlansComplete mutates them
		ctx.originalStatuses = new Map<string, string>();
		for (const phase of ctx.planData.phases ?? []) {
			for (const task of phase.tasks ?? []) {
				ctx.originalStatuses.set(task.id, task.status);
			}
		}

		// FR-014 snapshot: capture pre-mutation state for SC-013 rollback
		const planDataSnapshot = structuredClone(ctx.planData);
		const closedPhasesLenBefore = ctx.closedPhases.length;
		const closedTasksLenBefore = ctx.closedTasks.length;

		const receiptPhaseLabels = new Map<number, string>();
		const receiptLifecycleSkippedPhaseIds = new Set<number>();
		for (const phase of ctx.planData.phases ?? []) {
			const label =
				extractCurrentPhaseFromPlan({
					...(ctx.planData as Plan),
					current_phase: phase.id,
				}) ?? `Phase ${phase.id}`;
			receiptPhaseLabels.set(phase.id, label);
			const intent =
				await closeReceiptLifecycleInternals.recordPhaseCloseIntent(
					ctx.directory,
					label,
					ctx.options.sessionID,
				);
			if (!intent.ok) {
				// A direct `/swarm close` may not carry a host session ID. When the
				// phase has no receipt membership at all, there is no receipt lifecycle
				// to close and terminal plan persistence must continue. Ambiguous or
				// unreadable receipt state still fails closed below.
				if (intent.detail === NO_RECEIPT_PHASE_CLOSE_SCOPE_DETAIL) {
					receiptLifecycleSkippedPhaseIds.add(phase.id);
					continue;
				}
				hardStopTerminalization(
					ctx,
					`Receipt phase-close intent failed for phase ${phase.id}: ${intent.detail}. Plan terminalization was not attempted.`,
				);
				return;
			}
		}

		ctx.guaranteeResult = guaranteeAllPlansComplete(ctx.planData);
		// Only track newly closed phases/tasks by identity
		for (const phaseId of ctx.guaranteeResult.closedPhaseIds) {
			if (!ctx.closedPhases.includes(phaseId)) {
				ctx.closedPhases.push(phaseId);
			}
		}
		for (const taskId of ctx.guaranteeResult.closedTaskIds) {
			if (!ctx.closedTasks.includes(taskId)) {
				ctx.closedTasks.push(taskId);
			}
		}

		// Reconcile terminal plan state with exact-task evidence even when the
		// caller projection already appears terminal.
		let terminalPlanPersisted = !ctx.planExists;
		if (ctx.planExists) {
			try {
				const reconciled = await _internals.closePlanTerminalState(
					ctx.directory,
					ctx.planData as Plan,
					{
						actor: ctx.options.sessionID ?? 'close-command',
						closedPhaseIds: ctx.guaranteeResult.closedPhaseIds,
						requestedClosedTaskIds: ctx.guaranteeResult.closedTaskIds,
						originalStatuses: ctx.originalStatuses,
					},
				);
				if (reconciled) {
					ctx.planData = reconciled.plan as PlanData;
					ctx.guaranteeResult = {
						closedPhaseIds: [...reconciled.closedPhaseIds],
						closedTaskIds: [...reconciled.closedTaskIds],
					};
					ctx.closedPhases = [...reconciled.closedPhaseIds];
					ctx.closedTasks = [...reconciled.closedTaskIds];
					// Surface QA-exempt forced completions. These tasks were recorded
					// complete without passing the normal Stage B gates, so the close
					// summary must not present them as reviewed-and-tested work.
					if (reconciled.forcedCompletionTaskIds.length > 0) {
						ctx.warnings.push(
							`Completed without QA evidence (forced completion): ${reconciled.forcedCompletionTaskIds.join(', ')}. These tasks had no authoritative workflow evidence and did not pass reviewer/test gates.`,
						);
					}
				}
				terminalPlanPersisted = true;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				ctx.warnings.push(`Failed to persist terminal plan state: ${msg}`);
				ctx.terminalizationError = msg;
				log('[close-command] Failed to write terminal plan state:', error);
				ctx.planData = planDataSnapshot;
				ctx.closedPhases.length = closedPhasesLenBefore;
				ctx.closedTasks.length = closedTasksLenBefore;
				return;
			}
		}

		for (const phase of terminalPlanPersisted
			? (ctx.planData.phases ?? [])
			: []) {
			if (receiptLifecycleSkippedPhaseIds.has(phase.id)) {
				continue;
			}
			const reconciled =
				await closeReceiptLifecycleInternals.reconcilePhaseClose(
					ctx.directory,
					receiptPhaseLabels.get(phase.id) ?? `Phase ${phase.id}`,
					true,
					ctx.options.sessionID,
				);
			if (!reconciled.ok) {
				hardStopTerminalization(
					ctx,
					`Receipt phase-close reconciliation failed for phase ${phase.id}: ${reconciled.detail}`,
				);
				return;
			}
		}
	}

	// ─── POST-MORTEM (WP7, #1234) ──────────────────────────────────
	// Run the post-mortem agent as part of finalize. Idempotent: if
	// phase_complete already produced a report, this is a no-op.
	try {
		const { CuratorConfigSchema: CCS } = await import('../config/schema.js');
		const { config: pmLoadedConfig } = _internals.loadPluginConfigWithMeta(
			ctx.directory,
		);
		const curatorCfg = CCS.parse(pmLoadedConfig.curator ?? {});
		if (curatorCfg.enabled && curatorCfg.postmortem_enabled) {
			const pmResult = await _internals.runCuratorPostMortem(ctx.directory, {
				llmDelegate: _internals.createCuratorLLMDelegate(
					ctx.directory,
					'postmortem',
					ctx.options.sessionID,
				),
				scope: 'project',
				sessionID: ctx.options.sessionID,
			});
			if (pmResult.success && pmResult.summary) {
				ctx.postMortemSummary = pmResult.summary;
			}
			for (const w of pmResult.warnings) {
				ctx.warnings.push(`[POST-MORTEM] ${w}`);
			}
		}
	} catch (err) {
		// fail-open: post-mortem never blocks finalize — but surface the error for diagnostics
		const msg = err instanceof Error ? err.message : String(err);
		ctx.warnings.push(`Post-mortem failed: ${msg}`);
	}
}

/**
 * STAGE 2: ARCHIVE
 *
 * Creates a timestamped archive bundle under .swarm/archive/, copies flat-file
 * artifacts and active-state directories, then runs the evidence retention
 * policy. All state mutations (archive path, counts, success sets) are written
 * back to ctx so the caller can build the close summary.
 */
export async function runArchiveStage(ctx: CloseStageContext): Promise<void> {
	ctx.timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	ctx.archiveSuffix = Math.random().toString(36).slice(2, 8);
	ctx.archiveDir = path.join(
		ctx.swarmDir,
		'archive',
		`swarm-${ctx.timestamp}-${ctx.archiveSuffix}`,
	);

	try {
		await fs.mkdir(ctx.archiveDir, { recursive: true });

		// Flush the telemetry write stream BEFORE archiving its files. The
		// writer holds an open buffered WriteStream whose in-memory buffer is
		// not on disk until drained; without this, archiving telemetry.jsonl
		// via fs.copyFile would silently lose the session's tail records
		// (issue #2030 item 8). Fail-open: a flush failure never blocks close.
		try {
			await _internals.flushAndDrainTelemetry();
		} catch (flushErr) {
			const msg =
				flushErr instanceof Error ? flushErr.message : String(flushErr);
			ctx.warnings.push(`Telemetry flush before archive failed: ${msg}`);
		}

		// Copy swarm artifacts to archive.
		// Each artifact produces a structured ArtifactArchiveResult pushed into
		// ctx.archiveResults — the single source of truth from which the
		// user-facing prose, the clean-stage gate (archivedActiveStateFiles),
		// the failure map, and the close_archive_result telemetry event are all
		// derived (so none can disagree — issue #2030 item 6).
		//
		// WAL sidecar files (swarm.db-shm/-wal) are transient SQLite internals
		// that SQLite recreates on next open; they are deliberately absent from
		// ARCHIVE_ARTIFACTS/ACTIVE_STATE_TO_CLEAN, so they are neither archived
		// nor cleaned (left in place). swarm.db itself is snapshotted via the
		// in-process VACUUM INTO engine (archiveSqliteSnapshot), which produces
		// a single self-contained, transactionally-consistent file.

		// When linked, the knowledge family lives in the shared link store, which
		// is cohort-owned. Do not archive or clean it from a single worktree's
		// close — surface one note and leave the shared lifecycle untouched.
		const linkedKnowledgeShared = isLinked(ctx.directory);
		if (linkedKnowledgeShared) {
			ctx.warnings.push(
				'Worktree is linked: shared knowledge (knowledge.jsonl, knowledge-rejected.jsonl) lives in the link store and is not archived or cleaned by /swarm close. Manage it via the link.',
			);
		}

		for (const artifact of ARCHIVE_ARTIFACTS) {
			// Skip cohort-shared knowledge artifacts when linked (see note above).
			if (linkedKnowledgeShared && KNOWLEDGE_FAMILY_ARTIFACTS.has(artifact)) {
				continue;
			}

			const srcPath = path.join(ctx.swarmDir, artifact);
			const destPath = path.join(ctx.archiveDir, artifact);
			const requiredness: ArchiveRequiredness = REQUIRED_ARTIFACTS.has(artifact)
				? 'required'
				: 'optional';

			if (artifact === 'swarm.db') {
				// In-process VACUUM INTO snapshot via the shared, runtime-portable
				// loader (src/db/sqlite-loader.ts). Produces a single self-contained
				// file (journal_mode=delete, no WAL sidecars) containing ALL committed
				// rows and EXCLUDING uncommitted writers (spike-proven under Bun + Node).
				// Sidecar files (-shm/-wal) are transient and intentionally neither
				// archived nor cleaned — left in place, no warning.
				const r = await archiveSqliteSnapshot({
					sourcePath: srcPath,
					destDir: ctx.archiveDir,
					destName: artifact,
				});
				const result: ArtifactArchiveResult = {
					artifact,
					requiredness,
					attempt: r.attempt,
					validation: r.validation,
					source_disposition:
						r.attempt === 'succeeded' ? 'retained' : r.source_disposition,
					method: r.method,
					reason_code: r.reason_code,
					detail: r.detail,
					row_counts: r.rowCounts,
				};
				ctx.archiveResults.push(result);
				if (r.attempt === 'succeeded' && r.validation === 'passed') {
					ctx.archivedFileCount++;
					if (ACTIVE_STATE_TO_CLEAN.includes(artifact)) {
						ctx.archivedActiveStateFiles.add(artifact);
					}
				} else if (
					!(r.attempt === 'not_attempted' && r.source_disposition === 'absent')
				) {
					// Real failure (not a clean absence). Truthful warning; source
					// is preserved (archiveSqliteSnapshot never deletes the source).
					ctx.archiveFailureReasons.set(
						artifact,
						`${r.reason_code}: ${r.detail ?? ''}`,
					);
					ctx.warnings.push(
						`Failed to archive ${artifact} [${r.reason_code}]: ${r.detail ?? ''}. Source preserved.`,
					);
				}
				// absent optional → silent (no warning, no failure map entry)
			} else {
				try {
					await fs.copyFile(srcPath, destPath);
					ctx.archivedFileCount++;
					if (ACTIVE_STATE_TO_CLEAN.includes(artifact)) {
						ctx.archivedActiveStateFiles.add(artifact);
					}
					ctx.archiveResults.push({
						artifact,
						requiredness,
						attempt: 'succeeded',
						validation: 'not_applicable',
						// 'retained' at archive time; finalized to 'removed'
						// post-clean for artifacts actually unlinked (see
						// emitCloseArchiveResult in handleCloseCommand).
						source_disposition: 'retained',
						method: 'copy',
						reason_code: 'ok',
					});
				} catch (err: unknown) {
					const errno = (err as NodeJS.ErrnoException)?.code;
					if (errno === 'ENOENT') {
						// File absent — expected for optional artifacts; silent skip,
						// recorded as absent so the structured result is truthful.
						ctx.archiveResults.push({
							artifact,
							requiredness,
							attempt: 'not_attempted',
							validation: 'not_applicable',
							source_disposition: 'absent',
							method: 'none',
							reason_code: 'source_absent',
						});
					} else {
						const reason = err instanceof Error ? err.message : String(err);
						ctx.archiveFailureReasons.set(
							artifact,
							`${errno ?? 'unknown'}: ${reason}`,
						);
						ctx.warnings.push(
							`Failed to archive ${artifact} [${errno ?? 'unknown'}]: ${reason}. File preserved (not cleaned up).`,
						);
						ctx.archiveResults.push({
							artifact,
							requiredness,
							attempt: 'failed',
							validation: 'not_applicable',
							source_disposition: 'retained',
							method: 'copy',
							reason_code: 'copy_failed',
							detail: `${errno ?? 'unknown'}: ${reason}`,
						});
					}
				}
			}
		}

		const dynamicArchiveArtifacts = (
			await fs.readdir(ctx.swarmDir).catch(() => [] as string[])
		).filter(
			(name) =>
				/^post-mortem-[^/\\]+\.md$/.test(name) ||
				/^drift-report-phase-\d+\.json$/.test(name),
		);
		for (const artifact of dynamicArchiveArtifacts) {
			const srcPath = path.join(ctx.swarmDir, artifact);
			const destPath = path.join(ctx.archiveDir, artifact);
			try {
				await fs.copyFile(srcPath, destPath);
				ctx.archivedFileCount++;
				ctx.archivedActiveStateFiles.add(artifact);
				// Record in the structured result so the close_archive_result
				// event's artifacts[] array is complete (issue #2030: prose and
				// event must derive from the same result object).
				ctx.archiveResults.push({
					artifact,
					requiredness: 'optional',
					attempt: 'succeeded',
					validation: 'not_applicable',
					source_disposition: 'retained',
					method: 'copy',
					reason_code: 'ok',
				});
			} catch (err: unknown) {
				const errno = (err as NodeJS.ErrnoException)?.code;
				if (errno !== 'ENOENT') {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.archiveFailureReasons.set(
						artifact,
						`${errno ?? 'unknown'}: ${reason}`,
					);
					ctx.warnings.push(
						`Failed to archive ${artifact} [${errno ?? 'unknown'}]: ${reason}. File preserved (not cleaned up).`,
					);
					ctx.archiveResults.push({
						artifact,
						requiredness: 'optional',
						attempt: 'failed',
						validation: 'not_applicable',
						source_disposition: 'retained',
						method: 'copy',
						reason_code: 'copy_failed',
						detail: `${errno ?? 'unknown'}: ${reason}`,
					});
				} else {
					ctx.archiveResults.push({
						artifact,
						requiredness: 'optional',
						attempt: 'not_attempted',
						validation: 'not_applicable',
						source_disposition: 'absent',
						method: 'none',
						reason_code: 'source_absent',
					});
				}
			}
		}

		// Archive directories (evidence/, session/, scopes/, spec-archive/).
		// locks/ is intentionally excluded — per-run locks are managed via
		// proper-lockfile, not archived or cleaned by close.
		for (const dirName of ACTIVE_STATE_DIRS_TO_CLEAN) {
			const srcDir = path.join(ctx.swarmDir, dirName);
			const destDir = path.join(ctx.archiveDir, dirName);
			try {
				const result = await copyDirRecursiveWithFailures(srcDir, destDir);
				ctx.archivedFileCount += result.copied;
				if (result.failures.length === 0) {
					// All files copied (or skipped via ENOENT) — safe to clean source.
					ctx.archivedActiveStateDirs.add(dirName);
				} else {
					// Non-ENOENT failures occurred — preserve source to prevent data loss.
					ctx.warnings.push(
						`Directory ${dirName} not fully archived (${result.failures.length} failure(s)). Source preserved.`,
					);
					for (const failure of result.failures) {
						ctx.warnings.push(`  - ${failure}`);
					}
				}
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'ENOENT') {
					ctx.warnings.push(
						`Failed to archive directory ${dirName} [${code ?? 'unknown'}]: ${(err as Error).message}. Source preserved.`,
					);
				}
				// ENOENT = directory doesn't exist = silent skip
			}
		}

		// Derive the user-facing prose AND the telemetry event from the SAME
		// ctx.archiveResults array so they cannot disagree (issue #2030 item 6).
		// (archive_valid / archive_empty are computed in emitCloseArchiveResult,
		// which runs after the clean stage so source_disposition is truthful.)
		const succeededCount = ctx.archiveResults.filter(
			(r) => r.attempt === 'succeeded',
		).length;
		const failedCount = ctx.archiveResults.filter(
			(r) => r.attempt === 'failed',
		).length;
		const absentCount = ctx.archiveResults.filter(
			(r) => r.source_disposition === 'absent',
		).length;
		const bundleName = `swarm-${ctx.timestamp}-${ctx.archiveSuffix}`;
		ctx.archiveResult =
			failedCount > 0
				? `Archive partial: ${succeededCount} succeeded, ${failedCount} failed, ${absentCount} absent (see warnings). Bundle: .swarm/archive/${bundleName}/`
				: `Archived ${ctx.archivedFileCount} artifact(s) to .swarm/archive/${bundleName}/`;
	} catch (archiveError) {
		ctx.warnings.push(
			`Archive creation failed: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`,
		);
		ctx.archiveResult = 'Archive creation failed (see warnings)';
		// Mark the stage failed so the close_archive_result event does NOT
		// report archive_valid=true on an empty archiveResults array (which
		// would otherwise make failedCount === 0 and invert the alarm signal).
		ctx.archiveStageFailed = true;
	}

	// Archive evidence bundles (retention policy)
	// FR-016: read retention from config.evidence when available.
	await runArchiveEvidenceRetention({
		directory: ctx.directory,
		swarmDir: ctx.swarmDir,
		config: ctx.config as unknown as PluginConfig,
		warnings: ctx.warnings,
	});
}

/**
 * Runs the evidence-retention sub-logic of STAGE 2 (ARCHIVE).
 * Reads max_age_days / max_bundles / cache_max_bytes / cache_max_records from
 * config.evidence (FR-016, issue #1184) and calls archiveEvidence. The report
 * overload is used so the documents-cache prune runs when cache caps are set.
 * Fail-open: pushes a warning on error but never throws.
 */
export async function runArchiveEvidenceRetention(
	ctx: ArchiveStageContext,
): Promise<void> {
	let maxAgeDays = 30;
	let maxBundles = 10;
	let cacheMaxBytes: number | undefined;
	let cacheMaxRecords: number | undefined;
	try {
		const { config: evidenceLoadedConfig } =
			_internals.loadPluginConfigWithMeta(ctx.directory);
		const evidenceCfg = (evidenceLoadedConfig.evidence ?? {}) as Record<
			string,
			unknown
		>;
		if (typeof evidenceCfg.max_age_days === 'number') {
			maxAgeDays = evidenceCfg.max_age_days;
		}
		if (typeof evidenceCfg.max_bundles === 'number') {
			maxBundles = evidenceCfg.max_bundles;
		}
		// Issue #1184: documents-cache retention caps. Only forwarded when set
		// so the cache remains append-only by default.
		if (typeof evidenceCfg.cache_max_bytes === 'number') {
			cacheMaxBytes = evidenceCfg.cache_max_bytes;
		}
		if (typeof evidenceCfg.cache_max_records === 'number') {
			cacheMaxRecords = evidenceCfg.cache_max_records;
		}
	} catch {
		// Fallback to defaults on config read failure
	}

	try {
		// Use the report overload so the documents-cache sweep (issue #1184)
		// runs when cache caps are configured. The report itself is not surfaced
		// to the finalize summary; only warnings on failure.
		await _internals.archiveEvidence(ctx.directory, maxAgeDays, maxBundles, {
			report: true,
			cacheMaxBytes,
			cacheMaxRecords,
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.warnings.push(`Evidence retention archive failed: ${msg}`);
		log('[close-command] archiveEvidence error:', error);
	}
}

/**
 * STAGE 3: CLEAN
 *
 * Removes active-state files and directories that were successfully archived
 * (archive-first guard), plus stale config-backup/ledger-sibling/SWARM_PLAN/.tmp
 * artifacts. Resets context.md for the next session. All state mutations are
 * written back to ctx so the caller can build the close summary.
 */
export async function runCleanStage(
	ctx: CloseStageContext,
): Promise<CleanStageResult> {
	let configBackupsRemoved = 0;
	const cleanedFiles: string[] = [];

	// Only delete active-state files that were successfully copied to the archive.
	// This prevents data loss when a partial archive succeeds for some files but
	// fails for others — only the backed-up files are safe to remove.
	const linkedKnowledgeShared = isLinked(ctx.directory);
	if (linkedKnowledgeShared) {
		// Defensive check: if the archive stage unexpectedly backed up a shared
		// knowledge-family artifact (indicates a bug in runArchiveStage), warn so
		// operators can diagnose. The artifact is still NOT deleted (guard below).
		for (const artifact of KNOWLEDGE_FAMILY_ARTIFACTS) {
			if (ctx.archivedActiveStateFiles.has(artifact)) {
				ctx.warnings.push(
					`[link-guard] Shared knowledge artifact "${artifact}" appears in ` +
						'the archive set while this worktree is linked — archive stage ' +
						'should have skipped it. Artifact will NOT be deleted.',
				);
			}
		}
	}
	if (ctx.archivedActiveStateFiles.size > 0) {
		for (const artifact of ACTIVE_STATE_TO_CLEAN) {
			// Never delete cohort-shared knowledge state from a single worktree's
			// close (it was deliberately not archived above; peers may be active).
			if (linkedKnowledgeShared && KNOWLEDGE_FAMILY_ARTIFACTS.has(artifact)) {
				continue;
			}
			if (!ctx.archivedActiveStateFiles.has(artifact)) {
				const reason = ctx.archiveFailureReasons?.get(artifact);
				if ((TERMINAL_STATE_FILES as readonly string[]).includes(artifact)) {
					// Terminal plan-state is removed unconditionally below (resurrection
					// prevention), so it is NOT preserved here even though archiving failed.
					// Warn accurately that the forensic copy is missing but the file is still
					// removed — do not claim it was "preserved" (the removal contradicts that).
					ctx.warnings.push(
						reason
							? `${artifact} was not archived (${reason}); removing it anyway to prevent CLOSED-plan resurrection next session — no archive copy retained.`
							: `${artifact} was not archived; removing it anyway to prevent CLOSED-plan resurrection next session — no archive copy retained.`,
					);
					continue;
				}
				// This file was NOT successfully archived — do not delete it.
				// Only warn when a genuine archive failure was recorded (e.g. EBUSY,
				// EPERM, ENOSPC) so operators can diagnose without digging into logs.
				// Absent optional files (ENOENT during the archive stage) have no
				// recorded reason — they were simply never present, so we skip
				// silently rather than spuriously warning about a "preserved" file
				// that never existed.
				if (reason) {
					ctx.warnings.push(
						`Preserved ${artifact} because it was not successfully archived: ${reason}.`,
					);
				}
				continue;
			}
			const filePath = path.join(ctx.swarmDir, artifact);
			// For swarm.db, close the cached project-db connection for this
			// directory BEFORE unlinking. On Windows a long-lived WAL-mode
			// connection holds a file lock that makes fs.unlink fail with EBUSY
			// (swarm-pr-review F-005). closeProjectDb also checkpoints the
			// cached connection on close, but the archive stage already took a
			// transactionally consistent VACUUM INTO snapshot, so any checkpoint
			// here is redundant for the archive. The close is best-effort and
			// never throws into the clean stage.
			if (artifact === 'swarm.db') {
				try {
					closeProjectDb(ctx.directory);
				} catch {
					// best-effort — the unlink below will surface any real failure
				}
			}
			try {
				await fs.unlink(filePath);
				cleanedFiles.push(artifact);
			} catch (err) {
				const errno = (err as NodeJS.ErrnoException)?.code;
				if (errno === 'ENOENT') {
					// File already absent — expected after archive-first cleanup; silent skip.
				} else {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.warnings.push(
						`Failed to clean active-state file ${artifact} [${errno ?? 'unknown'}]: ${reason}`,
					);
				}
			}
		}
	} else {
		ctx.warnings.push(
			'Skipped active-state cleanup because no active-state files were archived. Files preserved to prevent data loss.',
		);
	}

	for (const artifact of ctx.archivedActiveStateFiles) {
		if (
			!/^post-mortem-[^/\\]+\.md$/.test(artifact) &&
			!/^drift-report-phase-\d+\.json$/.test(artifact)
		) {
			continue;
		}
		try {
			await fs.unlink(path.join(ctx.swarmDir, artifact));
			cleanedFiles.push(artifact);
		} catch (err) {
			const errno = (err as NodeJS.ErrnoException)?.code;
			if (errno !== 'ENOENT') {
				const reason = err instanceof Error ? err.message : String(err);
				ctx.warnings.push(
					`Failed to clean active-state file ${artifact} [${errno ?? 'unknown'}]: ${reason}`,
				);
			}
		}
	}

	// Delete directories that were successfully archived
	// Uses archive-first-guard: only delete directories we confirmed are in the archive
	for (const dirName of ACTIVE_STATE_DIRS_TO_CLEAN) {
		if (!ctx.archivedActiveStateDirs.has(dirName)) {
			// Directory was NOT archived — do not delete
			continue;
		}
		const dirPath = path.join(ctx.swarmDir, dirName);
		try {
			await fs.rm(dirPath, { recursive: true, force: true });
			cleanedFiles.push(`${dirName}/`);
		} catch {
			// Per-directory failure is non-blocking
		}
	}

	// Remove stale config-backup-*.json files AND ledger sibling files
	// (plan-ledger.archived-*.jsonl and plan-ledger.backup-*.jsonl) that
	// savePlan creates during identity-mismatch reinitialization. Without
	// this sweep, those siblings accumulate forever in .swarm/, undermining
	// the same "clean slate for next session" invariant that motivates the
	// plan-ledger.jsonl removal in ACTIVE_STATE_TO_CLEAN above. The primary
	// plan-ledger.jsonl is already archived into the bundle by stage 2, so
	// these stale siblings are pure noise and safe to delete here.
	try {
		const swarmFiles = await fs.readdir(ctx.swarmDir);
		const configBackups = swarmFiles.filter(
			(f) => f.startsWith('config-backup-') && f.endsWith('.json'),
		);
		for (const backup of configBackups) {
			try {
				await fs.unlink(path.join(ctx.swarmDir, backup));
				configBackupsRemoved++;
			} catch (err) {
				const errno = (err as NodeJS.ErrnoException)?.code;
				if (errno === 'ENOENT') {
					// Stale backup already absent — silent skip.
				} else {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.warnings.push(
						`Failed to clean config-backup ${backup} [${errno ?? 'unknown'}]: ${reason}`,
					);
				}
			}
		}
		const ledgerSiblings = swarmFiles.filter(
			(f) =>
				(f.startsWith('plan-ledger.archived-') ||
					f.startsWith('plan-ledger.backup-')) &&
				f.endsWith('.jsonl'),
		);
		for (const sibling of ledgerSiblings) {
			try {
				await fs.unlink(path.join(ctx.swarmDir, sibling));
			} catch (err) {
				const errno = (err as NodeJS.ErrnoException)?.code;
				if (errno === 'ENOENT') {
					// Stale ledger sibling already absent — silent skip.
				} else {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.warnings.push(
						`Failed to clean ledger sibling ${sibling} [${errno ?? 'unknown'}]: ${reason}`,
					);
				}
			}
		}
	} catch (err) {
		const errno = (err as NodeJS.ErrnoException)?.code;
		if (errno === 'ENOENT') {
			// swarmDir absent — nothing to clean; silent skip.
		} else {
			const reason = err instanceof Error ? err.message : String(err);
			ctx.warnings.push(
				`Failed to read ${ctx.swarmDir} for stale-file cleanup [${errno ?? 'unknown'}]: ${reason}`,
			);
		}
	}

	// Remove SWARM_PLAN checkpoint artifacts written by writeCheckpoint().
	// Cleans the new .swarm/plan-export/ location, the canonical .swarm/
	// location, and any legacy root-level artifacts from pre-7.0 sessions.
	// These are redundant copies of plan.json/plan.md (already archived)
	// and should not be left behind.
	let swarmPlanFilesRemoved = 0;
	const candidates = [
		path.join(ctx.directory, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
		path.join(ctx.directory, '.swarm', 'plan-export', 'SWARM_PLAN.md'),
		path.join(ctx.directory, '.swarm', 'SWARM_PLAN.json'),
		path.join(ctx.directory, '.swarm', 'SWARM_PLAN.md'),
		path.join(ctx.directory, 'SWARM_PLAN.json'),
		path.join(ctx.directory, 'SWARM_PLAN.md'),
	];
	for (const candidate of candidates) {
		try {
			await fs.unlink(candidate);
			swarmPlanFilesRemoved++;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				ctx.warnings.push(
					`Failed to remove ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	// Remove stale .tmp.* files that were left behind by interrupted handoff
	// writes or other transient operations. These are safe to delete because
	// they are recreated on next session init and must be removed to avoid
	// stale-state pollution in the archive bundle.
	let tmpFilesRemoved = 0;
	try {
		const swarmFiles = await fs.readdir(ctx.swarmDir);
		const tmpFiles = swarmFiles.filter((f) => f.startsWith('.tmp.'));
		for (const tmp of tmpFiles) {
			try {
				await fs.unlink(path.join(ctx.swarmDir, tmp));
				tmpFilesRemoved++;
			} catch (err) {
				const errno = (err as NodeJS.ErrnoException)?.code;
				if (errno === 'ENOENT') {
					// Stale tmp file already absent — silent skip.
				} else {
					const reason = err instanceof Error ? err.message : String(err);
					ctx.warnings.push(
						`Failed to clean tmp file ${tmp} [${errno ?? 'unknown'}]: ${reason}`,
					);
				}
			}
		}
	} catch (err) {
		const errno = (err as NodeJS.ErrnoException)?.code;
		if (errno === 'ENOENT') {
			// swarmDir absent — nothing to clean; silent skip.
		} else {
			const reason = err instanceof Error ? err.message : String(err);
			ctx.warnings.push(
				`Failed to read ${ctx.swarmDir} for tmp-file cleanup [${errno ?? 'unknown'}]: ${reason}`,
			);
		}
	}
	if (tmpFilesRemoved > 0) {
		cleanedFiles.push(`${tmpFilesRemoved} .tmp.* file(s)`);
	}

	// Terminal-state removal (finalize knowledge-preservation fix): unconditionally
	// remove plan.json + plan-ledger.jsonl so the next session cannot resurrect the
	// CLOSED plan. loadPlan Step 1 and replayFromLedger have NO terminal-status filter
	// (see the CRITICAL note on ACTIVE_STATE_TO_CLEAN above), so a surviving terminal
	// plan.json OR ledger is materialized back into an active plan next session.
	//
	// Why here, unconditionally: the align stage's `git clean` previously deleted these
	// as a backstop even when the archive-first guard preserved them (archive failure).
	// Now that align only cleans an explicit build-artifact allowlist
	// (GITIGNORED_BUILD_ARTIFACTS) and no longer touches `.swarm/`, the clean stage must
	// own terminal-state removal itself. This is behavior-preserving for these two files
	// (the old blanket clean removed them regardless of archive success). They are copied
	// into the archive bundle first in stage 2 (ARCHIVE_ARTIFACTS), so the forensic trail
	// is retained whenever archiving succeeds; the ENOENT branch below covers the case
	// where the archive-gated cleanup already removed them.
	for (const terminalFile of TERMINAL_STATE_FILES) {
		try {
			await fs.unlink(path.join(ctx.swarmDir, terminalFile));
			if (!cleanedFiles.includes(terminalFile)) {
				cleanedFiles.push(terminalFile);
			}
		} catch (err) {
			const errno = (err as NodeJS.ErrnoException)?.code;
			if (errno === 'ENOENT') {
				// Already removed by the archive-gated cleanup above — expected; silent skip.
			} else {
				const reason = err instanceof Error ? err.message : String(err);
				ctx.warnings.push(
					`Failed to remove terminal-state file ${terminalFile} [${errno ?? 'unknown'}]: ${reason}`,
				);
			}
		}
	}

	// #519 (v6.71.1): clear persisted declare_scope files so the next session
	// starts without inherited scope. Scope files are ephemeral state; they are
	// not archived because they contain no forensic signal not already captured
	// by plan.json:files_touched.
	clearAllScopes(ctx.directory);

	// Reset context.md so new sessions start fresh
	const contextPath = path.join(ctx.swarmDir, 'context.md');
	const contextContent = [
		'# Context',
		'',
		'## Status',
		`Session closed after: ${ctx.projectName}`,
		`Closed: ${new Date().toISOString()}`,
		`Finalization: ${ctx.isForced ? 'forced' : ctx.planAlreadyDone ? 'plan-already-done' : 'normal'}`,
		'No active plan. Next session starts fresh.',
		'',
	].join('\n');
	const contextTempPath = path.join(
		path.dirname(contextPath),
		`${path.basename(contextPath)}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
	);
	try {
		await fs.writeFile(contextTempPath, contextContent, 'utf-8');
		fsSync.renameSync(contextTempPath, contextPath);
		invalidateCachedArtifact(contextPath);
	} catch (error) {
		try {
			fsSync.unlinkSync(contextTempPath);
		} catch {
			// best-effort cleanup
		}
		const msg = error instanceof Error ? error.message : String(error);
		ctx.warnings.push(`Failed to reset context.md: ${msg}`);
		log('[close-command] Failed to write context.md:', error);
	}

	return {
		cleanedFiles,
		configBackupsRemoved,
		swarmPlanFilesRemoved,
		tmpFilesRemoved,
	};
}

/**
 * STAGE 4: ALIGN
 *
 * Performs safe git alignment to main (resetToMainAfterMerge / resetToRemoteBranch
 * via _internals), handling post-merge scenarios and non-git directories.
 * Returns { gitAlignResult, prunedBranches } so the orchestrator can build
 * the close summary. All warnings are pushed into ctx.warnings.
 */
export async function runAlignStage(
	ctx: CloseStageContext,
): Promise<GitAlignResult> {
	const pruneBranches = ctx.args.includes('--prune-branches');
	let gitAlignResult = '';
	const prunedBranches: string[] = [];

	const gitStatus = _internals.getGitRepositoryStatus(ctx.directory);
	if (gitStatus.isRepo) {
		// Try aggressive reset first (handles post-merge scenario with uncommitted changes)
		const aggressiveResult = await _internals.resetToMainAfterMerge(
			ctx.directory,
			{
				pruneBranches,
			},
		);
		if (aggressiveResult.success) {
			gitAlignResult = aggressiveResult.message;
			for (const w of aggressiveResult.warnings) {
				ctx.warnings.push(w);
			}
			if (aggressiveResult.changesDiscarded) {
				ctx.warnings.push(
					'Uncommitted changes were discarded during git alignment',
				);
			}
		} else {
			// Fallback to cautious reset (preserves uncommitted changes)
			const alignResult = await _internals.resetToRemoteBranch(ctx.directory, {
				pruneBranches,
			});
			gitAlignResult = alignResult.message;
			prunedBranches.push(...alignResult.prunedBranches);

			if (!alignResult.success) {
				ctx.warnings.push(`Git alignment: ${alignResult.message}`);
			}
			if (alignResult.alreadyAligned) {
				gitAlignResult = `Already aligned with ${alignResult.targetBranch}`;
			}
			for (const w of alignResult.warnings) {
				ctx.warnings.push(w);
			}
		}
	} else if (gitStatus.reason === 'git_unavailable') {
		gitAlignResult = `Git executable unavailable — skipped git alignment: ${gitStatus.message}`;
		ctx.warnings.push(gitAlignResult);
	} else if (gitStatus.reason === 'git_error') {
		gitAlignResult = `Git repository check failed — skipped git alignment: ${gitStatus.message}`;
		ctx.warnings.push(gitAlignResult);
	} else {
		// gitStatus.reason === 'not_git_repo'
		gitAlignResult = 'Not a git repository — skipped git alignment';
	}

	return { gitAlignResult, prunedBranches };
}

/**
 * Builds the `/swarm finalize --dry-run` report. Purely READ-ONLY: inspects the
 * plan and the filesystem and describes what a real finalize WOULD do, without
 * acquiring the finalize lock, creating an archive bundle, deleting any file,
 * running git, or tearing down session state. (#1692)
 *
 * The archive-first guard means the clean stage only removes files it first
 * archived successfully; this report approximates that by listing existing
 * clean-set members as "would remove" and notes the approximation.
 */
export async function runFinalizeDryRun(
	directory: string,
	swarmDir: string,
	planData: PlanData,
	planExists: boolean,
): Promise<string> {
	const existsInSwarm = (name: string): boolean =>
		fsSync.existsSync(path.join(swarmDir, name));

	const phases = planData.phases ?? [];
	const nonTerminalPhases = phases.filter(
		(p) =>
			p.status !== 'complete' &&
			p.status !== 'completed' &&
			p.status !== 'blocked' &&
			p.status !== 'closed',
	);
	const planAlreadyDone =
		planExists && phases.length > 0 && nonTerminalPhases.length === 0;

	const wouldArchive = ARCHIVE_ARTIFACTS.filter(existsInSwarm);
	const dynamicArchive = (
		await fs.readdir(swarmDir).catch(() => [] as string[])
	).filter(
		(name) =>
			/^post-mortem-[^/\\]+\.md$/.test(name) ||
			/^drift-report-phase-\d+\.json$/.test(name),
	);
	const wouldArchiveDirs = ACTIVE_STATE_DIRS_TO_CLEAN.filter(existsInSwarm);
	const wouldRemoveTerminal = (
		TERMINAL_STATE_FILES as readonly string[]
	).filter(existsInSwarm);
	// TERMINAL_STATE_FILES is a subset of ACTIVE_STATE_TO_CLEAN (both cover
	// plan.json/plan-ledger.jsonl/spec-staleness.json/spec-snapshot.md); list
	// those only once, under "Would remove unconditionally", so the report
	// doesn't show the same file under two different removal rationales.
	const wouldCleanFiles = ACTIVE_STATE_TO_CLEAN.filter(
		(f) =>
			existsInSwarm(f) &&
			!(TERMINAL_STATE_FILES as readonly string[]).includes(f),
	);

	const gitStatus = _internals.getGitRepositoryStatus(directory);
	const gitNote = gitStatus.isRepo
		? 'would align the working tree to main/remote (git reset), pruning merged branches only with --prune-branches'
		: 'would skip git alignment (not a git repository / git unavailable)';

	const lines: string[] = [
		'## /swarm finalize — DRY RUN (no changes made)',
		'',
		'No lock is taken, no files are archived or deleted, no git command runs.',
		'',
		'### Plan',
		planExists
			? planAlreadyDone
				? '- Plan is already terminal — no phases/tasks would be force-closed.'
				: nonTerminalPhases.length > 0
					? `- Would mark ${nonTerminalPhases.length} non-terminal phase(s) as closed: ${nonTerminalPhases.map((p) => `#${p.id} ${p.name}`).join(', ')}`
					: '- No phases present; nothing to close.'
			: '- No plan.json — plan-free session; cleanup-only.',
		'',
		'### Would archive',
		wouldArchive.length > 0 ||
		dynamicArchive.length > 0 ||
		wouldArchiveDirs.length > 0
			? [
					...wouldArchive.map((f) => `- ${f}`),
					...dynamicArchive.map((f) => `- ${f}`),
					...wouldArchiveDirs.map((d) => `- ${d}/`),
				].join('\n')
			: '- (nothing present to archive)',
		'',
		'### Would clean (removed after successful archive)',
		wouldCleanFiles.length > 0 || wouldArchiveDirs.length > 0
			? [
					...wouldCleanFiles.map((f) => `- ${f}`),
					...wouldArchiveDirs.map((d) => `- ${d}/`),
				].join('\n')
			: '- (nothing present to clean)',
		...(wouldRemoveTerminal.length > 0
			? [
					'',
					'### Would remove unconditionally (terminal plan-state)',
					...wouldRemoveTerminal.map((f) => `- ${f}`),
				]
			: []),
		'',
		'### Git',
		`- ${gitNote}`,
		'',
		'_Note: swarm.db-shm / swarm.db-wal are transient SQLite sidecars — they are never archived or cleaned. The clean list is an approximation of the archive-first guard._',
		'',
		'Run `/swarm finalize` (without `--dry-run`) to apply.',
	];

	return lines.join('\n');
}

/**
 * Handles /swarm close command - performs full terminal session finalization:
 * 0. Guarantee: mark all incomplete phases/tasks as closed
 * 1. Finalize: write retrospectives, produce terminal summary
 * 2. Archive: create timestamped bundle of swarm artifacts
 * 3. Clean: clear active-state files that confuse future swarms
 * 4. Align: safe git alignment to main
 *
 * Must be idempotent - safe to run multiple times.
 */
export async function handleCloseCommand(
	directory: string,
	args: string[],
	options: CloseCommandOptions = {},
): Promise<string> {
	const swarmDir = path.join(directory, '.swarm');
	try {
		const stat = fsSync.lstatSync(swarmDir);
		// isSymbolicLink() correctly detects both symlinks and Windows junction
		// points on modern Node/Bun (Node 20+, Bun 1.0+). No additional check
		// needed — `isReparsePoint()` is not available in the Bun type system.
		if (stat.isSymbolicLink()) {
			return `❌ Refused: .swarm/ is a symlink or junction. Refusing to operate on a redirected directory for safety.`;
		}
	} catch (err) {
		// ENOENT means .swarm/ doesn't exist yet — fine, proceed
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			throw err;
		}
	}

	const planPath = validateSwarmPath(directory, 'plan.json');

	let planExists = false;
	let planData: PlanData = {
		title: path.basename(directory) || 'Ad-hoc session',
		phases: [],
	};
	try {
		const content = await fs.readFile(planPath, 'utf-8');
		planData = JSON.parse(content);
		planExists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			return `❌ Failed to read plan.json: ${error instanceof Error ? error.message : String(error)}`;
		}
		// ENOENT — check whether .swarm/ itself exists to distinguish plan-free from wrong directory
		const swarmDirExists = await fs
			.access(swarmDir)
			.then(() => true)
			.catch(() => false);
		if (!swarmDirExists) {
			return `❌ No .swarm/ directory found in ${directory}. Run /swarm close from the project root, or run /swarm plan first.`;
		}
		// .swarm/ exists but plan.json is absent — valid plan-free session, continue with cleanup
	}

	// --dry-run: describe what finalize WOULD do and return WITHOUT taking the
	// finalize lock or mutating anything. Kept before lock acquisition so a
	// dry-run is fully read-only and can never contend with a real run. (#1692)
	if (args.includes('--dry-run')) {
		return _internals.runFinalizeDryRun(
			directory,
			swarmDir,
			planData,
			planExists,
		);
	}

	// FR-012: acquire finalize lock before any destructive work
	let finalizeLock: { acquired: boolean; release?: () => Promise<void> } = {
		acquired: false,
	};
	finalizeLock = await _internals.acquireFinalizeLock(directory);
	if (!finalizeLock.acquired) {
		return `❌ Another /swarm finalize is already running for this project. If you are certain no other run is active, wait for the lock to expire or remove the stale lock and retry.`;
	}

	try {
		// Idempotency check — first thing inside try/finally so finalizeLock is released on all paths.
		// If plan.json is gone and an archive bundle exists AND no active state files remain,
		// this project was already finalized in a prior run. Return a clean no-op so a second
		// /swarm finalize invocation does not produce a degraded "Plan not found" run.
		// CRITICAL: only short-circuit when there is truly nothing left to clean. If any
		// ACTIVE_STATE_TO_CLEAN files still exist in .swarm/, fall through to plan-free close
		// so they get archived and removed (fixes re-finalization after partial cleanup).
		if (!planExists) {
			const archiveDir = path.join(swarmDir, 'archive');
			try {
				const archiveEntries = await fs.readdir(archiveDir);
				const hasArchiveBundle = archiveEntries.some((entry) =>
					entry.startsWith('swarm-'),
				);
				if (hasArchiveBundle) {
					const hasActiveState = [
						...ACTIVE_STATE_TO_CLEAN,
						...ACTIVE_STATE_DIRS_TO_CLEAN,
					].some((entry) => fsSync.existsSync(path.join(swarmDir, entry)));
					if (!hasActiveState) {
						return `✅ Already finalized — nothing to do.\n\nThis project was already finalized in a previous /swarm close run. The plan has been archived and cleaned up. No further action is needed.`;
					}
					// Active state files still exist — fall through to normal plan-free close
					// so they get archived and cleaned up properly.
				}
			} catch {
				// ENOENT or other read error → no archive present, fall through to normal flow
			}
		}

		const phases = planData.phases ?? [];
		const inProgressPhases = phases.filter((p) => p.status === 'in_progress');
		const isForced = args.includes('--force');
		const runSkillReview = args.includes('--skill-review');

		// planAlreadyDone: skip retro writing and plan mutation, but still run all cleanup steps
		let planAlreadyDone = false;
		if (planExists) {
			planAlreadyDone =
				phases.length > 0 &&
				phases.every(
					(p) =>
						p.status === 'complete' ||
						p.status === 'completed' ||
						p.status === 'blocked' ||
						p.status === 'closed',
				);
		}

		const { config: loadedConfig } =
			_internals.loadPluginConfigWithMeta(directory);
		const config = KnowledgeConfigSchema.parse(loadedConfig.knowledge ?? {});

		const ctx: CloseStageContext = {
			directory,
			swarmDir,
			planData,
			planExists,
			planAlreadyDone,
			config,
			projectName: planData.title ?? 'Unknown Project',
			warnings: [],
			closedPhases: [],
			closedTasks: [],
			sessionStart: undefined,
			isForced,
			runSkillReview,
			options,
			phases,
			inProgressPhases,
			curationSucceeded: false,
			curationResult: undefined,
			allLessons: [],
			explicitLessons: [],
			retroLessons: [],
			knowledgeSkillHint: '',
			skillReviewSummary: '',
			postMortemSummary: '',
			sessionReflection: undefined,
			hivePromoted: 0,
			sessionKnowledgeCreated: 0,
			fallbackKnowledgeCreated: 0,
			dedupDropped: 0,
			dedupAvailable: true,
			retroLessonTotal: 0,
			fullAuto: false,
			originalStatuses: new Map(),
			guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
			archiveResult: '',
			archivedFileCount: 0,
			archivedActiveStateFiles: new Set(),
			archivedActiveStateDirs: new Set(),
			archiveFailureReasons: new Map(),
			archiveResults: [],
			archiveStageFailed: false,
			timestamp: '',
			archiveDir: '',
			archiveSuffix: '',
			args,
		};

		// Issue #2077: compute full-auto state ONCE (guarded by sessionID to
		// avoid the cross-session leak documented at skill-improver.ts —
		// hasActiveFullAuto(undefined) scans ALL sessions) and reuse it at both
		// the reflection call and the menu render so the two cannot disagree.
		// Combines the in-memory flag (hasActiveFullAuto) with the durable run
		// state (isFullAutoRunActive) for robustness across process restarts.
		ctx.fullAuto = options.sessionID
			? _internals.detectFullAuto(directory, options.sessionID)
			: false;

		await runFinalizeStage(ctx);
		if (ctx.terminalizationError) {
			return `❌ Close paused before reward, archive, cleanup, teardown, and Git alignment because terminal plan/evidence reconciliation failed: ${ctx.terminalizationError}\n\nNo active state was archived or removed. Fix the reported durable-state problem, then retry /swarm close.`;
		}

		// ─── B.6: NEGATIVE-TERMINAL REWARD SWEEP (design decision C-6) ───
		// Tasks left non-complete were just stamped close_reason='session_terminated'
		// by guaranteeAllPlansComplete (populating ctx.guaranteeResult.closedTaskIds).
		// Memories recalled into those tasks earn a 0.0 terminal reward so their
		// q-value drifts down toward suppression (FR-001 negative / FR-006). This is
		// the deterministic negative counterpart to A.4's positive (APPROVE→1.0)
		// reward. Placed AFTER closedTaskIds is fully populated and BEFORE
		// runAlignStage's destructive git ops, so the reward writes to .swarm/memory/
		// (gitignored, outside finalize's clean allowlists) persist past finalize.
		// Non-blocking: runFinalizeRewardSweep never throws and never alters
		// finalize's task/archive/align behavior — it only records rewards.
		await _internals.runFinalizeRewardSweep({
			directory,
			closedTaskIds: ctx.guaranteeResult.closedTaskIds,
			memoryConfig: loadedConfig.memory,
		});

		await runArchiveStage(ctx);
		const cleanResult = await runCleanStage(ctx);
		// Emit the structured archive event AFTER clean so source_disposition
		// can be finalized truthfully ('removed' for cleaned artifacts).
		// Swallowed: a telemetry failure never blocks close.
		emitCloseArchiveResult(ctx, cleanResult);
		const { gitAlignResult, prunedBranches } = await runAlignStage(ctx);

		// ─── WRITE CLOSE SUMMARY ─────────────────────────────────────────
		const closeSummaryPath = validateSwarmPath(
			ctx.directory,
			'close-summary.md',
		);

		const finalizationType = ctx.isForced
			? 'Forced closure'
			: ctx.planAlreadyDone
				? 'Plan already terminal — cleanup only'
				: 'Normal finalization';

		const summaryContent = [
			'# Swarm Close Summary',
			'',
			`**Project:** ${ctx.projectName}`,
			`**Closed:** ${new Date().toISOString()}`,
			`**Finalization:** ${finalizationType}`,
			'',
			'## Retrospective',
			!ctx.planExists
				? '_No plan — ad-hoc session_'
				: ctx.closedPhases.length > 0
					? ctx.closedPhases.map((id) => `- Phase ${id} closed`).join('\n')
					: '_No phases closed this run_',
			...(ctx.closedTasks.length > 0
				? [
						'',
						`**Tasks marked closed:** ${ctx.closedTasks.length}`,
						...ctx.closedTasks.map((id) => `- ${id}`),
					]
				: []),
			'',
			'## Lessons Committed',
			ctx.allLessons.length > 0 ? `| # | Lesson |` : '_No lessons committed_',
			...(ctx.allLessons.length > 0
				? [
						'| --- | --- |',
						...ctx.allLessons.map((l, i) => `| ${i + 1} | ${l} |`),
					]
				: []),
			...(ctx.knowledgeSkillHint ? ['', ctx.knowledgeSkillHint] : []),
			...(ctx.runSkillReview
				? [
						'',
						'## Skill Review',
						ctx.skillReviewSummary || 'Skill review completed without details.',
					]
				: []),
			...(ctx.sessionReflection
				? [
						'',
						`## Session Reflection (${ctx.sessionReflection.source})`,
						'',
						ctx.sessionReflection.architectReport,
					]
				: []),
			'',
			'## Local Repo State',
			...(gitAlignResult
				? [`- **Git:** ${gitAlignResult}`]
				: ['- Git alignment skipped']),
			...(prunedBranches.length > 0
				? [`- **Pruned branches:** ${prunedBranches.join(', ')}`]
				: []),
			`- **Archive:** ${ctx.archiveResult}`,
			...(cleanResult.cleanedFiles.length > 0
				? [`- **Cleaned:** ${cleanResult.cleanedFiles.length} file(s)`]
				: []),
			'',
			'## Context',
			'- Reset context.md for next session',
			'- Cleared agent sessions, delegation chains, and active-agent mappings',
			...(cleanResult.configBackupsRemoved > 0
				? [
						`- Removed ${cleanResult.configBackupsRemoved} stale config backup file(s)`,
					]
				: []),
			...(cleanResult.swarmPlanFilesRemoved > 0
				? [
						`- Removed ${cleanResult.swarmPlanFilesRemoved} SWARM_PLAN checkpoint artifact(s) from .swarm/plan-export/ and legacy locations`,
					]
				: []),
			...(ctx.planExists && !ctx.planAlreadyDone
				? ['- Set non-completed phases/tasks to closed status']
				: []),
			...(ctx.curationSucceeded && ctx.allLessons.length > 0
				? [`- Committed ${ctx.allLessons.length} lesson(s) to knowledge store`]
				: []),
			...(ctx.hivePromoted > 0
				? [`- Promoted ${ctx.hivePromoted} lesson(s) to hive knowledge`]
				: []),
			'',
			...(ctx.warnings.length > 0
				? ['## Warnings', ...ctx.warnings.map((w) => `- ${w}`), '']
				: []),
		].join('\n');

		const closeSummaryTempPath = path.join(
			path.dirname(closeSummaryPath),
			`${path.basename(closeSummaryPath)}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
		);
		try {
			await fs.writeFile(closeSummaryTempPath, summaryContent, 'utf-8');
			fsSync.renameSync(closeSummaryTempPath, closeSummaryPath);
			// Defensive, not currently load-bearing: no cached reader consumes
			// close-summary.md today, so this is a no-op. It is kept so the file
			// cannot become a stale-read hazard the moment someone routes a read
			// through `readSwarmFileAsync`, matching every other temp+rename
			// writer in this file.
			invalidateCachedArtifact(closeSummaryPath);
		} catch (error) {
			try {
				fsSync.unlinkSync(closeSummaryTempPath);
			} catch {
				// best-effort cleanup
			}
			const msg = error instanceof Error ? error.message : String(error);
			ctx.warnings.push(`Failed to write close-summary.md: ${msg}`);
			log('[close-command] Failed to write close-summary.md:', error);
		}

		// NOTE: writeCheckpoint is intentionally NOT called here. SWARM_PLAN.json and
		// SWARM_PLAN.md are redundant copies of plan.json/plan.md (already archived in
		// .swarm/archive/) and should not be written to the .swarm/ directory during close.
		// Stage 3 cleanup removes any pre-existing SWARM_PLAN artifacts from prior sessions.

		// Terminal state teardown: explicitly end all agent sessions at /swarm close (FR-007).
		// This is the per-session lifecycle signal — endAgentSession(sessionId) is the
		// canonical notification that a session has ended. The resetSwarmStatePreservingSingletons()
		// call below also clears agentSessions as a coarse safety net, but this loop provides
		// the explicit per-session teardown contract required by FR-007. Double-calls are safe
		// because Map.delete is a no-op for missing keys (FR-010).
		// Collect keys first to avoid mutating the Map during iteration.
		//
		// This teardown runs AFTER all four pipeline stages and the close-summary
		// file have already succeeded. A throw here (e.g. from endAgentSession or
		// resetSwarmStatePreservingSingletons) must not escape uncaught and be
		// reported by the dispatcher as a generic "finalize failed" — that would
		// misrepresent an otherwise-successful run. Wrap it and surface any failure
		// as a warning so the success return below still fires. (#1692)
		try {
			const sessionIdsToEnd = [...swarmState.agentSessions.keys()];
			for (const sessionId of sessionIdsToEnd) {
				_internals.endAgentSession(sessionId);
			}

			// Preserve plugin-init singletons through state reset
			_internals.resetSwarmStatePreservingSingletons();
		} catch (teardownError) {
			const msg =
				teardownError instanceof Error
					? teardownError.message
					: String(teardownError);
			ctx.warnings.push(
				`Session teardown encountered an error after finalization completed (state may not be fully reset): ${msg}`,
			);
			log('[close-command] teardown error:', teardownError);
		}

		// Separate retro-specific warnings for prominent display
		const retroWarnings = ctx.warnings.filter(
			(w) =>
				w.includes('Retrospective write') ||
				w.includes('retrospective write') ||
				w.includes('Session retrospective'),
		);
		const otherWarnings = ctx.warnings.filter(
			(w) =>
				!w.includes('Retrospective write') &&
				!w.includes('retrospective write') &&
				!w.includes('Session retrospective'),
		);
		let warningMsg = '';
		if (retroWarnings.length > 0) {
			warningMsg += `\n\n**⚠ Retrospective evidence incomplete:**\n${retroWarnings.map((w) => `- ${w}`).join('\n')}`;
		}
		if (otherWarnings.length > 0) {
			warningMsg += `\n\n**Warnings:**\n${otherWarnings.map((w) => `- ${w}`).join('\n')}`;
		}

		const lessonSummary =
			ctx.curationSucceeded && ctx.allLessons.length > 0
				? `\n\n**Lessons Committed:** ${ctx.allLessons.length} lesson(s) committed to knowledge store`
				: '';
		const knowledgeHintSummary = ctx.knowledgeSkillHint
			? `\n\n**Knowledge Review:** ${ctx.knowledgeSkillHint}`
			: '';
		const skillReviewOutput = ctx.skillReviewSummary
			? `\n\n**Skill Review:** ${ctx.skillReviewSummary}`
			: '';
		const postMortemOutput = ctx.postMortemSummary
			? `\n\n**Post-Mortem:** ${ctx.postMortemSummary}`
			: '';

		let reflectionOutput = '';
		if (ctx.sessionReflection) {
			const d = ctx.sessionReflection.data;
			const hasSignals =
				d.totalToolFailures > 0 ||
				d.gateFailures.length > 0 ||
				d.lessonsFromRetros.length > 0 ||
				Object.keys(d.errorTaxonomy).length > 0 ||
				d.agentDispatches.length > 0;
			if (hasSignals) {
				reflectionOutput = `\n\n---\n\n**Architect Session Review** (${ctx.sessionReflection.source}):\n\n${ctx.sessionReflection.architectReport}`;
			}
		}

		// Issue #2077: the signals block renders UNCONDITIONALLY (not gated by
		// the narrative-report hasSignals check above) so the "0 captured; N
		// deduped" / NOOP line appears even in a clean session — the issue's
		// "single genuinely-absent capability".
		let signalsOutput = '';
		if (ctx.sessionReflection?.signalsReport) {
			signalsOutput = `\n\n---\n\n${ctx.sessionReflection.signalsReport}`;
		}

		// Issue #2077 Phase B: numbered action menu (advisory; application is a
		// later user turn via existing tools). Under full-auto the prompt suffix
		// is suppressed (reported-only) so the run is not blocked.
		let actionMenuOutput = '';
		if (
			ctx.sessionReflection &&
			ctx.sessionReflection.actionProposals.length > 0
		) {
			actionMenuOutput =
				'\n\n' +
				buildActionMenu(ctx.sessionReflection.actionProposals, ctx.fullAuto);
		}

		if (ctx.planAlreadyDone) {
			return `✅ Session finalized. Plan was already in a terminal state — cleanup and archive applied.\n\n**Archive:** ${ctx.archiveResult}\n**Git:** ${gitAlignResult}${lessonSummary}${knowledgeHintSummary}${skillReviewOutput}${postMortemOutput}${reflectionOutput}${signalsOutput}${actionMenuOutput}${warningMsg}`;
		}
		return `✅ Swarm finalized. ${ctx.closedPhases.length} phase(s) closed, ${ctx.closedTasks.length} incomplete task(s) marked closed.\n\n**Archive:** ${ctx.archiveResult}\n**Git:** ${gitAlignResult}${lessonSummary}${knowledgeHintSummary}${skillReviewOutput}${postMortemOutput}${reflectionOutput}${signalsOutput}${actionMenuOutput}${warningMsg}`;
	} finally {
		if (finalizeLock.release) {
			try {
				await finalizeLock.release();
			} catch {
				// non-fatal — lock release failure should not mask the operation result
			}
		}
	}
}

/**
 * Acquire the finalize lock for the close command (FR-012).
 * Wraps tryAcquireLock with a directory-only API.
 */
async function acquireFinalizeLock(
	directory: string,
): Promise<{ acquired: boolean; release?: () => Promise<void> }> {
	const result = await tryAcquireLock(
		directory,
		'finalize.lock',
		'close-command',
		'finalize',
	);
	if (result.acquired) {
		return { acquired: true, release: result.lock._release };
	}
	return { acquired: false };
}

/**
 * Issue #2077: detect full-auto state for the action-menu prompt suppression.
 * Combines the in-memory session flag (hasActiveFullAuto) with the durable
 * run state (isFullAutoRunActive reads .swarm/full-auto-state.json) so a
 * process restart mid-run does not silently re-enable the interactive menu
 * prompt. The durable check is sync and takes a state lock; if it throws,
 * fall back to the in-memory flag alone. Caller MUST guard with a defined
 * sessionID to avoid the cross-session leak (hasActiveFullAuto(undefined)
 * scans all sessions).
 */
function detectFullAuto(directory: string, sessionID: string): boolean {
	if (hasActiveFullAuto(sessionID)) return true;
	try {
		return isFullAutoRunActive(directory, sessionID);
	} catch {
		// Durable state read failed — fall back to in-memory flag only.
		return false;
	}
}

export const _internals = {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	countSessionKnowledgeEntries,
	CLOSE_SKILL_REVIEW_TIMEOUT_MS,
	CLOSE_REFLECTION_TIMEOUT_MS,
	detectFullAuto, // issue #2077: full-auto detection (testable via _internals)
	guaranteeAllPlansComplete,
	getGitRepositoryStatus,
	resetToMainAfterMerge,
	resetToRemoteBranch,
	copyDirRecursive,
	loadPluginConfigWithMeta,
	curateAndStoreSwarm,
	checkHivePromotions,
	runCuratorPostMortem,
	createCuratorLLMDelegate,
	resetSwarmStatePreservingSingletons,
	runFinalizeStage,
	runFinalizeRewardSweep,
	acquireFinalizeLock,
	runArchiveStage,
	runArchiveEvidenceRetention,
	runCleanStage,
	runAlignStage,
	runFinalizeDryRun,
	archiveEvidence,
	// Seam name intentionally retained for test compatibility; see the
	// reconcileCloseTerminalStateForPlan doc comment for why the function itself
	// no longer shares plan/manager.ts's `closePlanTerminalState` name.
	closePlanTerminalState: reconcileCloseTerminalStateForPlan,
	endAgentSession,
	// Flushes the telemetry write stream before its files are archived. Delegates
	// to the telemetry module's _internals so tests can substitute a no-op.
	// (Replaces the former spawnSync seam, which was used only by the deleted
	// copySqliteSafe to shell out to the external sqlite3 CLI — issue #2030
	// removes that external dependency entirely.)
	flushAndDrainTelemetry: async (): Promise<void> => {
		const { flushAndDrainTelemetry } = await import('../telemetry.js');
		return flushAndDrainTelemetry();
	},
};
