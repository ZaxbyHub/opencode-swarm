/**
 * Context Budget Service
 *
 * Provides context budget monitoring for swarm sessions.
 * Tracks token usage across all context components and provides
 * warnings when approaching budget limits.
 */

import { DEFAULT_MODEL_CONTEXT_TOKENS } from '../config/schema';
import { getCoreEventLifetimeCount } from '../events/core-events.js';
import { resolveSwarmKnowledgePath } from '../hooks/knowledge-store';
import {
	estimateTokens as canonicalEstimateTokens,
	readSwarmFileAsync,
	validateSwarmPath,
} from '../hooks/utils';
import { bunFile, bunWrite } from '../utils/bun-compat';
import * as logger from '../utils/logger.js';
import { validateProjectDirectory } from '../utils/path-security';
import {
	invalidateCachedArtifact,
	readCachedTextFile,
} from '../utils/swarm-artifact-cache';

/**
 * Read a knowledge file's text by absolute (link-aware) path, returning '' on
 * any error. Mirrors `readSwarmFileAsync`'s resilience so routing through the
 * shared link store does not silently drop it:
 * - ENOENT retry (5×10ms) for the macOS/APFS rename-visibility race that can
 *   make a read immediately after an atomic write transiently see ENOENT —
 *   without it, a budget report can undercount knowledge tokens to zero.
 * - stamp-cached reads so a large shared knowledge store is not re-read from
 *   disk on every (frequent) budget report.
 *
 * Unlike `readSwarmFileAsync`, this takes an already-resolved absolute path so
 * it can point at the shared link store (`resolveSwarmKnowledgePath`) when the
 * worktree is linked.
 */
async function readFileOrEmpty(filePath: string): Promise<string> {
	const maxAttempts = 5;
	const retryDelayMs = 10;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const text = await readCachedTextFile(filePath, async () =>
				bunFile(filePath).text(),
			);
			return text ?? '';
		} catch (err) {
			// Only retry on ENOENT (rename-visibility race); other errors fail to ''.
			const isNotFound = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
			if (!isNotFound || attempt === maxAttempts - 1) return '';
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
	return '';
}

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
	/**
	 * The context-window denominator, in tokens. Production callers derive this
	 * per-model via `resolveContextWindowTokens` (`src/config/context-window.ts`)
	 * and never pass a constant; `DEFAULT_CONTEXT_BUDGET_CONFIG.budgetTokens`
	 * below is only the no-information floor.
	 */
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
	// LAST-RESORT floor only. Both system-enhancer budget blocks now overwrite
	// this with the value `resolveContextWindowTokens`
	// (`src/config/context-window.ts`) derives from the user's `model_limits`
	// and the live `model.limit.context`, so in production this number is only
	// reached when nothing is known about the model at all. It reads the shared
	// constant because the two defaults previously drifted (40000 here vs
	// 128000 in the schema), which made an unconfigured user measure the same
	// swarm context against a 3.2x smaller denominator.
	budgetTokens: DEFAULT_MODEL_CONTEXT_TOKENS,
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
 * Estimate token count for text using the canonical character-based heuristic.
 *
 * Delegates to `estimateTokens` in src/hooks/utils.ts (issue #1616/#2107). This
 * used to be an independent ÷3.5 formula, which made the user-facing budget
 * report disagree ~15% with the injection-admission path (0.33 tok/char) on
 * the same text. The export is kept for existing importers (capsule-builder,
 * the services barrel); it is a heuristic — provider-reported token usage is
 * authoritative when available.
 */
export function estimateTokens(text: string): number {
	if (!text || typeof text !== 'string') {
		return 0;
	}
	return canonicalEstimateTokens(text);
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
		// Only after a SUCCESSFUL write. `readBudgetState` above reads this exact
		// path through the cached reader, and this is a per-turn, in-process
		// read-modify-write whose edits are counter-only — i.e. frequently the
		// SAME SIZE as the previous revision. The cache's stat stamp
		// (mtime+ctime+size) cannot distinguish that from "unchanged" when both
		// writes land inside one filesystem timestamp tick (issue #1729), so the
		// next turn would re-read stale counters and re-emit the same warning.
		invalidateCachedArtifact(resolvedPath);
	} catch (error) {
		logger.log(
			'[context-budget] Failed to write budget state:',
			error instanceof Error ? error.message : String(error),
		);
	}
}

/**
 * Lifetime event count from the bounded core event store — the explicit
 * counter/projection issue #2039 requires for turn estimation. O(header)
 * once the store manifest exists (lifetime = folded + retained window);
 * a legacy header-less file falls back to a bounded newest-window count.
 * The figure is advisory-only (it feeds report display fields, not the
 * budget status decision).
 *
 * @param directory - The swarm workspace directory
 * @returns Number of events (proxy for turn count)
 */
async function countEvents(directory: string): Promise<number> {
	return getCoreEventLifetimeCount(directory);
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
	// `directory` is the plugin-injected project root (system-enhancer passes
	// its `directory`), so it is TRUSTED and always ABSOLUTE. It must therefore
	// be checked with `validateProjectDirectory`, not `validateDirectory` —
	// the latter is the validator for untrusted RELATIVE sub-paths and rejects
	// every absolute path, which made this whole report throw on every real
	// invocation behind a debug-gated catch (issue #1619 follow-up).
	validateProjectDirectory(directory);
	const timestamp = new Date().toISOString();

	// Estimate tokens for each component
	const systemPromptTokens = estimateTokens(assembledSystemPrompt);

	// Read plan cursor
	const planCursorContent = await getPlanCursorContent(directory);
	const planCursorTokens = estimateTokens(planCursorContent);

	// Read knowledge content (link-aware: reflects the shared store when linked).
	const knowledgeContent = await readFileOrEmpty(
		resolveSwarmKnowledgePath(directory),
	);
	const knowledgeTokens = estimateTokens(knowledgeContent);

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
			'Consider reducing injected context before starting new work.';
	} else {
		status = 'critical';
		recommendation =
			'Reduce injected context or start a fresh session before continuing.';
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
	// Same trust model as `getContextBudgetReport` above: `directory` is the
	// plugin-injected, always-absolute project root, so it needs the
	// trusted-root validator. `validateDirectory` (untrusted RELATIVE sub-path
	// input) rejects every absolute path and made this function throw on every
	// real invocation.
	validateProjectDirectory(directory);
	// If status is ok, no warning needed
	if (report.status === 'ok') {
		return null;
	}

	// NOTE: the pre-#1619-follow-up code had an `if (!directory || directory.trim() === '')`
	// early return here that returned an unsuppressed warning. It was unreachable
	// then (the validator above already threw on empty) and is unreachable now
	// (`validateProjectDirectory` still rejects empty), so it was removed rather
	// than left as a branch no caller can enter. Every path below may rely on
	// `directory` being a non-empty absolute root.

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
		return `[SWARM INJECTION FOOTPRINT: ${budgetPctStr}% of model window — swarm injection footprint ~${tokensPerTurn} tokens/turn (intermediate measurement of per-turn injections, not total prompt pressure). Consider reducing injected context before starting new work.]`;
	}

	// Critical status
	const costPerTurn = (
		(report.swarmTotalTokens / 1000) *
		COST_PER_1K_TOKENS
	).toFixed(3);

	return `[SWARM INJECTION FOOTPRINT: ${budgetPctStr}% CRITICAL — swarm injection footprint ~${tokensPerTurn} tokens/turn (intermediate measurement of per-turn injections, not total prompt pressure). Reduce injected context or start a fresh session before continuing. Approximate current prompt cost from swarm injections: ~$${costPerTurn}/turn.]`;
}

/**
 * Get default context budget config
 *
 * @returns Default configuration
 */
export function getDefaultConfig(): ContextBudgetConfig {
	return { ...DEFAULT_CONTEXT_BUDGET_CONFIG };
}
