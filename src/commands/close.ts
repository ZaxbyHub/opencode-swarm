import { spawnSync } from 'node:child_process';
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
import { archiveEvidence } from '../evidence/manager';
import {
	getGitRepositoryStatus,
	resetToMainAfterMerge,
	resetToRemoteBranch,
} from '../git/branch';
import { createCuratorLLMDelegate } from '../hooks/curator-llm-factory';
import { runCuratorPostMortem } from '../hooks/curator-postmortem';
import { checkHivePromotions } from '../hooks/hive-promoter';
import { curateAndStoreSwarm } from '../hooks/knowledge-curator';
import { isLinked } from '../hooks/knowledge-link';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types';
import { validateSwarmPath } from '../hooks/utils';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { closePlanTerminalState } from '../plan/manager';
import { clearAllScopes } from '../scope/scope-persistence';
import {
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
import { resetSwarmStatePreservingSingletons, swarmState } from '../state';
import { executeWriteRetro } from '../tools/write-retro';

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

interface CloseCommandOptions {
	sessionID?: string;
	skillReviewTimeoutMs?: number;
}

interface CurationCounts {
	stored: number;
	skipped: number;
	rejected: number;
	quarantined: number;
}

interface CloseKnowledgeEntry {
	created_at?: string;
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
	originalStatuses: Map<string, string>;
	guaranteeResult: { closedPhaseIds: number[]; closedTaskIds: string[] };
	archiveResult: string;
	archivedFileCount: number;
	archivedActiveStateFiles: Set<string>;
	archivedActiveStateDirs: Set<string>;
	archiveFailureReasons: Map<string, string>;
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
	'repo-graph.json',
	'doc-manifest.json',
	'dark-matter.md',
	'telemetry.jsonl',
	'swarm.db',
	'swarm.db-shm',
	'swarm.db-wal',
	'close-summary.md',
	'session-reflection.md',
	'spec.md',
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
 * dark-matter.md, telemetry.jsonl, swarm.db, swarm.db-shm, and swarm.db-wal are
 * session-generated artifacts that do not persist meaningfully across sessions —
 * they are recreated on next session init and must be removed to avoid stale-state
 * interference.
 *
 * Note: knowledge.jsonl is intentionally NOT cleaned because it contains cumulative
 * project knowledge (lessons learned) that should persist across sessions and finalize
 * cycles. The archive step still creates a backup for safety.
 * close-summary.md and spec.md are NOT cleaned because close-summary.md
 * is written as the final close output after cleanup and spec.md may not exist.
 * session-reflection.md is a single-session snapshot (not cumulative like
 * knowledge.jsonl) so it IS cleaned to maintain the clean-slate invariant.
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
	'repo-graph.json',
	'doc-manifest.json',
	'dark-matter.md',
	'telemetry.jsonl',
	'session-reflection.md',
	'swarm.db',
	'swarm.db-shm',
	'swarm.db-wal',
];

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
 * Active-state directories to archive and clean after archiving.
 * These contain session-generated data that must be removed so future
 * swarms start clean. Each entry is a relative path under .swarm/.
 */
const ACTIVE_STATE_DIRS_TO_CLEAN = [
	'evidence',
	'session',
	'scopes',
	'spec-archive',
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
	}

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
		console.warn('[close-command] curateAndStoreSwarm error:', error);
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

		// Persist the terminal plan state
		if (
			!ctx.planAlreadyDone ||
			ctx.guaranteeResult.closedPhaseIds.length > 0 ||
			ctx.guaranteeResult.closedTaskIds.length > 0
		) {
			try {
				await _internals.closePlanTerminalState(
					ctx.directory,
					ctx.planData as Plan,
					{
						closedPhaseIds: ctx.guaranteeResult.closedPhaseIds,
						closedTaskIds: ctx.guaranteeResult.closedTaskIds,
						originalStatuses: ctx.originalStatuses,
					},
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				ctx.warnings.push(`Failed to persist terminal plan state: ${msg}`);
				console.warn(
					'[close-command] Failed to write terminal plan state:',
					error,
				);
				// SC-013 rollback: restore in-memory state to match on-disk when
				// terminal write fails so the summary does not falsely claim
				// phases/tasks were closed
				ctx.planData = planDataSnapshot;
				ctx.closedPhases.length = closedPhasesLenBefore;
				ctx.closedTasks.length = closedTasksLenBefore;
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
 * Copies a WAL-mode SQLite database to a destination path using a safe
 * two-step mechanism that avoids capturing uncommitted WAL pages:
 *
 *   1. Run PRAGMA wal_checkpoint(TRUNCATE) to flush all WAL pages into the
 *      main DB file and truncate the WAL to zero length.
 *   2. Copy only the .db file (skip -shm/-wal, which are transient by design).
 *
 * Falls back to raw copyFile if the sqlite3 CLI is not available, logging
 * a warning so operators know the copy may include uncommitted WAL state.
 *
 * Returns `{ success, skipped?, reason? }` so callers can distinguish a
 * silent ENOENT skip from a real failure.
 */
async function copySqliteSafe(
	srcPath: string,
	destPath: string,
): Promise<
	| { success: true; skipped?: true; reason?: string }
	| { success: false; reason: string; skipped?: boolean }
> {
	// Source must exist before invoking sqlite3 — sqlite3 will silently CREATE
	// an empty DB for a missing path, which would cause a fabricated file to
	// be archived instead of a clean ENOENT skip.
	if (!fsSync.existsSync(srcPath)) {
		return {
			success: true,
			skipped: true,
			reason: 'source does not exist (ENOENT)',
		};
	}

	// Step 1 — flush WAL → main DB via sqlite3 CLI (no SQLite library dep).
	let checkpointVerified = false;
	try {
		const result = spawnSync(
			'sqlite3',
			[srcPath, 'PRAGMA wal_checkpoint(TRUNCATE);'],
			{
				cwd: path.dirname(srcPath),
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 10_000,
				windowsHide: true,
				maxBuffer: 1024,
			},
		);
		if (result.error) {
			const code = (result.error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				// sqlite3 CLI not installed — fall back to raw copy with warning
				try {
					await fs.copyFile(srcPath, destPath);
					return {
						success: true,
						reason: 'copied without WAL checkpoint (sqlite3 CLI unavailable)',
					};
				} catch (copyErr) {
					return {
						success: false,
						reason: `fallback copy failed: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
					};
				}
			}
			// Other spawnSync errors (ETIMEDOUT, etc.)
			return {
				success: false,
				reason: `wal_checkpoint failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
			};
		}
		if (result.status !== 0) {
			return {
				success: false,
				reason: `wal_checkpoint exited with code ${result.status}`,
			};
		}

		// PRAGMA wal_checkpoint(TRUNCATE) output format:
		//   busy|log|checkpointed
		//   0|0|0          ← busy=0 means checkpoint completed
		//   1|104|103      ← busy=1 means checkpoint incomplete
		const output = (result.stdout || '').trim();
		const lines = output.split('\n').filter((l) => l.trim());
		if (lines.length >= 1) {
			const dataLine = lines[0];
			const columns = dataLine.split('|');
			const busyFlag = parseInt(columns[0], 10);
			checkpointVerified = !Number.isNaN(busyFlag) && busyFlag === 0;
		}
	} catch (err) {
		return {
			success: false,
			reason: `wal_checkpoint error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// Step 2 — copy only the .db file; -shm/-wal are transient and intentionally skipped.
	// Only mark as "safe to clean" (no reason) when the WAL checkpoint was verified complete.
	// In all other cases, preserve the original by including a reason so the caller
	// knows not to delete the source swarm.db.
	try {
		await fs.copyFile(srcPath, destPath);
		if (checkpointVerified) {
			return { success: true };
		}
		return {
			success: true,
			reason:
				'WAL checkpoint incomplete (busy) — archive copy may be stale, original preserved',
		};
	} catch (err) {
		return {
			success: false,
			reason: `copy failed: ${err instanceof Error ? err.message : String(err)}`,
		};
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

		// Copy swarm artifacts to archive.
		// Tracks per-artifact failures so the clean-stage "Preserved …" message
		// can distinguish "file absent" (ENOENT, silent) from lock/perm/space
		// errors (surfaced as warnings with the actual errno code).
		// WAL sidecar files (-shm/-wal) are transient SQLite internals.
		// They are NOT archived (SQLite recreates them on next open) and
		// are NOT cleaned (the clean-stage "Preserved" warning is correct).
		// swarm.db itself is handled by copySqliteSafe below.
		const WAL_SIDECAR_FILES = new Set(['swarm.db-shm', 'swarm.db-wal']);

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
			// Skip WAL sidecars — they are ephemeral and not user data.
			if (WAL_SIDECAR_FILES.has(artifact)) {
				continue;
			}

			// Skip cohort-shared knowledge artifacts when linked (see note above).
			if (linkedKnowledgeShared && KNOWLEDGE_FAMILY_ARTIFACTS.has(artifact)) {
				continue;
			}

			const srcPath = path.join(ctx.swarmDir, artifact);
			const destPath = path.join(ctx.archiveDir, artifact);

			if (artifact === 'swarm.db') {
				// SQLite-safe path: checkpoint WAL first, then copy only the .db file.
				// Sidecar files (-shm/-wal) are transient SQLite internals and are
				// intentionally NOT archived or cleaned — SQLite recreates them on
				// next open. The user will see benign "Preserved" warnings for these
				// files in the clean stage, which is correct and informational.
				const result = await copySqliteSafe(srcPath, destPath);
				if (result.skipped) {
					// ENOENT — file absent; treat as silent skip, same as other artifacts.
				} else if (result.success) {
					ctx.archivedFileCount++;
					if (result.reason) {
						// Fallback path — WAL checkpoint NOT performed (sqlite3 CLI unavailable,
						// or other non-fatal issue). Archive copy was created, but original is
						// PRESERVED to prevent data loss (uncheckpointed WAL pages in swarm.db-wal
						// would be orphaned if base is deleted).
						ctx.warnings.push(
							`Archived ${artifact}: ${result.reason}. Original preserved to prevent data loss.`,
						);
						// DON'T add to archivedActiveStateFiles — original swarm.db is preserved
					} else {
						// WAL checkpoint succeeded — safe to clean the original
						ctx.archivedActiveStateFiles.add(artifact);
					}
				} else {
					ctx.archiveFailureReasons.set(artifact, result.reason);
					ctx.warnings.push(
						`Failed to archive ${artifact}: ${result.reason}. File preserved (not cleaned up).`,
					);
				}
			} else {
				try {
					await fs.copyFile(srcPath, destPath);
					ctx.archivedFileCount++;
					if (ACTIVE_STATE_TO_CLEAN.includes(artifact)) {
						ctx.archivedActiveStateFiles.add(artifact);
					}
				} catch (err: unknown) {
					const errno = (err as NodeJS.ErrnoException)?.code;
					if (errno === 'ENOENT') {
						// File absent — expected for optional artifacts; silent skip.
					} else {
						const reason = err instanceof Error ? err.message : String(err);
						ctx.archiveFailureReasons.set(
							artifact,
							`${errno ?? 'unknown'}: ${reason}`,
						);
						ctx.warnings.push(
							`Failed to archive ${artifact} [${errno ?? 'unknown'}]: ${reason}. File preserved (not cleaned up).`,
						);
					}
				}
			}
		}

		// Archive directories (evidence/, session/, scopes/, locks/, spec-archive/)
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

		ctx.archiveResult = `Archived ${ctx.archivedFileCount} artifact(s) to .swarm/archive/swarm-${ctx.timestamp}-${ctx.archiveSuffix}/`;
	} catch (archiveError) {
		ctx.warnings.push(
			`Archive creation failed: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`,
		);
		ctx.archiveResult = 'Archive creation failed (see warnings)';
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
 * Reads max_age_days / max_bundles from config.evidence (FR-016) and
 * calls archiveEvidence. Fail-open: pushes a warning on error but never throws.
 */
export async function runArchiveEvidenceRetention(
	ctx: ArchiveStageContext,
): Promise<void> {
	let maxAgeDays = 30;
	let maxBundles = 10;
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
	} catch {
		// Fallback to defaults on config read failure
	}

	try {
		await _internals.archiveEvidence(ctx.directory, maxAgeDays, maxBundles);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.warnings.push(`Evidence retention archive failed: ${msg}`);
		console.warn('[close-command] archiveEvidence error:', error);
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
				// This file was NOT successfully archived — do not delete it.
				// Include the failure reason when one was recorded (e.g. EBUSY,
				// EPERM, ENOSPC) so operators can diagnose without digging into logs.
				const reason = ctx.archiveFailureReasons?.get(artifact);
				ctx.warnings.push(
					reason
						? `Preserved ${artifact} because it was not successfully archived: ${reason}.`
						: `Preserved ${artifact} because it was not successfully archived.`,
				);
				continue;
			}
			const filePath = path.join(ctx.swarmDir, artifact);
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
	// Cleans both the canonical .swarm/ location and any legacy root-level
	// artifacts from pre-7.0 sessions. These are redundant copies of
	// plan.json/plan.md (already archived) and should not be left behind.
	let swarmPlanFilesRemoved = 0;
	const candidates = [
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
	} catch (error) {
		try {
			fsSync.unlinkSync(contextTempPath);
		} catch {
			// best-effort cleanup
		}
		const msg = error instanceof Error ? error.message : String(error);
		ctx.warnings.push(`Failed to reset context.md: ${msg}`);
		console.warn('[close-command] Failed to write context.md:', error);
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
			originalStatuses: new Map(),
			guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
			archiveResult: '',
			archivedFileCount: 0,
			archivedActiveStateFiles: new Set(),
			archivedActiveStateDirs: new Set(),
			archiveFailureReasons: new Map(),
			timestamp: '',
			archiveDir: '',
			archiveSuffix: '',
			args,
		};

		await runFinalizeStage(ctx);
		await runArchiveStage(ctx);
		const cleanResult = await runCleanStage(ctx);
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
			'- Cleared agent sessions and delegation chains',
			...(cleanResult.configBackupsRemoved > 0
				? [
						`- Removed ${cleanResult.configBackupsRemoved} stale config backup file(s)`,
					]
				: []),
			...(cleanResult.swarmPlanFilesRemoved > 0
				? [
						`- Removed ${cleanResult.swarmPlanFilesRemoved} SWARM_PLAN checkpoint artifact(s)`,
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
		} catch (error) {
			try {
				fsSync.unlinkSync(closeSummaryTempPath);
			} catch {
				// best-effort cleanup
			}
			const msg = error instanceof Error ? error.message : String(error);
			ctx.warnings.push(`Failed to write close-summary.md: ${msg}`);
			console.warn('[close-command] Failed to write close-summary.md:', error);
		}

		// NOTE: writeCheckpoint is intentionally NOT called here. SWARM_PLAN.json and
		// SWARM_PLAN.md are redundant copies of plan.json/plan.md (already archived in
		// .swarm/archive/) and should not be written to the .swarm/ directory during close.
		// Stage 3 cleanup removes any pre-existing SWARM_PLAN artifacts from prior sessions.

		// Preserve plugin-init singletons through state reset
		_internals.resetSwarmStatePreservingSingletons();

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

		if (ctx.planAlreadyDone) {
			return `✅ Session finalized. Plan was already in a terminal state — cleanup and archive applied.\n\n**Archive:** ${ctx.archiveResult}\n**Git:** ${gitAlignResult}${lessonSummary}${knowledgeHintSummary}${skillReviewOutput}${postMortemOutput}${reflectionOutput}${warningMsg}`;
		}
		return `✅ Swarm finalized. ${ctx.closedPhases.length} phase(s) closed, ${ctx.closedTasks.length} incomplete task(s) marked closed.\n\n**Archive:** ${ctx.archiveResult}\n**Git:** ${gitAlignResult}${lessonSummary}${knowledgeHintSummary}${skillReviewOutput}${postMortemOutput}${reflectionOutput}${warningMsg}`;
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

export const _internals = {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	countSessionKnowledgeEntries,
	CLOSE_SKILL_REVIEW_TIMEOUT_MS,
	CLOSE_REFLECTION_TIMEOUT_MS,
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
	acquireFinalizeLock,
	runArchiveStage,
	runArchiveEvidenceRetention,
	runCleanStage,
	runAlignStage,
	archiveEvidence,
	closePlanTerminalState,
};
