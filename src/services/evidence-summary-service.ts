/**
 * Evidence Summary Service
 *
 * Provides deterministic evidence aggregation per task and phase.
 * Produces machine-readable and human-readable summary artifacts.
 */

import type {
	Evidence,
	EvidenceBundle,
	EvidenceType,
} from '../config/evidence-schema';
import type {
	Phase,
	PhaseStatus,
	Task,
	TaskStatus,
} from '../config/plan-schema';
import { listEvidenceTaskIds, loadEvidence } from '../evidence/manager';
import { loadPlanJsonOnly } from '../plan/manager';
import { log } from '../utils';

/** Valid evidence types */
const VALID_EVIDENCE_TYPES: Set<string> = new Set([
	'review',
	'test',
	'diff',
	'approval',
	'note',
	'retrospective',
]);

/**
 * Safely normalize evidence bundle entries to a valid array.
 * Handles null, undefined, non-array, and invalid entry objects.
 * Returns only valid entries with required fields.
 */
function normalizeBundleEntries(
	bundle: EvidenceBundle | null | undefined,
): Evidence[] {
	// Fail-safe: treat missing/null bundle as empty
	if (!bundle) {
		return [];
	}

	// Fail-safe: ensure entries is an array
	const entries = bundle.entries;
	if (!Array.isArray(entries)) {
		return [];
	}

	// Filter out null, undefined, and invalid entries
	const validEntries: Evidence[] = [];
	for (const entry of entries) {
		// Skip null or undefined entries
		if (entry === null || entry === undefined) {
			continue;
		}

		// Skip entries that are not objects
		if (typeof entry !== 'object') {
			continue;
		}

		// Skip entries missing required base fields
		const typedEntry = entry as Partial<Evidence>;
		if (!typedEntry.type || !VALID_EVIDENCE_TYPES.has(typedEntry.type)) {
			continue;
		}

		if (!typedEntry.task_id || !typedEntry.timestamp || !typedEntry.agent) {
			continue;
		}

		if (!typedEntry.verdict || !typedEntry.summary) {
			continue;
		}

		// Entry is valid
		validEntries.push(typedEntry as Evidence);
	}

	return validEntries;
}

/** Evidence types required for task completion */
export const REQUIRED_EVIDENCE_TYPES = ['review', 'test'] as const;
export type RequiredEvidenceType = (typeof REQUIRED_EVIDENCE_TYPES)[number];

/** Summary artifact schema version */
export const EVIDENCE_SUMMARY_VERSION = '1.0.0';

/** Evidence summary for a single task */
export interface TaskEvidenceSummary {
	taskId: string;
	phase: number;
	taskStatus: TaskStatus;
	evidenceCount: number;
	hasReview: boolean;
	hasTest: boolean;
	hasApproval: boolean;
	missingEvidence: string[];
	isComplete: boolean;
	blockers: string[];
	lastEvidenceTimestamp: string | null;
}

/** Phase evidence summary */
export interface PhaseEvidenceSummary {
	phaseId: number;
	phaseName: string;
	phaseStatus: PhaseStatus;
	totalTasks: number;
	completedTasks: number;
	tasksWithEvidence: number;
	tasksWithCompleteEvidence: number;
	completionRatio: number;
	missingEvidenceByType: Record<string, string[]>;
	blockers: PhaseBlocker[];
	tasks: TaskEvidenceSummary[];
}

/** Blockers preventing phase closure */
export interface PhaseBlocker {
	type: 'missing_evidence' | 'incomplete_task' | 'blocked_task';
	taskId: string;
	reason: string;
	severity: 'high' | 'medium' | 'low';
}

/** Full evidence summary artifact */
export interface EvidenceSummaryArtifact {
	schema_version: typeof EVIDENCE_SUMMARY_VERSION;
	generated_at: string;
	planTitle: string;
	currentPhase: number;
	phaseSummaries: PhaseEvidenceSummary[];
	overallCompletionRatio: number;
	overallBlockers: PhaseBlocker[];
	// Human-readable summary
	summaryText: string;
}

/**
 * Get task status from plan or infer from evidence
 */
function getTaskStatus(
	task: Task | undefined,
	bundle: EvidenceBundle | null,
): TaskStatus {
	if (task?.status) {
		return task.status;
	}
	// Infer from evidence presence - use normalized entries for safety
	const entries = _internals.normalizeBundleEntries(bundle);
	if (entries.length > 0) {
		return 'completed';
	}
	return 'pending';
}

/**
 * Check if evidence meets completion criteria for a task
 */
function isEvidenceComplete(bundle: EvidenceBundle | null): {
	isComplete: boolean;
	missingEvidence: string[];
} {
	// Use normalized entries for safety
	const entries = _internals.normalizeBundleEntries(bundle);
	if (entries.length === 0) {
		return {
			isComplete: false,
			missingEvidence: [...REQUIRED_EVIDENCE_TYPES],
		};
	}

	const typesPresent = new Set<EvidenceType>(entries.map((e) => e.type));
	const missing: string[] = [];

	for (const required of REQUIRED_EVIDENCE_TYPES) {
		if (!typesPresent.has(required)) {
			missing.push(required);
		}
	}

	return {
		isComplete: missing.length === 0,
		missingEvidence: missing,
	};
}

/**
 * Generate blockers for a task based on evidence and status
 */
function getTaskBlockers(
	task: Task | undefined,
	summary: ReturnType<typeof isEvidenceComplete>,
	status: TaskStatus,
): string[] {
	const blockers: string[] = [];

	if (task?.blocked_reason) {
		blockers.push(task.blocked_reason);
	}

	if (status === 'blocked') {
		blockers.push('Task is marked as blocked');
	}

	if (summary.missingEvidence.length > 0 && status !== 'pending') {
		blockers.push(`Missing evidence: ${summary.missingEvidence.join(', ')}`);
	}

	return blockers;
}

/**
 * Build evidence summary for a single task
 */
async function buildTaskSummary(
	directory: string,
	task: Task | undefined,
	taskId: string,
): Promise<TaskEvidenceSummary> {
	const result = await loadEvidence(directory, taskId);
	const bundle = result.status === 'found' ? result.bundle : null;
	const phase = task?.phase ?? 0;
	const status = _internals.getTaskStatus(task, bundle);
	const evidenceCheck = _internals.isEvidenceComplete(bundle);
	const blockers = _internals.getTaskBlockers(task, evidenceCheck, status);

	// Use normalized entries for safety
	const entries = _internals.normalizeBundleEntries(bundle);

	// Determine evidence presence
	const hasReview = entries.some((e) => e.type === 'review');
	const hasTest = entries.some((e) => e.type === 'test');
	const hasApproval = entries.some((e) => e.type === 'approval');

	// Get last evidence timestamp
	let lastTimestamp: string | null = null;
	if (entries.length > 0) {
		const timestamps = entries
			.map((e) => e.timestamp)
			.sort()
			.reverse();
		lastTimestamp = timestamps[0] ?? null;
	}

	return {
		taskId,
		phase,
		taskStatus: status,
		evidenceCount: entries.length,
		hasReview,
		hasTest,
		hasApproval,
		missingEvidence: evidenceCheck.missingEvidence,
		isComplete: evidenceCheck.isComplete && status === 'completed',
		blockers,
		lastEvidenceTimestamp: lastTimestamp,
	};
}

/**
 * Build evidence summary for a single phase
 */
async function buildPhaseSummary(
	directory: string,
	phase: Phase,
): Promise<PhaseEvidenceSummary> {
	const taskIds = await listEvidenceTaskIds(directory);
	const phaseTaskIds = new Set(phase.tasks.map((t) => t.id));

	// Build summaries for all tasks in phase (including those without evidence)
	const taskSummaries: TaskEvidenceSummary[] = [];
	const _taskMap = new Map(phase.tasks.map((t) => [t.id, t]));

	for (const task of phase.tasks) {
		const summary = await _internals.buildTaskSummary(directory, task, task.id);
		taskSummaries.push(summary);
	}

	// Also include tasks that have evidence but aren't in the plan
	const extraTaskIds = taskIds.filter((id) => !phaseTaskIds.has(id));
	for (const taskId of extraTaskIds) {
		const summary = await _internals.buildTaskSummary(
			directory,
			undefined,
			taskId,
		);
		if (summary.phase === phase.id) {
			taskSummaries.push(summary);
		}
	}

	// Calculate phase metrics
	const completedTasks = taskSummaries.filter(
		(s) => s.taskStatus === 'completed',
	).length;
	const tasksWithEvidence = taskSummaries.filter(
		(s) => s.evidenceCount > 0,
	).length;
	const tasksWithCompleteEvidence = taskSummaries.filter(
		(s) => s.isComplete,
	).length;

	// Aggregate missing evidence by type
	const missingByType: Record<string, string[]> = {};
	for (const summary of taskSummaries) {
		for (const missing of summary.missingEvidence) {
			if (!missingByType[missing]) {
				missingByType[missing] = [];
			}
			if (!missingByType[missing]!.includes(summary.taskId)) {
				missingByType[missing]!.push(summary.taskId);
			}
		}
	}

	// Build phase blockers
	const phaseBlockers: PhaseBlocker[] = [];

	// Missing evidence blockers
	for (const [type, taskIds] of Object.entries(missingByType)) {
		phaseBlockers.push({
			type: 'missing_evidence',
			taskId: taskIds.join(', '),
			reason: `${type} evidence missing for ${taskIds.length} task(s)`,
			severity: 'high',
		});
	}

	// Incomplete task blockers
	const incomplete = taskSummaries.filter(
		(s) => s.taskStatus === 'completed' && !s.isComplete,
	);
	for (const task of incomplete) {
		phaseBlockers.push({
			type: 'incomplete_task',
			taskId: task.taskId,
			reason: 'Task marked complete but missing required evidence',
			severity: 'medium',
		});
	}

	// Blocked task blockers
	// Consider a task blocked if: status is 'blocked' OR has blocked_reason in task blockers
	const blocked = taskSummaries.filter(
		(s) => s.taskStatus === 'blocked' || s.blockers.length > 0,
	);
	for (const task of blocked) {
		phaseBlockers.push({
			type: 'blocked_task',
			taskId: task.taskId,
			reason: task.blockers.join('; ') || 'Task is blocked',
			severity: 'high',
		});
	}

	return {
		phaseId: phase.id,
		phaseName: phase.name,
		phaseStatus: phase.status,
		totalTasks: phase.tasks.length,
		completedTasks,
		tasksWithEvidence,
		tasksWithCompleteEvidence,
		completionRatio:
			phase.tasks.length > 0 ? completedTasks / phase.tasks.length : 0,
		missingEvidenceByType: missingByType,
		blockers: phaseBlockers,
		tasks: taskSummaries,
	};
}

/**
 * Generate human-readable summary text
 */
function generateSummaryText(artifact: EvidenceSummaryArtifact): string {
	const lines: string[] = [];

	lines.push(`Evidence Summary for "${artifact.planTitle}"`);
	lines.push(`Generated: ${new Date(artifact.generated_at).toISOString()}`);
	lines.push('');
	lines.push(
		`Overall Completion: ${(artifact.overallCompletionRatio * 100).toFixed(1)}%`,
	);
	lines.push(`Current Phase: ${artifact.currentPhase}`);
	lines.push('');

	for (const phase of artifact.phaseSummaries) {
		lines.push(`## Phase ${phase.phaseId}: ${phase.phaseName}`);
		lines.push(
			`  Tasks: ${phase.completedTasks}/${phase.totalTasks} completed (${(phase.completionRatio * 100).toFixed(1)}%)`,
		);
		lines.push(
			`  Evidence: ${phase.tasksWithCompleteEvidence}/${phase.totalTasks} complete`,
		);

		if (phase.blockers.length > 0) {
			lines.push('  Blockers:');
			for (const blocker of phase.blockers) {
				lines.push(`    - [${blocker.severity}] ${blocker.reason}`);
			}
		}
		lines.push('');
	}

	if (artifact.overallBlockers.length > 0) {
		lines.push('## Overall Blockers');
		for (const blocker of artifact.overallBlockers) {
			lines.push(`- [${blocker.severity}] ${blocker.reason}`);
		}
	}

	return lines.join('\n');
}

/**
 * Build complete evidence summary artifact
 *
 * Aggregates evidence per task and phase, producing deterministic
 * summary artifacts including completion ratio, missing evidence,
 * blockers, and per-task status.
 */
export async function buildEvidenceSummary(
	directory: string,
	currentPhase?: number,
): Promise<EvidenceSummaryArtifact | null> {
	log('[EvidenceSummary] Building summary for directory', { directory });

	// Load plan
	const plan = await loadPlanJsonOnly(directory);
	if (!plan) {
		log('[EvidenceSummary] No plan found, skipping summary generation');
		return null;
	}

	// Determine phases to summarize
	const phasesToProcess =
		currentPhase !== undefined
			? plan.phases.filter((p) => p.id <= currentPhase)
			: plan.phases;

	// Build phase summaries
	const phaseSummaries: PhaseEvidenceSummary[] = [];
	let totalTasks = 0;
	let completedTasks = 0;

	for (const phase of phasesToProcess) {
		// Create a mock directory context for buildPhaseSummary
		const summary = await _internals.buildPhaseSummary(directory, phase);
		phaseSummaries.push(summary);
		totalTasks += summary.totalTasks;
		completedTasks += summary.completedTasks;
	}

	// Calculate overall metrics
	const overallCompletionRatio =
		totalTasks > 0 ? completedTasks / totalTasks : 0;

	// Collect overall blockers
	const overallBlockers: PhaseBlocker[] = [];
	for (const phase of phaseSummaries) {
		if (phase.phaseStatus !== 'complete') {
			overallBlockers.push(...phase.blockers);
		}
	}

	const artifact: EvidenceSummaryArtifact = {
		schema_version: EVIDENCE_SUMMARY_VERSION,
		generated_at: new Date().toISOString(),
		planTitle: plan.title,
		currentPhase: currentPhase ?? plan.current_phase ?? 1,
		phaseSummaries,
		overallCompletionRatio,
		overallBlockers,
		summaryText: '', // Will be set below
	};

	// Generate human-readable summary
	artifact.summaryText = _internals.generateSummaryText(artifact);

	log('[EvidenceSummary] Summary built', {
		phases: phaseSummaries.length,
		totalTasks,
		completedTasks,
		completionRatio: overallCompletionRatio,
		blockers: overallBlockers.length,
	});

	return artifact;
}

/**
 * Check if auto-summaries are enabled via feature flags
 */
export function isAutoSummaryEnabled(automationConfig?: {
	capabilities?: { evidence_auto_summaries?: boolean };
	mode?: string;
}): boolean {
	// Fail-safe: return false if config is missing
	if (!automationConfig) {
		return false;
	}

	// If mode is manual, auto-summaries are disabled
	if (automationConfig.mode === 'manual') {
		return false;
	}

	// Check the explicit capability flag
	return automationConfig.capabilities?.evidence_auto_summaries === true;
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	buildEvidenceSummary: typeof buildEvidenceSummary;
	isAutoSummaryEnabled: typeof isAutoSummaryEnabled;
	normalizeBundleEntries: typeof normalizeBundleEntries;
	getTaskStatus: typeof getTaskStatus;
	isEvidenceComplete: typeof isEvidenceComplete;
	getTaskBlockers: typeof getTaskBlockers;
	buildTaskSummary: typeof buildTaskSummary;
	buildPhaseSummary: typeof buildPhaseSummary;
	generateSummaryText: typeof generateSummaryText;
} = {
	buildEvidenceSummary,
	isAutoSummaryEnabled,
	normalizeBundleEntries,
	getTaskStatus,
	isEvidenceComplete,
	getTaskBlockers,
	buildTaskSummary,
	buildPhaseSummary,
	generateSummaryText,
} as const;
