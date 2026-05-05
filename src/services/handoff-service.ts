/**
 * Handoff Service
 *
 * Provides structured handoff data for agent transitions between swarm sessions.
 * Reads from .swarm files to gather current state for context-efficient handoffs.
 */

import { readSwarmFileAsync } from '../hooks/utils';
import { loadPlanJsonOnly } from '../plan/manager';
import { log } from '../utils';

/**
 * RTL override character pattern for sanitization
 */
const RTL_OVERRIDE_PATTERN = /[\u202e\u202d\u202c\u200f]/g;

/**
 * Maximum length constants for security limits
 */
const MAX_TASK_ID_LENGTH = 100;
const MAX_DECISION_LENGTH = 500;
const MAX_INCOMPLETE_TASKS = 20;

/**
 * Escape HTML special characters to prevent XSS attacks
 */
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Sanitize string by removing RTL override characters and truncating to max length
 */
function sanitizeString(
	str: string | null | undefined,
	maxLength: number,
): string {
	if (!str) return '';
	const sanitized = String(str).replace(RTL_OVERRIDE_PATTERN, '');
	if (sanitized.length > maxLength) {
		return `${sanitized.substring(0, maxLength - 3)}...`;
	}
	return sanitized;
}

/**
 * Validated plan type
 */
interface ValidPlan {
	phases: Array<{
		id: number;
		name: string;
		tasks: Array<{ id: string; status: string }>;
	}>;
	current_phase: number | null;
}

/**
 * Validate that plan.phases is a proper array with valid phase objects
 */
function validatePlanPhases(plan: unknown): plan is ValidPlan {
	if (!plan || typeof plan !== 'object') return false;
	const p = plan as Record<string, unknown>;
	if (!Array.isArray(p.phases)) return false;

	// Validate each phase has required properties before accessing
	for (const phase of p.phases) {
		if (!phase || typeof phase !== 'object') return false;
		const phaseObj = phase as Record<string, unknown>;
		if (!Array.isArray(phaseObj.tasks)) return false;
	}

	return true;
}

/**
 * Pending QA state from agent sessions
 */
export interface PendingQA {
	taskId: string;
	lastFailure: string | null;
}

/**
 * Delegation chain entry
 */
export interface DelegationEntry {
	from: string;
	to: string;
	taskId: string;
	timestamp: number;
}

/**
 * Delegation state from session snapshot
 */
export interface DelegationState {
	activeChains: string[];
	delegationDepth: number;
	pendingHandoffs: string[];
}

/**
 * Structured handoff data for agent transitions
 */
export interface HandoffData {
	/** ISO timestamp when data was generated */
	generated: string;
	/** Current phase number or name */
	currentPhase: string | null;
	/** Current task ID being worked on */
	currentTask: string | null;
	/** List of incomplete task IDs */
	incompleteTasks: string[];
	/** Pending QA state */
	pendingQA: PendingQA | null;
	/** Active agent name */
	activeAgent: string | null;
	/** Recent decisions from context.md */
	recentDecisions: string[];
	/** Delegation state */
	delegationState: DelegationState | null;
	/** Locked execution_profile for this plan, if set. Resuming sessions must honour it. */
	execution_profile?: {
		parallelization_enabled: boolean;
		max_concurrent_tasks: number;
		council_parallel: boolean;
		locked: boolean;
	} | null;
}

/**
 * Extract current phase and task from plan
 */
function extractCurrentPhaseFromPlan(
	plan: Awaited<ReturnType<typeof loadPlanJsonOnly>>,
): {
	currentPhase: string | null;
	currentTask: string | null;
	incompleteTasks: string[];
} {
	if (!plan) {
		return { currentPhase: null, currentTask: null, incompleteTasks: [] };
	}

	// Validate plan.phases is an array before iteration (security fix)
	if (!_internals.validatePlanPhases(plan)) {
		return { currentPhase: null, currentTask: null, incompleteTasks: [] };
	}

	// Find current phase
	let currentPhase: string | null = null;
	const currentPhaseNum = plan.current_phase;

	if (currentPhaseNum) {
		const phase = plan.phases.find((p) => p.id === currentPhaseNum);
		currentPhase = phase ? `Phase ${phase.id}: ${phase.name}` : null;
	} else {
		// Fallback: find in_progress phase
		const inProgressPhase = plan.phases.find((p) => p.status === 'in_progress');
		if (inProgressPhase) {
			currentPhase = `Phase ${inProgressPhase.id}: ${inProgressPhase.name}`;
		} else if (plan.phases.length > 0) {
			currentPhase = `Phase ${plan.phases[0].id}: ${plan.phases[0].name}`;
		}
	}

	// Find current task (in_progress or first incomplete)
	let currentTask: string | null = null;
	const incompleteTasks: string[] = [];

	for (const phase of plan.phases) {
		for (const task of phase.tasks) {
			if (task.status === 'in_progress') {
				currentTask = sanitizeString(task.id, MAX_TASK_ID_LENGTH);
			}
			if (task.status !== 'completed') {
				// Apply sanitization and limit to MAX_INCOMPLETE_TASKS
				if (incompleteTasks.length < MAX_INCOMPLETE_TASKS) {
					incompleteTasks.push(sanitizeString(task.id, MAX_TASK_ID_LENGTH));
				}
			}
		}
	}

	// If no in_progress task, find first pending task
	if (!currentTask && incompleteTasks.length > 0) {
		currentTask = incompleteTasks[0];
	}

	return { currentPhase, currentTask, incompleteTasks };
}

/**
 * Parse session state JSON
 */
function parseSessionState(content: string | null): {
	activeAgent: string | null;
	delegationState: DelegationState | null;
	pendingQA: PendingQA | null;
} | null {
	if (!content) return null;

	try {
		const state = JSON.parse(content);

		// Extract active agent (with sanitization)
		let activeAgent: string | null = null;
		if (state.activeAgent && typeof state.activeAgent === 'object') {
			const entries = Object.entries(state.activeAgent);
			if (entries.length > 0) {
				activeAgent = sanitizeString(
					entries[entries.length - 1][1] as string,
					MAX_TASK_ID_LENGTH,
				);
			}
		}

		// Extract delegation chains (with sanitization)
		let delegationState: DelegationState | null = null;
		if (state.delegationChains && typeof state.delegationChains === 'object') {
			const chains = Object.entries(state.delegationChains);
			const activeChains: string[] = [];
			let maxDepth = 0;

			for (const [, chain] of chains) {
				if (Array.isArray(chain) && chain.length > 0) {
					// Sanitize delegation chain entries
					const sanitizedChain = chain
						.map(
							(e: DelegationEntry) =>
								`${sanitizeString(e.from, MAX_TASK_ID_LENGTH)}->${sanitizeString(e.to, MAX_TASK_ID_LENGTH)}`,
						)
						.join(' | ');
					activeChains.push(sanitizedChain);
					maxDepth = Math.max(maxDepth, chain.length);
				}
			}

			if (activeChains.length > 0) {
				delegationState = {
					activeChains,
					delegationDepth: maxDepth,
					pendingHandoffs: [],
				};
			}
		}

		// Extract pending QA from agent sessions (lastGateFailure) - with sanitization
		let pendingQA: PendingQA | null = null;
		if (state.agentSessions && typeof state.agentSessions === 'object') {
			for (const [, session] of Object.entries(state.agentSessions)) {
				const sess = session as {
					lastGateFailure: { taskId: string; tool: string } | null;
					currentTaskId: string | null;
				};
				if (sess.lastGateFailure && sess.currentTaskId) {
					pendingQA = {
						taskId: sanitizeString(
							sess.lastGateFailure.taskId,
							MAX_TASK_ID_LENGTH,
						),
						lastFailure: sanitizeString(
							sess.lastGateFailure.tool,
							MAX_TASK_ID_LENGTH,
						),
					};
					break;
				}
			}
		}

		return { activeAgent, delegationState, pendingQA };
	} catch (error) {
		log('[HandoffService] state extraction failed', {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Extract decisions from context.md content
 */
function extractDecisions(content: string | null): string[] {
	if (!content) return [];

	const decisions: string[] = [];
	const lines = content.split('\n');
	let inDecisionsSection = false;

	for (const line of lines) {
		// Start of decisions section
		if (line.trim() === '## Decisions') {
			inDecisionsSection = true;
			continue;
		}

		// End of decisions section
		if (
			inDecisionsSection &&
			line.startsWith('## ') &&
			line.trim() !== '## Decisions'
		) {
			break;
		}

		// Extract decision items
		if (inDecisionsSection && line.trim().startsWith('- ')) {
			const text = line.trim().substring(2);
			// Clean up the decision text
			const cleaned = text
				.replace(/\s*\[.*?\]\s*/g, '')
				.replace(/✅/g, '')
				.replace(/\[confirmed\]/g, '')
				.trim();
			if (cleaned) {
				// Apply RTL sanitization and length limit
				const sanitized = sanitizeString(cleaned, MAX_DECISION_LENGTH);
				if (sanitized) {
					decisions.push(sanitized);
				}
			}
		}
	}

	// Return last 5 decisions
	return decisions.slice(-5);
}

/**
 * Extract last 5 lines of Phase Metrics section from context.md
 */
function extractPhaseMetrics(content: string | null): string {
	if (!content) return '';

	const lines = content.split('\n');
	let inPhaseMetrics = false;
	const metricsLines: string[] = [];

	for (const line of lines) {
		// Start of Phase Metrics section
		if (line.trim() === '## Phase Metrics') {
			inPhaseMetrics = true;
			continue;
		}

		// End of Phase Metrics section
		if (inPhaseMetrics && line.startsWith('## ')) {
			break;
		}

		if (inPhaseMetrics) {
			metricsLines.push(line);
		}
	}

	// Return last 5 lines
	const lastFive = metricsLines.slice(-5);
	return lastFive.join('\n').trim();
}

/**
 * Get handoff data from the swarm directory.
 * Reads session state, plan, and context to build comprehensive handoff info.
 */
export async function getHandoffData(directory: string): Promise<HandoffData> {
	const now = new Date().toISOString();

	// Read session state
	const sessionContent = await readSwarmFileAsync(
		directory,
		'session/state.json',
	);
	const sessionState = _internals.parseSessionState(sessionContent);

	// Read plan
	const plan = await loadPlanJsonOnly(directory);
	const planInfo = _internals.extractCurrentPhaseFromPlan(plan);

	// Fallback to plan.md if no structured plan
	if (!plan) {
		const planMdContent = await readSwarmFileAsync(directory, 'plan.md');
		if (planMdContent) {
			// Extract from legacy plan.md format
			const phaseMatch = planMdContent.match(/^## Phase (\d+):?\s*(.+)?$/m);
			const taskMatch = planMdContent.match(/^- \[ \] (\d+\.\d+)/g);

			if (phaseMatch) {
				planInfo.currentPhase = sanitizeString(
					`Phase ${phaseMatch[1]}${phaseMatch[2] ? `: ${phaseMatch[2]}` : ''}`,
					MAX_TASK_ID_LENGTH,
				);
			}
			if (taskMatch) {
				const rawTasks = taskMatch.map((t) => t.replace('- [ ] ', ''));
				// Apply sanitization and limit to MAX_INCOMPLETE_TASKS
				planInfo.incompleteTasks = rawTasks
					.map((t) => sanitizeString(t, MAX_TASK_ID_LENGTH))
					.slice(0, MAX_INCOMPLETE_TASKS);
				if (!planInfo.currentTask && planInfo.incompleteTasks.length > 0) {
					planInfo.currentTask = planInfo.incompleteTasks[0];
				}
			}
		}
	}

	// Read context.md
	const contextContent = await readSwarmFileAsync(directory, 'context.md');
	const recentDecisions = _internals.extractDecisions(contextContent);
	const rawPhaseMetrics = _internals.extractPhaseMetrics(contextContent);
	// Sanitize phase metrics (limit to 1000 chars for safety)
	const phaseMetrics = sanitizeString(rawPhaseMetrics, 1000);

	// Build delegation state with phase metrics context
	let delegationState: DelegationState | null = null;
	if (sessionState?.delegationState) {
		delegationState = {
			...sessionState.delegationState,
			// Add phase metrics as context if available (sanitized)
			pendingHandoffs: phaseMetrics ? [phaseMetrics] : [],
		};
	}

	// Build pendingQA with HTML escaping for security
	let pendingQA: PendingQA | null = null;
	if (sessionState?.pendingQA) {
		pendingQA = {
			taskId: escapeHtml(sessionState.pendingQA.taskId),
			lastFailure: sessionState.pendingQA.lastFailure
				? escapeHtml(sessionState.pendingQA.lastFailure)
				: null,
		};
	}

	// Escape recentDecisions for security
	const escapedDecisions = recentDecisions.map((d) => escapeHtml(d));

	// Escape delegation state fields for security
	let escapedDelegationState: DelegationState | null = null;
	if (delegationState) {
		escapedDelegationState = {
			...delegationState,
			activeChains: delegationState.activeChains.map((c) => escapeHtml(c)),
			pendingHandoffs: delegationState.pendingHandoffs.map((p) =>
				escapeHtml(p),
			),
		};
	}

	// Escape incomplete tasks for security
	const escapedIncompleteTasks = planInfo.incompleteTasks.map((t) =>
		escapeHtml(t),
	);

	return {
		generated: now,
		currentPhase: planInfo.currentPhase
			? escapeHtml(planInfo.currentPhase)
			: null,
		currentTask: planInfo.currentTask ? escapeHtml(planInfo.currentTask) : null,
		incompleteTasks: escapedIncompleteTasks,
		pendingQA,
		activeAgent: sessionState?.activeAgent
			? escapeHtml(sessionState.activeAgent)
			: null,
		recentDecisions: escapedDecisions,
		delegationState: escapedDelegationState,
		execution_profile: plan?.execution_profile ?? null,
	};
}

/**
 * Format handoff data as terse markdown for LLM consumption.
 * Targets under 2K tokens for efficient context injection.
 */
export function formatHandoffMarkdown(data: HandoffData): string {
	const lines: string[] = [];

	// Header
	lines.push('## Swarm Handoff');
	lines.push('');
	lines.push(`**Generated**: ${data.generated}`);
	lines.push('');

	// Current state (data already sanitized by getHandoffData)
	lines.push('### Current State');
	if (data.currentPhase) {
		lines.push(`- **Phase**: ${data.currentPhase}`);
	}
	if (data.currentTask) {
		lines.push(`- **Task**: ${data.currentTask}`);
	}
	if (data.activeAgent) {
		lines.push(`- **Active Agent**: ${data.activeAgent}`);
	}
	lines.push('');

	// Incomplete tasks (limit to 10, data already sanitized)
	if (data.incompleteTasks.length > 0) {
		lines.push('### Incomplete Tasks');
		const displayTasks = data.incompleteTasks.slice(0, 10);
		for (const taskId of displayTasks) {
			lines.push(`- ${taskId}`);
		}
		if (data.incompleteTasks.length > 10) {
			lines.push(`- ... and ${data.incompleteTasks.length - 10} more`);
		}
		lines.push('');
	}

	// Pending QA (data already sanitized)
	if (data.pendingQA) {
		lines.push('### Pending QA');
		lines.push(`- **Task**: ${data.pendingQA.taskId}`);
		if (data.pendingQA.lastFailure) {
			lines.push(`- **Last Failure**: ${data.pendingQA.lastFailure}`);
		}
		lines.push('');
	}

	// Delegation state (data already sanitized)
	if (data.delegationState && data.delegationState.activeChains.length > 0) {
		lines.push('### Delegation');
		lines.push(`- **Depth**: ${data.delegationState.delegationDepth}`);
		for (const chain of data.delegationState.activeChains.slice(0, 3)) {
			lines.push(`- ${chain}`);
		}
		lines.push('');
	}

	// Recent decisions (limit to 5, data already sanitized)
	if (data.recentDecisions.length > 0) {
		lines.push('### Recent Decisions');
		for (const decision of data.recentDecisions.slice(0, 5)) {
			lines.push(`- ${decision}`);
		}
		lines.push('');
	}

	// Phase metrics from delegation state if available (data already sanitized)
	if (
		data.delegationState?.pendingHandoffs &&
		data.delegationState.pendingHandoffs.length > 0
	) {
		lines.push('### Phase Metrics');
		lines.push('```');
		lines.push(data.delegationState.pendingHandoffs[0]);
		lines.push('```');
	}

	// Execution profile (if set — resuming sessions must honour locked profiles)
	if (data.execution_profile) {
		lines.push('### Execution Profile');
		lines.push(
			`- **Parallelization**: ${data.execution_profile.parallelization_enabled ? 'enabled' : 'disabled'}`,
		);
		lines.push(
			`- **Max Concurrent Tasks**: ${data.execution_profile.max_concurrent_tasks}`,
		);
		lines.push(
			`- **Council Parallel**: ${data.execution_profile.council_parallel ? 'yes' : 'no'}`,
		);
		lines.push(
			`- **Locked**: ${data.execution_profile.locked ? 'YES — profile is immutable' : 'no'}`,
		);
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * Format handoff data as a continuation prompt for new agent sessions.
 * Returns a terse markdown code block with essential context and explicit
 * resumption instructions. Designed to be copy-pasted into a new session.
 */
export function formatContinuationPrompt(data: HandoffData): string {
	const lines: string[] = [];

	lines.push('## Resume Swarm');
	lines.push('');

	// Current state
	if (data.currentPhase) {
		lines.push(`**Phase**: ${data.currentPhase}`);
	}
	if (data.currentTask) {
		lines.push(`**Current Task**: ${data.currentTask}`);
	}

	// Next task: first incomplete task that isn't the current task
	let nextTask: string | undefined;
	if (data.incompleteTasks.length > 0) {
		nextTask = data.incompleteTasks.find((t) => t !== data.currentTask);
		if (nextTask) {
			lines.push(`**Next Task**: ${nextTask}`);
		}
	}

	// Pending QA blockers
	if (data.pendingQA) {
		lines.push('');
		lines.push(`**Pending QA Blocker**: ${data.pendingQA.taskId}`);
		if (data.pendingQA.lastFailure) {
			lines.push(`  - Last failure: ${data.pendingQA.lastFailure}`);
		}
	}

	// Recent decisions (last 3) — do not revisit these
	if (data.recentDecisions.length > 0) {
		const last3 = data.recentDecisions.slice(-3);
		lines.push('');
		lines.push('**Recent Decisions (do not revisit)**:');
		for (const decision of last3) {
			lines.push(`- ${decision}`);
		}
	}

	// Remaining incomplete tasks (beyond current and next)
	if (data.incompleteTasks.length > 2) {
		const remaining = data.incompleteTasks.filter(
			(t) => t !== data.currentTask && t !== nextTask,
		);
		if (remaining.length > 0) {
			lines.push('');
			lines.push(
				`**Remaining Tasks**: ${remaining.slice(0, 8).join(', ')}${remaining.length > 8 ? ` (+${remaining.length - 8} more)` : ''}`,
			);
		}
	}

	// Explicit instructions
	lines.push('');
	lines.push('**To resume**:');
	lines.push('1. Read `.swarm/handoff.md` for full context');
	lines.push(
		'2. Use `knowledge_recall` to recall relevant lessons before starting',
	);
	if (data.pendingQA) {
		lines.push(
			`3. Resolve QA blocker on task ${data.pendingQA.taskId} before continuing`,
		);
	} else if (data.currentTask) {
		lines.push(`3. Continue work on task ${data.currentTask}`);
	} else if (nextTask) {
		lines.push(`3. Begin work on task ${nextTask}`);
	} else {
		lines.push('3. Review the plan and pick up the next incomplete task');
	}
	lines.push(
		'4. Do not re-implement completed tasks or revisit settled decisions',
	);

	return `\`\`\`markdown\n${lines.join('\n')}\n\`\`\``;
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	getHandoffData: typeof getHandoffData;
	formatHandoffMarkdown: typeof formatHandoffMarkdown;
	formatContinuationPrompt: typeof formatContinuationPrompt;
	escapeHtml: typeof escapeHtml;
	sanitizeString: typeof sanitizeString;
	validatePlanPhases: typeof validatePlanPhases;
	extractCurrentPhaseFromPlan: typeof extractCurrentPhaseFromPlan;
	parseSessionState: typeof parseSessionState;
	extractDecisions: typeof extractDecisions;
	extractPhaseMetrics: typeof extractPhaseMetrics;
} = {
	getHandoffData,
	formatHandoffMarkdown,
	formatContinuationPrompt,
	escapeHtml,
	sanitizeString,
	validatePlanPhases,
	extractCurrentPhaseFromPlan,
	parseSessionState,
	extractDecisions,
	extractPhaseMetrics,
} as const;
