import { readSwarmFileAsync } from '../hooks/utils';
import { derivePlanMarkdown, loadPlanJsonOnly } from '../plan/manager';

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.loadPlanJsonOnly(...)`, `_internals.derivePlanMarkdown(...)`,
 * and `_internals.readSwarmFileAsync(...)` so tests can replace the
 * functions on this object without touching the real module — `mock.module`
 * from `bun:test` leaks across files in Bun's shared test-runner process,
 * which would corrupt unrelated suites. Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: {
	loadPlanJsonOnly: typeof loadPlanJsonOnly;
	derivePlanMarkdown: typeof derivePlanMarkdown;
	readSwarmFileAsync: typeof readSwarmFileAsync;
} = {
	loadPlanJsonOnly,
	derivePlanMarkdown,
	readSwarmFileAsync,
};

/**
 * Structured plan data for a specific phase or full plan.
 */
export interface PlanData {
	hasPlan: boolean;
	fullMarkdown: string;
	requestedPhase: number | null;
	phaseMarkdown: string | null;
	errorMessage: string | null;
	isLegacy: boolean;
}

/**
 * Get plan data from the swarm directory.
 * Returns structured data for GUI, background flows, or commands.
 */
export async function getPlanData(
	directory: string,
	phaseArg?: string | number,
): Promise<PlanData> {
	const plan = await _internals.loadPlanJsonOnly(directory);

	if (plan) {
		const fullMarkdown = _internals.derivePlanMarkdown(plan);

		// No specific phase requested
		if (phaseArg === undefined || phaseArg === null || phaseArg === '') {
			return {
				hasPlan: true,
				fullMarkdown,
				requestedPhase: null,
				phaseMarkdown: null,
				errorMessage: null,
				isLegacy: false,
			};
		}

		// Parse phase number
		const phaseNum =
			typeof phaseArg === 'number' ? phaseArg : parseInt(String(phaseArg), 10);
		if (Number.isNaN(phaseNum)) {
			return {
				hasPlan: true,
				fullMarkdown,
				requestedPhase: null,
				phaseMarkdown: null,
				errorMessage: `Invalid phase number: "${phaseArg}"`,
				isLegacy: false,
			};
		}

		const phase = plan.phases.find((p) => p.id === phaseNum);
		if (!phase) {
			return {
				hasPlan: true,
				fullMarkdown,
				requestedPhase: phaseNum,
				phaseMarkdown: null,
				errorMessage: `Phase ${phaseNum} not found in plan.`,
				isLegacy: false,
			};
		}

		// Extract phase section from markdown
		const phaseMarkdown = extractPhaseMarkdown(fullMarkdown, phaseNum);

		return {
			hasPlan: true,
			fullMarkdown,
			requestedPhase: phaseNum,
			phaseMarkdown,
			errorMessage: null,
			isLegacy: false,
		};
	}

	// Legacy fallback - load plan.md
	const planContent = await _internals.readSwarmFileAsync(directory, 'plan.md');
	if (!planContent) {
		return {
			hasPlan: false,
			fullMarkdown: '',
			requestedPhase: null,
			phaseMarkdown: null,
			errorMessage: null,
			isLegacy: true,
		};
	}

	// No specific phase requested
	if (phaseArg === undefined || phaseArg === null || phaseArg === '') {
		return {
			hasPlan: true,
			fullMarkdown: planContent,
			requestedPhase: null,
			phaseMarkdown: null,
			errorMessage: null,
			isLegacy: true,
		};
	}

	// Parse phase number
	const phaseNum =
		typeof phaseArg === 'number' ? phaseArg : parseInt(String(phaseArg), 10);
	if (Number.isNaN(phaseNum)) {
		return {
			hasPlan: true,
			fullMarkdown: planContent,
			requestedPhase: null,
			phaseMarkdown: null,
			errorMessage: `Invalid phase number: "${phaseArg}"`,
			isLegacy: true,
		};
	}

	// Extract phase section from legacy plan.md
	const phaseMarkdown = extractPhaseMarkdown(planContent, phaseNum);

	// Check if phase was found
	if (phaseMarkdown === null) {
		return {
			hasPlan: true,
			fullMarkdown: planContent,
			requestedPhase: phaseNum,
			phaseMarkdown: null,
			errorMessage: `Phase ${phaseNum} not found in plan.`,
			isLegacy: true,
		};
	}

	return {
		hasPlan: true,
		fullMarkdown: planContent,
		requestedPhase: phaseNum,
		phaseMarkdown,
		errorMessage: null,
		isLegacy: true,
	};
}

/**
 * Extract a specific phase section from markdown.
 */
function extractPhaseMarkdown(
	markdown: string,
	phaseNum: number,
): string | null {
	const lines = markdown.split('\n');
	const phaseLines: string[] = [];
	let inTargetPhase = false;

	for (const line of lines) {
		const phaseMatch = line.match(/^## Phase (\d+)/);
		if (phaseMatch) {
			const num = parseInt(phaseMatch[1], 10);
			if (num === phaseNum) {
				inTargetPhase = true;
				phaseLines.push(line);
				continue;
			} else if (inTargetPhase) {
				break;
			}
		}
		if (inTargetPhase && line.trim() === '---' && phaseLines.length > 1) {
			break;
		}
		if (inTargetPhase) {
			phaseLines.push(line);
		}
	}

	return phaseLines.length > 0 ? phaseLines.join('\n').trim() : null;
}

/**
 * Format plan data as markdown for command output.
 */
export function formatPlanMarkdown(planData: PlanData): string {
	if (!planData.hasPlan) {
		return 'No active swarm plan found.';
	}

	// Return error message if any
	if (planData.errorMessage !== null) {
		return planData.errorMessage;
	}

	// If specific phase was requested and found
	if (planData.requestedPhase !== null && planData.phaseMarkdown) {
		return planData.phaseMarkdown;
	}

	// Return full plan
	return planData.fullMarkdown;
}

/**
 * Handle plan command - delegates to service and formats output.
 * Kept for backward compatibility - thin adapter.
 */
export async function handlePlanCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const phaseArg = args.length > 0 ? args[0] : undefined;
	const planData = await getPlanData(directory, phaseArg);
	return formatPlanMarkdown(planData);
}
