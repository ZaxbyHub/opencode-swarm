import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadPluginConfigWithMeta } from '../config';
import {
	KnowledgeConfigSchema,
	SkillImproverConfigSchema,
} from '../config/schema';
import { archiveEvidence } from '../evidence/manager';
import {
	isGitRepo,
	resetToMainAfterMerge,
	resetToRemoteBranch,
} from '../git/branch';
import { promoteToHive } from '../hooks/hive-promoter';
import { curateAndStoreSwarm } from '../hooks/knowledge-curator';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store';
import { validateSwarmPath } from '../hooks/utils';

import { clearAllScopes } from '../scope/scope-persistence';
import {
	runSkillImprover,
	type SkillImproveRequest,
	type SkillImproveResult,
} from '../services/skill-improver';
import { resetSwarmState, swarmState } from '../state';
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
}

interface CloseKnowledgeEntry {
	created_at?: string;
}

const CLOSE_SKILL_REVIEW_TIMEOUT_MS = 120_000;

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
 * knowledge.jsonl, knowledge-rejected.jsonl, repo-graph.json, doc-manifest.json,
 * dark-matter.md, telemetry.jsonl, swarm.db, swarm.db-shm, and swarm.db-wal are
 * session-generated artifacts that do not persist meaningfully across sessions —
 * they are recreated on next session init and must be removed to avoid stale-state
 * interference. close-summary.md and spec.md are NOT cleaned because close-summary.md
 * is written as the final close output after cleanup and spec.md may not exist.
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
	'knowledge.jsonl',
	'knowledge-rejected.jsonl',
	'repo-graph.json',
	'doc-manifest.json',
	'dark-matter.md',
	'telemetry.jsonl',
	'swarm.db',
	'swarm.db-shm',
	'swarm.db-wal',
];

/**
 * Active-state directories to archive and clean after archiving.
 * These contain session-generated data that must be removed so future
 * swarms start clean. Each entry is a relative path under .swarm/.
 */
const ACTIVE_STATE_DIRS_TO_CLEAN = [
	'evidence',
	'session',
	'scopes',
	'locks',
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
	const planPath = validateSwarmPath(directory, 'plan.json');
	const swarmDir = path.join(directory, '.swarm');

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

	const config = KnowledgeConfigSchema.parse({});
	const projectName = planData.title ?? 'Unknown Project';
	const closedPhases: number[] = [];
	const closedTasks: string[] = [];
	const warnings: string[] = [];
	let hivePromoted = 0;

	// ─── STAGE 1: FINALIZE ───────────────────────────────────────────
	if (!planAlreadyDone) {
		for (const phase of inProgressPhases) {
			closedPhases.push(phase.id);

			let retroResult: string | undefined;
			try {
				retroResult = await executeWriteRetro(
					{
						phase: phase.id,
						summary: isForced
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
					directory,
				);
			} catch (retroError) {
				warnings.push(
					`Retrospective write threw for phase ${phase.id}: ${retroError instanceof Error ? retroError.message : String(retroError)}`,
				);
			}

			if (retroResult !== undefined) {
				try {
					const parsed = JSON.parse(retroResult);
					if (parsed.success !== true) {
						warnings.push(`Retrospective write failed for phase ${phase.id}`);
					}
				} catch {
					// Non-JSON response is not an error
				}
			}

			for (const task of phase.tasks ?? []) {
				if (task.status !== 'completed' && task.status !== 'complete') {
					closedTasks.push(task.id);
				}
			}
		}
	}

	// Derive session start time for session-scoping.
	// This prevents taxonomy noise from residual evidence bundles of prior sessions (#444 item 9).
	// Use the earliest lastAgentEventTime from in-memory swarmState — this is reliable because
	// it reflects the current process's session lifecycle and is not affected by .swarm/ directory
	// persistence across /swarm close cycles (the directory is preserved, only files are removed).
	let sessionStart: string | undefined;
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
			sessionStart = new Date(earliest).toISOString();
		}
	}

	// Session-level retrospective for plan-free closes. The user's original ask
	// included "run retrospective" — the per-phase loop above skips this case
	// because there are no phases. We write a dedicated retro-session bundle so
	// the archive + knowledge curator still have something to work with.
	const wrotePhaseRetro = closedPhases.length > 0;
	if (!wrotePhaseRetro && !planExists) {
		try {
			const sessionRetroResult = await executeWriteRetro(
				{
					phase: 1,
					task_id: 'retro-session',
					summary: isForced
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
						...(sessionStart ? { session_start: sessionStart } : {}),
					},
				},
				directory,
			);
			try {
				const parsed = JSON.parse(sessionRetroResult);
				if (parsed.success !== true) {
					warnings.push(
						`Session retrospective write failed: ${parsed.message ?? 'unknown'}`,
					);
				}
			} catch {
				// Non-JSON response is not an error
			}
		} catch (retroError) {
			warnings.push(
				`Session retrospective write threw: ${retroError instanceof Error ? retroError.message : String(retroError)}`,
			);
		}
	}

	// Read explicit lessons from .swarm/close-lessons.md if present
	const lessonsFilePath = path.join(swarmDir, 'close-lessons.md');
	let explicitLessons: string[] = [];
	try {
		const lessonsText = await fs.readFile(lessonsFilePath, 'utf-8');
		explicitLessons = lessonsText
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('#'));
	} catch {
		// File absent or unreadable — use empty array
	}

	// Read lessons from retro evidence bundles
	const retroLessons: string[] = [];
	try {
		const evidenceDir = path.join(swarmDir, 'evidence');
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
								retroLessons.push(lesson.trim());
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

	const allLessons = [...new Set([...explicitLessons, ...retroLessons])];

	let curationSucceeded = false;
	let curationResult: CurationCounts | undefined;
	try {
		curationResult = await curateAndStoreSwarm(
			allLessons,
			projectName,
			{ phase_number: 0 },
			directory,
			config,
		);
		curationSucceeded = true;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		warnings.push(`Lessons curation failed: ${msg}`);
		console.warn('[close-command] curateAndStoreSwarm error:', error);
	}

	if (curationSucceeded && allLessons.length > 0) {
		await fs.unlink(lessonsFilePath).catch(() => {});
	}

	// ─── HIVE PROMOTION ──────────────────────────────────────────────
	// Promote swarm lessons to cross-project hive knowledge.
	// Non-blocking: failures are logged as warnings, close still succeeds.
	if (curationSucceeded) {
		try {
			const knowledgePath = resolveSwarmKnowledgePath(directory);
			const entries = await readKnowledge<{
				id: string;
				lesson: string;
				category: string;
			}>(knowledgePath);
			if (entries.length > 0) {
				for (const entry of entries) {
					try {
						await promoteToHive(directory, entry.lesson, entry.category);
						hivePromoted++;
					} catch (promotionErr) {
						const msg =
							promotionErr instanceof Error
								? promotionErr.message
								: String(promotionErr);
						warnings.push(`Hive promotion skipped for lesson: ${msg}`);
					}
				}
			}
		} catch (hiveErr) {
			const msg = hiveErr instanceof Error ? hiveErr.message : String(hiveErr);
			warnings.push(`Hive promotion failed: ${msg}`);
		}
	}

	const fallbackKnowledgeCreated = curationResult?.stored ?? 0;
	let sessionKnowledgeCreated = fallbackKnowledgeCreated;
	try {
		const knowledgePath = resolveSwarmKnowledgePath(directory);
		const entries = await readKnowledge<CloseKnowledgeEntry>(knowledgePath);
		sessionKnowledgeCreated = countSessionKnowledgeEntries(
			entries,
			sessionStart,
			fallbackKnowledgeCreated,
		);
	} catch (knowledgeErr) {
		const msg =
			knowledgeErr instanceof Error
				? knowledgeErr.message
				: String(knowledgeErr);
		warnings.push(`Knowledge session count failed: ${msg}`);
	}

	const knowledgeSkillHint =
		sessionKnowledgeCreated > 0
			? `${sessionKnowledgeCreated} knowledge entries created this session. Consider running skill_improve or skill_generate to compile mature entries into skills.`
			: '';

	let skillReviewSummary = '';
	if (runSkillReview) {
		try {
			const { config: loadedConfig } = loadPluginConfigWithMeta(directory);
			const skillImproverConfig = SkillImproverConfigSchema.parse(
				loadedConfig.skill_improver ?? {},
			);
			const skillReviewResult = await runAbortableSkillReview(
				{
					directory,
					config: skillImproverConfig,
					targets: ['skills', 'knowledge'],
					mode: 'proposal',
					sessionId: options.sessionID,
				},
				options.skillReviewTimeoutMs ?? CLOSE_SKILL_REVIEW_TIMEOUT_MS,
			);
			if (skillReviewResult.ran) {
				const proposal = skillReviewResult.proposalPath
					? ` Proposal: ${skillReviewResult.proposalPath}.`
					: '';
				const source = skillReviewResult.source
					? ` Source: ${skillReviewResult.source}.`
					: '';
				skillReviewSummary = `Skill review proposal generated.${proposal}${source}`;
			} else {
				const reason = skillReviewResult.reason ?? 'unknown reason';
				skillReviewSummary = `Skill review skipped: ${reason}`;
				warnings.push(skillReviewSummary);
			}
		} catch (skillReviewErr) {
			const msg =
				skillReviewErr instanceof Error
					? skillReviewErr.message
					: String(skillReviewErr);
			skillReviewSummary = `Skill review failed: ${msg}`;
			warnings.push(skillReviewSummary);
		}
	}

	// ─── ALL-PLANS-COMPLETE GUARANTEE ────────────────────────────────
	if (planExists) {
		const guaranteeResult = guaranteeAllPlansComplete(planData);
		// Only track newly closed phases/tasks by identity
		for (const phaseId of guaranteeResult.closedPhaseIds) {
			if (!closedPhases.includes(phaseId)) {
				closedPhases.push(phaseId);
			}
		}
		for (const taskId of guaranteeResult.closedTaskIds) {
			if (!closedTasks.includes(taskId)) {
				closedTasks.push(taskId);
			}
		}

		// Persist the terminal plan state
		if (
			!planAlreadyDone ||
			guaranteeResult.closedPhaseIds.length > 0 ||
			guaranteeResult.closedTaskIds.length > 0
		) {
			try {
				await fs.writeFile(
					planPath,
					JSON.stringify(planData, null, 2),
					'utf-8',
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				warnings.push(`Failed to persist terminal plan.json state: ${msg}`);
				console.warn('[close-command] Failed to write plan.json:', error);
			}
		}
	}

	// ─── STAGE 2: ARCHIVE ────────────────────────────────────────────
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const suffix = Math.random().toString(36).slice(2, 8);
	const archiveDir = path.join(
		swarmDir,
		'archive',
		`swarm-${timestamp}-${suffix}`,
	);
	let archiveResult = '';
	let archivedFileCount = 0;
	/** Track which active-state files were successfully backed up to the archive.
	 *  Only these files are safe to delete in the clean stage. */
	const archivedActiveStateFiles = new Set<string>();
	/** Track which active-state directories were successfully backed up to the archive.
	 *  Only these directories are safe to delete in the clean stage. */
	const archivedActiveStateDirs = new Set<string>();

	try {
		await fs.mkdir(archiveDir, { recursive: true });

		// Copy swarm artifacts to archive
		for (const artifact of ARCHIVE_ARTIFACTS) {
			const srcPath = path.join(swarmDir, artifact);
			const destPath = path.join(archiveDir, artifact);
			try {
				await fs.copyFile(srcPath, destPath);
				archivedFileCount++;
				if (ACTIVE_STATE_TO_CLEAN.includes(artifact)) {
					archivedActiveStateFiles.add(artifact);
				}
			} catch {
				// File may not exist — skip silently
			}
		}

		// Archive directories (evidence/, session/, scopes/, locks/, spec-archive/)
		for (const dirName of ACTIVE_STATE_DIRS_TO_CLEAN) {
			const srcDir = path.join(swarmDir, dirName);
			const destDir = path.join(archiveDir, dirName);
			try {
				const entries = await fs.readdir(srcDir);
				if (entries.length > 0) {
					await fs.mkdir(destDir, { recursive: true });
					for (const entry of entries) {
						const srcEntry = path.join(srcDir, entry);
						const destEntry = path.join(destDir, entry);
						try {
							const stat = await fs.stat(srcEntry);
							if (stat.isDirectory()) {
								await fs.mkdir(destEntry, { recursive: true });
								const subEntries = await fs.readdir(srcEntry);
								for (const sub of subEntries) {
									await fs
										.copyFile(
											path.join(srcEntry, sub),
											path.join(destEntry, sub),
										)
										.catch(() => {});
								}
							} else {
								await fs.copyFile(srcEntry, destEntry);
							}
							archivedFileCount++;
						} catch {
							// Per-entry failure is non-blocking
						}
					}
				}
				archivedActiveStateDirs.add(dirName);
			} catch {
				// Directory may not exist — skip silently
			}
		}

		archiveResult = `Archived ${archivedFileCount} artifact(s) to .swarm/archive/swarm-${timestamp}/`;
	} catch (archiveError) {
		warnings.push(
			`Archive creation failed: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`,
		);
		archiveResult = 'Archive creation failed (see warnings)';
	}

	// Archive evidence bundles (retention policy)
	try {
		await archiveEvidence(directory, 30, 10);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		warnings.push(`Evidence retention archive failed: ${msg}`);
		console.warn('[close-command] archiveEvidence error:', error);
	}

	// ─── STAGE 3: CLEAN ──────────────────────────────────────────────
	let configBackupsRemoved = 0;
	const cleanedFiles: string[] = [];

	// Only delete active-state files that were successfully copied to the archive.
	// This prevents data loss when a partial archive succeeds for some files but
	// fails for others — only the backed-up files are safe to remove.
	if (archivedActiveStateFiles.size > 0) {
		for (const artifact of ACTIVE_STATE_TO_CLEAN) {
			if (!archivedActiveStateFiles.has(artifact)) {
				// This file was NOT successfully archived — do not delete it
				warnings.push(
					`Preserved ${artifact} because it was not successfully archived.`,
				);
				continue;
			}
			const filePath = path.join(swarmDir, artifact);
			try {
				await fs.unlink(filePath);
				cleanedFiles.push(artifact);
			} catch {
				// File may not exist
			}
		}
	} else {
		warnings.push(
			'Skipped active-state cleanup because no active-state files were archived. Files preserved to prevent data loss.',
		);
	}

	// Delete directories that were successfully archived
	// Uses archive-first-guard: only delete directories we confirmed are in the archive
	for (const dirName of ACTIVE_STATE_DIRS_TO_CLEAN) {
		if (!archivedActiveStateDirs.has(dirName)) {
			// Directory was NOT archived — do not delete
			continue;
		}
		const dirPath = path.join(swarmDir, dirName);
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
		const swarmFiles = await fs.readdir(swarmDir);
		const configBackups = swarmFiles.filter(
			(f) => f.startsWith('config-backup-') && f.endsWith('.json'),
		);
		for (const backup of configBackups) {
			try {
				await fs.unlink(path.join(swarmDir, backup));
				configBackupsRemoved++;
			} catch {
				// Per-file failure is non-blocking
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
				await fs.unlink(path.join(swarmDir, sibling));
			} catch {
				// Per-file failure is non-blocking
			}
		}
	} catch {
		// readdir failure is non-blocking
	}

	// Remove SWARM_PLAN checkpoint artifacts written by writeCheckpoint().
	// Cleans both the canonical .swarm/ location and any legacy root-level
	// artifacts from pre-7.0 sessions. These are redundant copies of
	// plan.json/plan.md (already archived) and should not be left behind.
	let swarmPlanFilesRemoved = 0;
	const candidates = [
		path.join(directory, '.swarm', 'SWARM_PLAN.json'),
		path.join(directory, '.swarm', 'SWARM_PLAN.md'),
		path.join(directory, 'SWARM_PLAN.json'),
		path.join(directory, 'SWARM_PLAN.md'),
	];
	for (const candidate of candidates) {
		try {
			await fs.unlink(candidate);
			swarmPlanFilesRemoved++;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				warnings.push(
					`Failed to remove ${path.basename(candidate)}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	// #519 (v6.71.1): clear persisted declare_scope files so the next session
	// starts without inherited scope. Scope files are ephemeral state; they are
	// not archived because they contain no forensic signal not already captured
	// by plan.json:files_touched.
	clearAllScopes(directory);

	// Reset context.md so new sessions start fresh
	const contextPath = path.join(swarmDir, 'context.md');
	const contextContent = [
		'# Context',
		'',
		'## Status',
		`Session closed after: ${projectName}`,
		`Closed: ${new Date().toISOString()}`,
		`Finalization: ${isForced ? 'forced' : planAlreadyDone ? 'plan-already-done' : 'normal'}`,
		'No active plan. Next session starts fresh.',
		'',
	].join('\n');
	try {
		await fs.writeFile(contextPath, contextContent, 'utf-8');
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		warnings.push(`Failed to reset context.md: ${msg}`);
		console.warn('[close-command] Failed to write context.md:', error);
	}

	// ─── STAGE 4: ALIGN ──────────────────────────────────────────────
	const pruneBranches = args.includes('--prune-branches');
	let gitAlignResult = '';
	const prunedBranches: string[] = [];

	const isGit = isGitRepo(directory);
	if (isGit) {
		// Try aggressive reset first (handles post-merge scenario with uncommitted changes)
		const aggressiveResult = resetToMainAfterMerge(directory, {
			pruneBranches,
		});
		if (aggressiveResult.success) {
			gitAlignResult = aggressiveResult.message;
			for (const w of aggressiveResult.warnings) {
				warnings.push(w);
			}
			if (aggressiveResult.changesDiscarded) {
				warnings.push(
					'Uncommitted changes were discarded during git alignment',
				);
			}
		} else {
			// Fallback to cautious reset (preserves uncommitted changes)
			const alignResult = resetToRemoteBranch(directory, { pruneBranches });
			gitAlignResult = alignResult.message;
			prunedBranches.push(...alignResult.prunedBranches);

			if (!alignResult.success) {
				warnings.push(`Git alignment: ${alignResult.message}`);
			}
			if (alignResult.alreadyAligned) {
				gitAlignResult = `Already aligned with ${alignResult.targetBranch}`;
			}
			for (const w of alignResult.warnings) {
				warnings.push(w);
			}
		}
	} else {
		gitAlignResult = 'Not a git repository — skipped git alignment';
	}

	// ─── WRITE CLOSE SUMMARY ─────────────────────────────────────────
	const closeSummaryPath = validateSwarmPath(directory, 'close-summary.md');

	const finalizationType = isForced
		? 'Forced closure'
		: planAlreadyDone
			? 'Plan already terminal — cleanup only'
			: 'Normal finalization';

	const summaryContent = [
		'# Swarm Close Summary',
		'',
		`**Project:** ${projectName}`,
		`**Closed:** ${new Date().toISOString()}`,
		`**Finalization:** ${finalizationType}`,
		'',
		'## Retrospective',
		!planExists
			? '_No plan — ad-hoc session_'
			: closedPhases.length > 0
				? closedPhases.map((id) => `- Phase ${id} closed`).join('\n')
				: '_No phases closed this run_',
		...(closedTasks.length > 0
			? [
					'',
					`**Tasks marked closed:** ${closedTasks.length}`,
					...closedTasks.map((id) => `- ${id}`),
				]
			: []),
		'',
		'## Lessons Committed',
		allLessons.length > 0 ? `| # | Lesson |` : '_No lessons committed_',
		...(allLessons.length > 0
			? ['| --- | --- |', ...allLessons.map((l, i) => `| ${i + 1} | ${l} |`)]
			: []),
		...(knowledgeSkillHint ? ['', knowledgeSkillHint] : []),
		...(runSkillReview
			? [
					'',
					'## Skill Review',
					skillReviewSummary || 'Skill review completed without details.',
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
		`- **Archive:** ${archiveResult}`,
		...(cleanedFiles.length > 0
			? [`- **Cleaned:** ${cleanedFiles.length} file(s)`]
			: []),
		'',
		'## Context',
		'- Reset context.md for next session',
		'- Cleared agent sessions and delegation chains',
		...(configBackupsRemoved > 0
			? [`- Removed ${configBackupsRemoved} stale config backup file(s)`]
			: []),
		...(swarmPlanFilesRemoved > 0
			? [`- Removed ${swarmPlanFilesRemoved} SWARM_PLAN checkpoint artifact(s)`]
			: []),
		...(planExists && !planAlreadyDone
			? ['- Set non-completed phases/tasks to closed status']
			: []),
		...(curationSucceeded && allLessons.length > 0
			? [`- Committed ${allLessons.length} lesson(s) to knowledge store`]
			: []),
		...(hivePromoted > 0
			? [`- Promoted ${hivePromoted} lesson(s) to hive knowledge`]
			: []),
		'',
		...(warnings.length > 0
			? ['## Warnings', ...warnings.map((w) => `- ${w}`), '']
			: []),
	].join('\n');

	try {
		await fs.writeFile(closeSummaryPath, summaryContent, 'utf-8');
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		warnings.push(`Failed to write close-summary.md: ${msg}`);
		console.warn('[close-command] Failed to write close-summary.md:', error);
	}

	// NOTE: writeCheckpoint is intentionally NOT called here. SWARM_PLAN.json and
	// SWARM_PLAN.md are redundant copies of plan.json/plan.md (already archived in
	// .swarm/archive/) and should not be written to the .swarm/ directory during close.
	// Stage 3 cleanup removes any pre-existing SWARM_PLAN artifacts from prior sessions.

	// Full session reset so subsequent /swarm invocations start from a clean slate.
	// Preserve plugin-init singletons that have no re-init path within the same
	// plugin lifetime:
	//   - opencodeClient: set once in src/index.ts at plugin init. Clearing it
	//     would leave downstream hooks (curator, full-auto-intercept) unable to
	//     reach the OpenCode client until the plugin reloads.
	//   - fullAutoEnabledInConfig: read from config at plugin init.
	//   - curatorInitAgentNames / curatorPhaseAgentNames: populated at plugin
	//     init from the built agent map. curator-llm-factory.ts depends on
	//     them at every curator call; clearing them would silently break the
	//     curator path until the plugin reloads.
	//   - skillImproverAgentNames: same plugin-init registry contract as the
	//     curator names, used to route prefixed multi-swarm skill reviews.
	const preservedClient = swarmState.opencodeClient;
	const preservedFullAutoFlag = swarmState.fullAutoEnabledInConfig;
	const preservedCuratorInitNames = swarmState.curatorInitAgentNames;
	const preservedCuratorPhaseNames = swarmState.curatorPhaseAgentNames;
	const preservedSkillImproverAgentNames = swarmState.skillImproverAgentNames;
	resetSwarmState();
	swarmState.opencodeClient = preservedClient;
	swarmState.fullAutoEnabledInConfig = preservedFullAutoFlag;
	swarmState.curatorInitAgentNames = preservedCuratorInitNames;
	swarmState.curatorPhaseAgentNames = preservedCuratorPhaseNames;
	swarmState.skillImproverAgentNames = preservedSkillImproverAgentNames;

	// Separate retro-specific warnings for prominent display
	const retroWarnings = warnings.filter(
		(w) =>
			w.includes('Retrospective write') ||
			w.includes('retrospective write') ||
			w.includes('Session retrospective'),
	);
	const otherWarnings = warnings.filter(
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
		curationSucceeded && allLessons.length > 0
			? `\n\n**Lessons Committed:** ${allLessons.length} lesson(s) committed to knowledge store`
			: '';
	const knowledgeHintSummary = knowledgeSkillHint
		? `\n\n**Knowledge Review:** ${knowledgeSkillHint}`
		: '';
	const skillReviewOutput = skillReviewSummary
		? `\n\n**Skill Review:** ${skillReviewSummary}`
		: '';

	if (planAlreadyDone) {
		return `✅ Session finalized. Plan was already in a terminal state — cleanup and archive applied.\n\n**Archive:** ${archiveResult}\n**Git:** ${gitAlignResult}${lessonSummary}${knowledgeHintSummary}${skillReviewOutput}${warningMsg}`;
	}
	return `✅ Swarm finalized. ${closedPhases.length} phase(s) closed, ${closedTasks.length} incomplete task(s) marked closed.\n\n**Archive:** ${archiveResult}\n**Git:** ${gitAlignResult}${lessonSummary}${knowledgeHintSummary}${skillReviewOutput}${warningMsg}`;
}

export const _internals = {
	countSessionKnowledgeEntries,
	CLOSE_SKILL_REVIEW_TIMEOUT_MS,
};
