/**
 * Context Budget Service
 *
 * Provides context budget monitoring for swarm sessions.
 * Tracks token usage across all context components and provides
 * warnings when approaching budget limits.
 */

import { readSwarmFileAsync, validateSwarmPath } from '../hooks/utils';
import { bunWrite } from '../utils/bun-compat';
import { validateDirectory } from '../utils/path-security';

/**
 * Context budget report with detailed token breakdown
 */
export interface ContextBudgetReport {
	/** ISO timestamp when the report was generated */
	timestamp: string;
	/** Tokens used for the assembled system prompt */
	systemPromptTokens: number;
	/** Tokens used for the plan cursor */
	planCursorTokens: number;
	/** Tokens used for knowledge entries */
	knowledgeTokens: number;
	/** Tokens used for run memory */
	runMemoryTokens: number;
	/** Tokens used for handoff content */
	handoffTokens: number;
	/** Tokens used for context.md */
	contextMdTokens: number;
	/** Total swarm context tokens (sum of all components) */
	swarmTotalTokens: number;
	/** Estimated number of turns in this session */
	estimatedTurnCount: number;
	/** Estimated total tokens for the session */
	estimatedSessionTokens: number;
	/** Budget usage percentage */
	budgetPct: number;
	/** Current budget status */
	status: 'ok' | 'warning' | 'critical';
	/** Recommendation message if any */
	recommendation: string | null;
}

/**
 * Configuration for context budget monitoring
 */
export interface ContextBudgetConfig {
	/** Enable or disable budget monitoring */
	enabled: boolean;
	/** Maximum token budget (default: 40000) */
	budgetTokens: number;
	/** Warning threshold percentage (default: 70) */
	warningPct: number;
	/** Critical threshold percentage (default: 90) */
	criticalPct: number;
	/** Warning mode: 'once', 'every', or 'interval' */
	warningMode: 'once' | 'every' | 'interval';
	/** Interval for warning mode (default: 20 turns) */
	warningIntervalTurns: number;
}

/**
 * Budget state for tracking warning suppression
 */
export interface BudgetState {
	/** Turn number when warning was last fired */
	warningFiredAtTurn: number | null;
	/** Turn number when critical was last fired */
	criticalFiredAtTurn: number | null;
	/** Turn number when context was last injected */
	lastInjectedAtTurn: number | null;
}

/**
 * Default context budget configuration
 */
export const DEFAULT_CONTEXT_BUDGET_CONFIG: ContextBudgetConfig = {
	enabled: true,
	budgetTokens: 40000,
	warningPct: 70,
	criticalPct: 90,
	warningMode: 'once',
	warningIntervalTurns: 20,
};

/**
 * Cost per 1K tokens in USD (for cost estimation)
 */
const COST_PER_1K_TOKENS = 0.003;

/**
 * Estimate token count for text using character-based approximation
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count (ceiling of chars / 3.5)
 */
export function estimateTokens(text: string): number {
	if (!text || typeof text !== 'string') {
		return 0;
	}
	return Math.ceil(text.length / 3.5);
}

/**
 * Read and parse budget state from .swarm/session/budget-state.json
 *
 * @param directory - The swarm workspace directory
 * @returns Parsed budget state or null if file doesn't exist
 */
async function readBudgetState(directory: string): Promise<BudgetState | null> {
	const content = await readSwarmFileAsync(
		directory,
		'session/budget-state.json',
	);
	if (!content) {
		return null;
	}

	try {
		return JSON.parse(content) as BudgetState;
	} catch {
		return null;
	}
}

/**
 * Write budget state to .swarm/session/budget-state.json
 *
 * @param directory - The swarm workspace directory
 * @param state - The budget state to write
 */
async function writeBudgetState(
	directory: string,
	state: BudgetState,
): Promise<void> {
	try {
		const resolvedPath = validateSwarmPath(
			directory,
			'session/budget-state.json',
		);
		const content = JSON.stringify(state, null, 2);
		await bunWrite(resolvedPath, content);
	} catch (error) {
		console.warn(
			'[context-budget] Failed to write budget state:',
			error instanceof Error ? error.message : String(error),
		);
	}
}

/**
 * Count lines in events.jsonl to estimate turn count
 *
 * @param directory - The swarm workspace directory
 * @returns Number of events (proxy for turn count)
 */
async function countEvents(directory: string): Promise<number> {
	const content = await readSwarmFileAsync(directory, 'events.jsonl');
	if (!content) {
		return 0;
	}

	// Count non-empty lines
	const lines = content.split('\n').filter((line) => line.trim().length > 0);
	return lines.length;
}

/**
 * Extract plan cursor content from plan.md
 *
 * @param directory - The swarm workspace directory
 * @returns Plan cursor content or empty string
 */
async function getPlanCursorContent(directory: string): Promise<string> {
	const planContent = await readSwarmFileAsync(directory, 'plan.md');
	if (!planContent) {
		return '';
	}

	// Extract relevant section - typically the cursor shows current phase and upcoming tasks
	// For simplicity, we'll use a portion of the plan as the cursor representation
	const lines = planContent.split('\n');
	const cursorLines: string[] = [];
	let inCurrentSection = false;

	for (const line of lines) {
		// Look for current phase marker or in-progress section
		if (line.includes('in_progress') || line.includes('**Current**')) {
			inCurrentSection = true;
		}

		if (inCurrentSection) {
			cursorLines.push(line);
			// Stop after a reasonable number of lines
			if (cursorLines.length > 30) {
				break;
			}
		}
	}

	return cursorLines.join('\n') || planContent.substring(0, 1000);
}

/**
 * Get context budget report with detailed token breakdown
 *
 * @param directory - The swarm workspace directory
 * @param assembledSystemPrompt - The fully assembled system prompt
 * @param config - Budget configuration
 * @returns Context budget report
 */
export async function getContextBudgetReport(
	directory: string,
	assembledSystemPrompt: string,
	config: ContextBudgetConfig,
): Promise<ContextBudgetReport> {
	validateDirectory(directory);
	const timestamp = new Date().toISOString();

	// Estimate tokens for each component
	const systemPromptTokens = estimateTokens(assembledSystemPrompt);

	// Read plan cursor
	const planCursorContent = await getPlanCursorContent(directory);
	const planCursorTokens = estimateTokens(planCursorContent);

	// Read knowledge content
	const knowledgeContent = await readSwarmFileAsync(
		directory,
		'knowledge.jsonl',
	);
	const knowledgeTokens = estimateTokens(knowledgeContent || '');

	// Read run memory content
	const runMemoryContent = await readSwarmFileAsync(
		directory,
		'run-memory.jsonl',
	);
	const runMemoryTokens = estimateTokens(runMemoryContent || '');

	// Read handoff content
	const handoffContent = await readSwarmFileAsync(directory, 'handoff.md');
	const handoffTokens = estimateTokens(handoffContent || '');

	// Read context.md
	const contextMdContent = await readSwarmFileAsync(directory, 'context.md');
	const contextMdTokens = estimateTokens(contextMdContent || '');

	// Calculate total swarm context tokens
	const swarmTotalTokens =
		systemPromptTokens +
		planCursorTokens +
		knowledgeTokens +
		runMemoryTokens +
		handoffTokens +
		contextMdTokens;

	// Count events to estimate turn count
	const estimatedTurnCount = await countEvents(directory);

	// Calculate budget percentage
	const budgetPct = (swarmTotalTokens / config.budgetTokens) * 100;

	// Determine status
	let status: 'ok' | 'warning' | 'critical';
	let recommendation: string | null = null;

	if (budgetPct < config.warningPct) {
		status = 'ok';
	} else if (budgetPct < config.criticalPct) {
		status = 'warning';
		recommendation =
			'Consider wrapping up current phase and running /swarm handoff before starting new work.';
	} else {
		status = 'critical';
		recommendation =
			'Run /swarm handoff and start a new session to avoid cost escalation.';
	}

	// Calculate estimated session tokens (swarm tokens * turn count)
	const estimatedSessionTokens =
		swarmTotalTokens * Math.max(1, estimatedTurnCount);

	return {
		timestamp,
		systemPromptTokens,
		planCursorTokens,
		knowledgeTokens,
		runMemoryTokens,
		handoffTokens,
		contextMdTokens,
		swarmTotalTokens,
		estimatedTurnCount,
		estimatedSessionTokens,
		budgetPct,
		status,
		recommendation,
	};
}

/**
 * Format budget warning message based on report
 *
 * @param report - The context budget report
 * @param directory - Directory for state persistence (required for suppression logic)
 * @param config - Budget configuration for warning mode settings
 * @returns Warning message string or null if suppressed/ok
 */
export async function formatBudgetWarning(
	report: ContextBudgetReport,
	directory: string,
	config: ContextBudgetConfig,
): Promise<string | null> {
	validateDirectory(directory);
	// If status is ok, no warning needed
	if (report.status === 'ok') {
		return null;
	}

	// Directory is required for state persistence and suppression logic
	if (!directory || directory.trim() === '') {
		// If no directory provided, just return the warning without suppression
		return formatWarningMessage(report);
	}

	// Read current budget state
	const budgetState = await readBudgetState(directory);

	// Initialize state if needed
	const state: BudgetState = budgetState || {
		warningFiredAtTurn: null,
		criticalFiredAtTurn: null,
		lastInjectedAtTurn: null,
	};

	// Check if warning should be suppressed based on warning mode
	const currentTurn = report.estimatedTurnCount;

	if (report.status === 'warning') {
		// Check suppression based on warning mode
		if (config.warningMode === 'once' && state.warningFiredAtTurn !== null) {
			return null;
		}
		if (
			config.warningMode === 'interval' &&
			state.warningFiredAtTurn !== null &&
			currentTurn - state.warningFiredAtTurn < config.warningIntervalTurns
		) {
			return null;
		}

		// Update state and write
		state.warningFiredAtTurn = currentTurn;
		state.lastInjectedAtTurn = currentTurn;
		await writeBudgetState(directory, state);
	} else if (report.status === 'critical') {
		// Critical warnings are not suppressible - do NOT write state file
		state.criticalFiredAtTurn = currentTurn;
		state.lastInjectedAtTurn = currentTurn;
	}

	return formatWarningMessage(report);
}

/**
 * Format the warning message string
 *
 * @param report - The context budget report
 * @returns Formatted warning message
 */
function formatWarningMessage(report: ContextBudgetReport): string {
	const budgetPctStr = report.budgetPct.toFixed(1);
	const tokensPerTurn = report.swarmTotalTokens.toLocaleString();

	if (report.status === 'warning') {
		return `[CONTEXT BUDGET: ${budgetPctStr}% — swarm injecting ~${tokensPerTurn} tokens/turn. Consider wrapping current phase and running /swarm handoff before starting new work.]`;
	}

	// Critical status
	const costPerTurn = (
		(report.swarmTotalTokens / 1000) *
		COST_PER_1K_TOKENS
	).toFixed(3);

	return `[CONTEXT BUDGET: ${budgetPctStr}% CRITICAL — swarm injecting ~${tokensPerTurn} tokens/turn. Run /swarm handoff and start a new session to avoid cost escalation. Estimated session cost scaling: ~$${costPerTurn}/turn at current context size.]`;
}

/**
 * Get default context budget config
 *
 * @returns Default configuration
 */
export function getDefaultConfig(): ContextBudgetConfig {
	return { ...DEFAULT_CONTEXT_BUDGET_CONFIG };
}
