import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Plan } from '../../config/plan-schema';
import { SkillImproverConfigSchema } from '../../config/schema';
import { extractCurrentPhaseFromPlan } from '../../hooks/extractors.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../hooks/knowledge-types';
import {
	runSessionReflection,
	writeSessionReflection,
} from '../../services/session-reflection';
import {
	runSkillImprover,
	type SkillImproveRequest,
	type SkillImproveResult,
} from '../../services/skill-improver';
import { readEarliestSessionStart } from '../../session/session-start-store.js';
import { swarmState } from '../../state';
import { executeWriteRetro } from '../../tools/write-retro';
import { log } from '../../utils/logger';
import {
	type CloseTerminalResult,
	reconcileCloseTerminalState,
} from '../../workflow/close-terminal.js';
import {
	CLOSE_REFLECTION_TIMEOUT_MS,
	CLOSE_SKILL_REVIEW_TIMEOUT_MS,
	NO_RECEIPT_PHASE_CLOSE_SCOPE_DETAIL,
} from './constants.js';
import type {
	CloseKnowledgeEntry,
	CloseStageContext,
	PlanData,
} from './context.js';
import { _internals, closeReceiptLifecycleInternals } from './internals.js';

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
export async function reconcileCloseTerminalStateForPlan(
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
export function hardStopTerminalization(
	ctx: CloseStageContext,
	message: string,
): void {
	ctx.warnings.push(message);
	ctx.terminalizationError = message;
}
export async function runAbortableReflection(
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
export async function runAbortableSkillReview(
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
export function normalizeLessonText(text: string): string {
	return (text ?? '').trim().toLowerCase();
}
export function countSessionKnowledgeEntries(
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
/**
 * Guarantee all phases and tasks in a plan are marked complete/closed.
 * Mutates planData in place. Returns actual IDs of newly closed phases and
 * tasks so the caller can track only genuinely new closures (idempotent).
 */
export function guaranteeAllPlansComplete(planData: PlanData): {
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
						verdict: ctx.isForced ? 'fail' : 'pass',
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
					verdict: ctx.isForced ? 'fail' : 'pass',
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
		const { CuratorConfigSchema: CCS } = await import('../../config/schema.js');
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
