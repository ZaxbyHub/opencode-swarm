import type { AgentDefinition } from '../agents';
import {
	extractCurrentPhase,
	extractCurrentPhaseFromPlan,
} from '../hooks/extractors';
import { readSwarmFileAsync } from '../hooks/utils';
import { loadPlan } from '../plan/manager';
import {
	hasActiveFullAuto,
	hasActiveLeanTurbo,
	hasActiveTurboMode,
	swarmState,
} from '../state';
import { loadLeanTurboRunState } from '../turbo/lean/state';
import { getCompactionMetrics } from './compaction-service';
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from './context-budget-service';

/**
 * Dependency-injection seam for status-service.
 * Allows tests to intercept Lean Turbo state queries without mock.module leakage.
 */
export const _internals = {
	loadLeanTurboRunState,
	hasActiveLeanTurbo,
	hasActiveFullAuto,
};

/**
 * Structured status data returned by the status service.
 * This can be used by GUI, background flows, or command adapters.
 */
export interface StatusData {
	hasPlan: boolean;
	currentPhase: string;
	completedTasks: number;
	totalTasks: number;
	agentCount: number;
	isLegacy: boolean;
	turboMode: boolean;
	/** Lean Turbo strategy: 'lean', 'standard', or 'off' */
	turboStrategy?: 'standard' | 'lean' | 'off';
	/** Lean Turbo phase number, if Lean Turbo is active */
	leanTurboPhase?: number;
	/** Number of lanes currently in 'running' status */
	leanActiveLaneCount?: number;
	/** Max parallel coders configured for Lean Turbo */
	leanMaxParallelCoders?: number;
	/** Number of lanes completed */
	leanCompletedLanes?: number;
	/** Number of tasks marked as degraded */
	leanDegradedTasks?: number;
	/** Human-readable degradation summary */
	leanDegradationSummary?: string;
	/** Whether Full-Auto mode is currently active */
	fullAutoActive?: boolean;
	/** Reason for pause if Lean Turbo is paused */
	leanPauseReason?: string;
	/** Last known context budget percentage (0-100), or null if not yet measured */
	contextBudgetPct: number | null;
	/** Number of context compaction events triggered this session */
	compactionCount: number;
	/** ISO timestamp of last compaction snapshot, or null if none */
	lastSnapshotAt: string | null;
}

/**
 * Get status data from the swarm directory.
 * Returns structured data that can be used by GUI, background flows, or commands.
 */
export async function getStatusData(
	directory: string,
	agents: Record<string, AgentDefinition>,
): Promise<StatusData> {
	// Try structured plan first
	const plan = await loadPlan(directory);

	let status: StatusData;

	if (plan && plan.migration_status !== 'migration_failed') {
		const currentPhase = extractCurrentPhaseFromPlan(plan) || 'Unknown';

		// Count tasks across all phases
		let completedTasks = 0;
		let totalTasks = 0;
		for (const phase of plan.phases) {
			for (const task of phase.tasks) {
				totalTasks++;
				if (task.status === 'completed') completedTasks++;
			}
		}

		const agentCount = Object.keys(agents).length;
		const metrics = getCompactionMetrics();

		status = {
			hasPlan: true,
			currentPhase,
			completedTasks,
			totalTasks,
			agentCount,
			isLegacy: false,
			turboMode: hasActiveTurboMode(),
			contextBudgetPct:
				swarmState.lastBudgetPct > 0 ? swarmState.lastBudgetPct : null,
			compactionCount: metrics.compactionCount,
			lastSnapshotAt: metrics.lastSnapshotAt,
		};
	} else {
		// Legacy fallback (existing code)
		const planContent = await readSwarmFileAsync(directory, 'plan.md');
		if (!planContent) {
			const metrics = getCompactionMetrics();
			status = {
				hasPlan: false,
				currentPhase: 'Unknown',
				completedTasks: 0,
				totalTasks: 0,
				agentCount: Object.keys(agents).length,
				isLegacy: true,
				turboMode: hasActiveTurboMode(),
				contextBudgetPct:
					swarmState.lastBudgetPct > 0 ? swarmState.lastBudgetPct : null,
				compactionCount: metrics.compactionCount,
				lastSnapshotAt: metrics.lastSnapshotAt,
			};
		} else {
			const currentPhase = extractCurrentPhase(planContent) || 'Unknown';
			const completedTasks = (planContent.match(/^- \[x\]/gm) || []).length;
			const incompleteTasks = (planContent.match(/^- \[ \]/gm) || []).length;
			const totalTasks = completedTasks + incompleteTasks;
			const agentCount = Object.keys(agents).length;
			const metrics = getCompactionMetrics();

			status = {
				hasPlan: true,
				currentPhase,
				completedTasks,
				totalTasks,
				agentCount,
				isLegacy: true,
				turboMode: hasActiveTurboMode(),
				contextBudgetPct:
					swarmState.lastBudgetPct > 0 ? swarmState.lastBudgetPct : null,
				compactionCount: metrics.compactionCount,
				lastSnapshotAt: metrics.lastSnapshotAt,
			};
		}
	}

	// Enrich with Lean Turbo data if active
	return enrichWithLeanTurbo(status, directory);
}

/**
 * Enrich status data with Lean Turbo information if Lean Turbo is active.
 */
function enrichWithLeanTurbo(
	status: StatusData,
	directory: string,
): StatusData {
	const turboMode = hasActiveTurboMode();
	const leanActive = _internals.hasActiveLeanTurbo();

	// Determine turbo strategy
	let turboStrategy: 'standard' | 'lean' | 'off' = 'off';
	if (leanActive) {
		turboStrategy = 'lean';
	} else if (turboMode) {
		turboStrategy = 'standard';
	}

	status.turboStrategy = turboStrategy;

	if (!leanActive) {
		return status;
	}

	// Find the session ID with Lean Turbo active
	let leanSessionID: string | null = null;
	for (const [sessionId, session] of swarmState.agentSessions) {
		if (session.turboStrategy === 'lean' && session.leanTurboActive === true) {
			leanSessionID = sessionId;
			break;
		}
	}

	// Load Lean Turbo run state if we found an active session
	if (leanSessionID) {
		const runState = _internals.loadLeanTurboRunState(directory, leanSessionID);

		if (runState) {
			status.leanTurboPhase = runState.phase;
			status.leanMaxParallelCoders = runState.maxParallelCoders;
			status.leanPauseReason = runState.pauseReason;

			// Count active and completed lanes
			if (!Array.isArray(runState.lanes)) {
				runState.lanes = [];
			}
			let activeLanes = 0;
			let completedLanes = 0;
			for (const lane of runState.lanes) {
				if (lane.status === 'running') activeLanes++;
				if (lane.status === 'completed') completedLanes++;
			}
			status.leanActiveLaneCount = activeLanes;
			status.leanCompletedLanes = completedLanes;

			// Track degraded tasks
			if (!Array.isArray(runState.degradedTasks)) {
				runState.degradedTasks = [];
				status.leanDegradedTasks = 0;
			}
			if (runState.degradedTasks.length > 0) {
				status.leanDegradedTasks = runState.degradedTasks.length;
				// Build degradation summary
				const summaryParts: string[] = [];
				for (const dt of runState.degradedTasks) {
					summaryParts.push(`${dt.taskId} (${dt.reason})`);
				}
				status.leanDegradationSummary = summaryParts.join('; ');
			}
		}
	}

	// Check Full-Auto status
	status.fullAutoActive = _internals.hasActiveFullAuto();

	return status;
}

/**
 * Format status data as markdown for command output.
 * This is the thin adapter that delegates to the service.
 */
export function formatStatusMarkdown(status: StatusData): string {
	const lines = [
		'## Swarm Status',
		'',
		`**Current Phase**: ${status.currentPhase}`,
		`**Tasks**: ${status.completedTasks}/${status.totalTasks} complete`,
		`**Agents**: ${status.agentCount} registered`,
	];

	// Turbo status display - strategy-specific
	if (status.turboStrategy && status.turboStrategy !== 'off') {
		lines.push('');
		if (status.turboStrategy === 'lean') {
			const parts: string[] = ['lean'];
			if (status.leanTurboPhase !== undefined) {
				parts.push(`Phase ${status.leanTurboPhase}`);
			}
			if (status.leanActiveLaneCount !== undefined) {
				const totalLanes =
					(status.leanActiveLaneCount ?? 0) + (status.leanCompletedLanes ?? 0);
				parts.push(`${status.leanActiveLaneCount}/${totalLanes} lanes active`);
			}
			if (
				status.leanDegradedTasks !== undefined &&
				status.leanDegradedTasks > 0
			) {
				parts.push(`${status.leanDegradedTasks} degraded`);
			}
			lines.push(`**Turbo**: ${parts.join(', ')}`);

			if (status.leanDegradationSummary) {
				lines.push(`  - ${status.leanDegradationSummary}`);
			}

			// Show pause reason if paused
			if (status.leanPauseReason) {
				lines.push(`**Lean paused**: ${status.leanPauseReason}`);
			}
		} else {
			lines.push(`**Turbo**: standard`);
		}

		// Show Full-Auto status if active
		if (status.fullAutoActive) {
			lines.push(`**Full-Auto**: active`);
		}
	} else if (status.turboStrategy === undefined && status.turboMode === true) {
		// Backward-compatibility: callers that only set turboMode (no turboStrategy) get the old format
		lines.push('');
		lines.push('**TURBO MODE**: active');
	}

	if (status.contextBudgetPct !== null && status.contextBudgetPct > 0) {
		const pct = status.contextBudgetPct.toFixed(1);
		const budgetTokens = DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens;
		const est = Math.round((status.contextBudgetPct / 100) * budgetTokens);
		lines.push(
			'',
			`**Context**: ${pct}% used (est. ${est.toLocaleString()} / ${budgetTokens.toLocaleString()} tokens)`,
		);
		if (status.compactionCount > 0) {
			lines.push(`**Compaction events**: ${status.compactionCount} triggered`);
		}
		if (status.lastSnapshotAt) {
			lines.push(`**Last snapshot**: ${status.lastSnapshotAt}`);
		}
	}

	return lines.join('\n');
}

/**
 * Handle status command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export async function handleStatusCommand(
	directory: string,
	agents: Record<string, AgentDefinition>,
): Promise<string> {
	const statusData = await getStatusData(directory, agents);

	if (!statusData.hasPlan) {
		return 'No active swarm plan found.';
	}

	return formatStatusMarkdown(statusData);
}
