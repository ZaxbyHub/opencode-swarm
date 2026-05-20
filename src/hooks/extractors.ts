import type { Plan } from '../config/plan-schema';

/**
 * Swarm File Extractors
 *
 * Pure parsing functions for extracting structured data from .swarm/ files.
 * Used by system-enhancer and compaction-customizer hooks.
 */

/**
 * Extracts the current phase information from plan content.
 */
export function extractCurrentPhase(planContent: string): string | null {
	if (!planContent) {
		return null;
	}

	const lines = planContent.split('\n');

	// Look for IN PROGRESS phase in the first 20 lines
	for (let i = 0; i < Math.min(20, lines.length); i++) {
		const line = lines[i].trim();
		const progressMatch = line.match(
			/^## Phase (\d+):?\s*(.*?)\s*\[IN PROGRESS\]/i,
		);
		if (progressMatch) {
			const phaseNum = progressMatch[1];
			const description = progressMatch[2]?.trim() || '';
			return `Phase ${phaseNum}: ${description} [IN PROGRESS]`;
		}
	}

	// Look for Phase: N in the first 3 lines (header)
	for (let i = 0; i < Math.min(3, lines.length); i++) {
		const line = lines[i].trim();
		const phaseMatch = line.match(/Phase:\s*(\d+)/i);
		if (phaseMatch) {
			const phaseNum = phaseMatch[1];
			return `Phase ${phaseNum} [PENDING]`;
		}
	}

	return null;
}

/**
 * Extracts the first incomplete task from the current IN PROGRESS phase.
 */
export function extractCurrentTask(planContent: string): string | null {
	if (!planContent) {
		return null;
	}

	const lines = planContent.split('\n');
	let inCurrentPhase = false;

	for (const line of lines) {
		// Find the IN PROGRESS phase
		if (line.startsWith('## ') && /\[IN PROGRESS\]/i.test(line)) {
			inCurrentPhase = true;
			continue;
		}

		if (inCurrentPhase) {
			// Stop at the next phase heading or horizontal rule
			if (line.startsWith('## ') || line.trim() === '---') {
				break;
			}
			// Find the first incomplete task
			if (line.trim().startsWith('- [ ]')) {
				return line.trim();
			}
		}
	}

	return null;
}

/**
 * Extracts decisions section from context content.
 */
export function extractDecisions(
	contextContent: string,
	maxChars: number = 500,
): string | null {
	if (!contextContent) {
		return null;
	}

	const lines = contextContent.split('\n');
	let decisionsText = '';
	let inDecisionsSection = false;

	for (const line of lines) {
		if (line.trim() === '## Decisions') {
			inDecisionsSection = true;
			continue;
		}

		if (inDecisionsSection) {
			if (line.startsWith('## ')) {
				// Reached next section
				break;
			}
			if (line.startsWith('- ')) {
				decisionsText += `${line}\n`;
			}
		}
	}

	if (!decisionsText.trim()) {
		return null;
	}

	// Truncate to maxChars and clean up
	const trimmed = decisionsText.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	return `${trimmed.slice(0, maxChars)}...`;
}

/**
 * Extracts incomplete tasks from plan content under the current IN PROGRESS phase.
 */
export function extractIncompleteTasks(
	planContent: string,
	maxChars: number = 500,
): string | null {
	if (!planContent) {
		return null;
	}

	const lines = planContent.split('\n');
	let tasksText = '';
	let inCurrentPhase = false;

	for (const line of lines) {
		// Find the IN PROGRESS phase
		if (line.startsWith('## ') && /\[IN PROGRESS\]/i.test(line)) {
			inCurrentPhase = true;
			continue;
		}

		if (inCurrentPhase) {
			// Stop at the next phase heading or horizontal rule
			if (line.startsWith('## ') || line.trim() === '---') {
				break;
			}
			// Collect incomplete tasks (- [ ] lines)
			if (line.trim().startsWith('- [ ]')) {
				tasksText += `${line.trim()}\n`;
			}
		}
	}

	if (!tasksText.trim()) {
		return null;
	}

	const trimmed = tasksText.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	return `${trimmed.slice(0, maxChars)}...`;
}

/**
 * Extracts patterns section from context content.
 */
export function extractPatterns(
	contextContent: string,
	maxChars: number = 500,
): string | null {
	if (!contextContent) {
		return null;
	}

	const lines = contextContent.split('\n');
	let patternsText = '';
	let inPatternsSection = false;

	for (const line of lines) {
		if (line.trim() === '## Patterns') {
			inPatternsSection = true;
			continue;
		}

		if (inPatternsSection) {
			if (line.startsWith('## ')) {
				break;
			}
			if (line.startsWith('- ')) {
				patternsText += `${line}\n`;
			}
		}
	}

	if (!patternsText.trim()) {
		return null;
	}

	const trimmed = patternsText.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}

	return `${trimmed.slice(0, maxChars)}...`;
}

/**
 * Extracts current phase info from a Plan object.
 */
export function extractCurrentPhaseFromPlan(plan: Plan): string | null {
	const phase = plan.phases.find((p) => p.id === plan.current_phase);
	if (!phase) return null;

	const statusMap: Record<string, string> = {
		pending: 'PENDING',
		in_progress: 'IN PROGRESS',
		complete: 'COMPLETE',
		blocked: 'BLOCKED',
	};
	const statusText = statusMap[phase.status] || 'PENDING';
	return `Phase ${phase.id}: ${phase.name} [${statusText}]`;
}

/**
 * Extracts the first incomplete task from the current phase of a Plan object.
 */
export function extractCurrentTaskFromPlan(plan: Plan): string | null {
	const phase = plan.phases.find((p) => p.id === plan.current_phase);
	if (!phase) return null;

	// Find first in_progress task, or first pending task
	const inProgress = phase.tasks.find((t) => t.status === 'in_progress');
	if (inProgress) {
		const deps =
			inProgress.depends.length > 0
				? ` (depends: ${inProgress.depends.join(', ')})`
				: '';
		return `- [ ] ${inProgress.id}: ${inProgress.description} [${inProgress.size.toUpperCase()}]${deps} ← CURRENT`;
	}

	const pending = phase.tasks.find((t) => t.status === 'pending');
	if (pending) {
		const deps =
			pending.depends.length > 0
				? ` (depends: ${pending.depends.join(', ')})`
				: '';
		return `- [ ] ${pending.id}: ${pending.description} [${pending.size.toUpperCase()}]${deps}`;
	}

	return null;
}

/**
 * Extracts incomplete tasks from the current phase of a Plan object.
 */
export function extractIncompleteTasksFromPlan(
	plan: Plan,
	maxChars: number = 500,
): string | null {
	const phase = plan.phases.find((p) => p.id === plan.current_phase);
	if (!phase) return null;

	const incomplete = phase.tasks.filter(
		(t) => t.status === 'pending' || t.status === 'in_progress',
	);
	if (incomplete.length === 0) return null;

	const lines = incomplete.map((t) => {
		const deps =
			t.depends.length > 0 ? ` (depends: ${t.depends.join(', ')})` : '';
		const marker = t.status === 'in_progress' ? ' ← CURRENT' : '';
		return `- [ ] ${t.id}: ${t.description} [${t.size.toUpperCase()}]${deps}${marker}`;
	});

	const text = lines.join('\n');
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}...`;
}

/**
 * Extracts plan cursor - a concise summary of current phase, current task,
 * and lookahead tasks for context-aware agent communication.
 *
 * @param planContent - The raw plan markdown content
 * @param options - Optional configuration
 * @param options.maxTokens - Target max tokens (default 1500, ~6000 chars)
 * @param options.lookaheadTasks - Number of lookahead tasks (default 2)
 * @returns A [SWARM PLAN CURSOR] block with phase summaries and task details
 */
export function extractPlanCursor(
	planContent: string,
	options?: { maxTokens?: number; lookaheadTasks?: number },
): string {
	const maxTokens = options?.maxTokens ?? 1500;
	const maxChars = maxTokens * 4; // ~4 chars per token
	const lookaheadCount = options?.lookaheadTasks ?? 2;

	// Handle null/undefined/empty input
	if (!planContent || typeof planContent !== 'string') {
		return `[SWARM PLAN CURSOR]
No plan content available. Start by creating a .swarm/plan.md file.
[/SWARM PLAN CURSOR]`;
	}

	const lines = planContent.split('\n');
	const result: string[] = [];
	result.push('[SWARM PLAN CURSOR]');

	// Track phases
	const phases: Array<{
		number: number;
		title: string;
		status: 'COMPLETE' | 'IN PROGRESS' | 'PENDING';
		contentLines: string[];
	}> = [];

	let currentPhase: (typeof phases)[0] | null = null;
	let inPhase = false;

	// Parse phases from the content
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Detect phase header
		const phaseMatch = trimmed.match(
			/^## Phase (\d+):?\s*(.*?)\s*\[(COMPLETE|IN PROGRESS|PENDING|BLOCKED)\]/i,
		);
		if (phaseMatch) {
			// Save previous phase
			if (currentPhase) {
				phases.push(currentPhase);
			}

			const phaseNum = parseInt(phaseMatch[1], 10);
			const phaseTitle = phaseMatch[2]?.trim() || '';
			const status = phaseMatch[3].toUpperCase() as
				| 'COMPLETE'
				| 'IN PROGRESS'
				| 'PENDING';

			currentPhase = {
				number: phaseNum,
				title: phaseTitle,
				status: status,
				contentLines: [],
			};
			inPhase = true;
			continue;
		}

		// Stop at next phase or horizontal rule
		if (inPhase && (line.startsWith('## ') || trimmed === '---')) {
			if (currentPhase) {
				phases.push(currentPhase);
			}
			currentPhase = null;
			inPhase = false;
			continue;
		}

		// Collect content for current phase
		if (currentPhase && inPhase && trimmed) {
			currentPhase.contentLines.push(line);
		}
	}

	// Don't forget the last phase
	if (currentPhase) {
		phases.push(currentPhase);
	}

	if (phases.length === 0) {
		result.push('No phases found in plan.');
		result.push('[/SWARM PLAN CURSOR]');
		return result.join('\n');
	}

	// Find IN PROGRESS phase and COMPLETE phases
	const inProgressPhase = phases.find((p) => p.status === 'IN PROGRESS');
	const completePhases = phases.filter((p) => p.status === 'COMPLETE');
	const pendingPhases = phases.filter((p) => p.status === 'PENDING');

	// Output complete phases (earlier ones) - one-liners
	if (completePhases.length > 0) {
		// Get the last few complete phases (max 5 to stay under limit)
		const recentComplete = completePhases.slice(-5);

		// Check if there are even earlier phases
		if (completePhases.length > 5) {
			result.push('');
			result.push(`## Earlier Phases (${completePhases.length - 5} more)`);
			result.push(`- Phase 1-${completePhases.length - 5}: Complete`);
		}

		result.push('');
		result.push('## Completed Phases');
		for (const phase of recentComplete) {
			// Extract task summaries from content
			const taskLines = phase.contentLines
				.filter((l) => l.trim().startsWith('- ['))
				.map((l) =>
					l
						.replace(/^- \[[ xX]\]\s*/, '')
						.replace(/\s*\[.*?\]/g, '')
						.trim(),
				)
				.slice(0, 3); // Max 3 tasks per phase summary

			const taskSummary =
				taskLines.length > 0 ? taskLines.join(', ') : 'All tasks complete';

			result.push(`- Phase ${phase.number}: ${phase.title}`);
			result.push(`  - ${taskSummary}`);
		}
	}

	// Find incomplete tasks in IN PROGRESS phase (cached for reuse)
	const incompleteTasks = inProgressPhase
		? inProgressPhase.contentLines
				.filter((l) => l.trim().startsWith('- [ ]'))
				.map((l) => l.trim())
		: [];

	// Output IN PROGRESS phase with full details
	if (inProgressPhase) {
		result.push('');
		result.push(`## Phase ${inProgressPhase.number} [IN PROGRESS]`);
		result.push(`- ${inProgressPhase.title}`);

		if (incompleteTasks.length > 0) {
			// Current task (first incomplete)
			const currentTask = incompleteTasks[0];
			result.push('');
			result.push(`- Current: ${currentTask.replace('- [ ] ', '')}`);

			// Lookahead tasks
			const lookahead = incompleteTasks.slice(1, 1 + lookaheadCount);
			for (let i = 0; i < lookahead.length; i++) {
				result.push(`- Next: ${lookahead[i].replace('- [ ] ', '')}`);
			}
		} else {
			result.push('- (No pending tasks)');
		}
	}

	// Output next pending phase(s)
	const nextPending = pendingPhases[0];
	if (nextPending) {
		result.push('');
		result.push(`## Phase ${nextPending.number} [PENDING]`);
		result.push(`- ${nextPending.title}`);
	}

	// Trim to max chars
	let output = result.join('\n');
	output += '\n[/SWARM PLAN CURSOR]';

	// Trim to max chars - truncate task summaries more aggressively while maintaining structure
	if (output.length > maxChars) {
		// Rebuild with truncated task summaries but same structure
		const compactResult: string[] = [];
		compactResult.push('[SWARM PLAN CURSOR]');

		// Compact complete phases - fewer tasks
		if (completePhases.length > 0) {
			compactResult.push('## Completed Phases');
			const recentCompact = completePhases.slice(-3);
			for (const phase of recentCompact) {
				// Get only first task summary
				const taskLines = phase.contentLines
					.filter((l) => l.trim().startsWith('- ['))
					.map((l) =>
						l
							.replace(/^- \[[ xX]\]\s*/, '')
							.replace(/\s*\[.*?\]/g, '')
							.trim(),
					)
					.slice(0, 1);
				const taskSummary = taskLines.length > 0 ? taskLines[0] : 'Complete';
				compactResult.push(`- Phase ${phase.number}: ${taskSummary}`);
			}
			if (completePhases.length > 3) {
				compactResult.push(
					`- Earlier: Phase 1-${completePhases.length - 3} complete`,
				);
			}
		}

		// IN PROGRESS - reuse cached incompleteTasks
		if (inProgressPhase) {
			compactResult.push('');
			compactResult.push(`## Phase ${inProgressPhase.number} [IN PROGRESS]`);
			compactResult.push(`- ${inProgressPhase.title}`);

			if (incompleteTasks.length > 0) {
				// Truncate task text if needed
				const truncateTask = (task: string) => {
					const text = task.replace('- [ ] ', '');
					return text.length > 60 ? `${text.slice(0, 57)}...` : text;
				};

				compactResult.push(`- Current: ${truncateTask(incompleteTasks[0])}`);
				// Fewer lookahead tasks in compact mode
				const lookahead = incompleteTasks.slice(
					1,
					1 + Math.min(lookaheadCount, 1),
				);
				for (const task of lookahead) {
					compactResult.push(`- Next: ${truncateTask(task)}`);
				}
			} else {
				compactResult.push('- (No pending tasks)');
			}
		}

		// Next pending
		if (nextPending) {
			compactResult.push('');
			compactResult.push(`## Phase ${nextPending.number} [PENDING]`);
			compactResult.push(`- ${nextPending.title}`);
		}

		compactResult.push('[/SWARM PLAN CURSOR]');
		output = compactResult.join('\n');
	}

	return output;
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals: {
	extractCurrentPhase: typeof extractCurrentPhase;
	extractCurrentTask: typeof extractCurrentTask;
	extractDecisions: typeof extractDecisions;
	extractIncompleteTasks: typeof extractIncompleteTasks;
	extractPatterns: typeof extractPatterns;
	extractCurrentPhaseFromPlan: typeof extractCurrentPhaseFromPlan;
	extractCurrentTaskFromPlan: typeof extractCurrentTaskFromPlan;
	extractIncompleteTasksFromPlan: typeof extractIncompleteTasksFromPlan;
	extractPlanCursor: typeof extractPlanCursor;
} = {
	extractCurrentPhase,
	extractCurrentTask,
	extractDecisions,
	extractIncompleteTasks,
	extractPatterns,
	extractCurrentPhaseFromPlan,
	extractCurrentTaskFromPlan,
	extractIncompleteTasksFromPlan,
	extractPlanCursor,
};
