import { loadPlanJsonOnly } from '../plan/manager';
import { getAgentSession } from '../state';

/**
 * Preset concurrency values.
 */
const PRESETS: Record<string, number> = {
	min: 1,
	medium: 8,
	max: 16,
};

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 64;

/**
 * Handles the /swarm concurrency command.
 * Supports setting, resetting, and checking concurrency override values.
 *
 * @param directory - Project directory (used to load plan execution_profile)
 * @param args - Optional arguments: "set" | "status" | "reset" with optional value
 * @param sessionID - Session ID for accessing active session state
 * @returns Feedback message about concurrency state
 */
export async function handleConcurrencyCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	// Check for empty/blank sessionID - CLI context doesn't have session
	if (!sessionID || sessionID.trim() === '') {
		return 'Error: No active session context. Concurrency requires an active session. Use /swarm concurrency from within an OpenCode session, or start a session first.';
	}

	// Validate session exists
	const session = getAgentSession(sessionID);
	if (!session) {
		return 'Error: No active session. Concurrency requires an active session to operate.';
	}

	// Parse arguments
	const arg0 = args[0]?.toLowerCase();
	const arg1 = args[1];

	// Load plan to check if active plan exists (required for set/reset)
	const plan = await loadPlanJsonOnly(directory).catch(() => null);
	const hasPlan = plan !== null && plan !== undefined;

	// No args → show usage
	if (arg0 === undefined) {
		return [
			'Concurrency commands:',
			'  /swarm concurrency set <N|preset>  — Set session concurrency override (1-64 or min/medium/max)',
			'  /swarm concurrency status          — Show effective concurrency',
			'  /swarm concurrency reset           — Clear the override',
		].join('\n');
	}

	// Handle status command
	if (arg0 === 'status') {
		return buildStatusMessage(session, plan);
	}

	// Plan check — only needed for subcommands that require a plan
	if (!hasPlan) {
		if (arg0 === 'set') {
			return 'No active plan. Concurrency override requires an active plan.';
		}
	}

	// Handle reset command (works without plan)
	if (arg0 === 'reset') {
		session.maxConcurrencyOverride = undefined;
		return 'Concurrency override cleared';
	}

	// Handle set command
	if (arg0 === 'set') {
		if (arg1 === undefined) {
			return 'Error: /swarm concurrency set requires a value. Usage: /swarm concurrency set <N|preset>';
		}
		return handleSetCommand(session, arg1);
	}

	// Unknown subcommand
	return [
		`Unknown concurrency subcommand: ${arg0}`,
		'Usage: /swarm concurrency <set|status|reset>',
	].join('\n');
}

/**
 * Handles the "set" subcommand, validating and applying the concurrency value.
 */
function handleSetCommand(
	session: NonNullable<ReturnType<typeof getAgentSession>>,
	value: string,
): string {
	const normalizedValue = value.toLowerCase();

	// Check for preset values
	if (normalizedValue in PRESETS) {
		const presetConcurrency = PRESETS[normalizedValue];
		session.maxConcurrencyOverride = presetConcurrency;
		return `Concurrency override set to ${presetConcurrency} (${normalizedValue})`;
	}

	// Check if it's a number
	const numericValue = Number(value);
	if (Number.isNaN(numericValue)) {
		return `Invalid concurrency value: ${value}. Must be a number (1-64) or a preset (min, medium, max).`;
	}

	// Check if it's an integer
	if (!Number.isInteger(numericValue)) {
		return `Invalid concurrency value: ${value}. Must be a number (1-64) or a preset (min, medium, max).`;
	}

	// Check range
	if (numericValue < MIN_CONCURRENCY || numericValue > MAX_CONCURRENCY) {
		return `Concurrency value ${value} is out of range. Must be between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}.`;
	}

	// Set the override
	session.maxConcurrencyOverride = numericValue;
	return `Concurrency override set to ${numericValue}`;
}

/**
 * Builds the status message showing effective concurrency.
 * Always shows all 5 fields per spec FR-004.
 */
function buildStatusMessage(
	session: NonNullable<ReturnType<typeof getAgentSession>>,
	plan: {
		execution_profile?: {
			max_concurrent_tasks?: number;
			parallelization_enabled?: boolean;
		};
	} | null,
): string {
	const overrideActive = session.maxConcurrencyOverride !== undefined;
	const configuredOverride = session.maxConcurrencyOverride ?? 'absent';
	const hasPlan = plan !== null && plan !== undefined;

	const planBaseline = hasPlan
		? (plan!.execution_profile?.max_concurrent_tasks ?? 10)
		: 10;
	const parallelizationEnabled = hasPlan
		? (plan!.execution_profile?.parallelization_enabled ?? false)
		: false;

	// Calculate effective concurrency
	const operationalEffective = !parallelizationEnabled
		? 1
		: (session.maxConcurrencyOverride ?? planBaseline);

	// Build description
	let description: string;
	if (!hasPlan) {
		description = 'No active plan';
	} else if (!parallelizationEnabled) {
		description = 'Parallelization disabled (always 1)';
	} else if (overrideActive) {
		description = `Override active (${session.maxConcurrencyOverride})`;
	} else {
		description = `Plan baseline (${planBaseline})`;
	}

	// Format the output — ALWAYS show all fields per FR-004
	return [
		`Concurrency: ${description}`,
		`  override_active: ${overrideActive}`,
		`  configured_override: ${configuredOverride}`,
		`  plan_baseline: ${planBaseline}`,
		`  operational_effective: ${operationalEffective}`,
		`  parallelization_enabled: ${parallelizationEnabled}`,
	].join('\n');
}
