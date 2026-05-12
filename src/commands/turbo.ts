import { loadPluginConfigWithMeta } from '../config';
import { getAgentSession } from '../state';
import {
	emptyRunState,
	isStateUnreadable,
	loadLeanTurboRunState,
	pauseLeanTurboRun,
	saveLeanTurboRunState,
} from '../turbo/lean/state';
import * as logger from '../utils/logger';

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.loadPluginConfigWithMeta(...)` so tests can replace the function
 * on this object without using `mock.module` from `bun:test`, which leaks
 * across files in Bun's shared test-runner process (AGENTS.md §7).
 * Mutating this local object is file-scoped and trivially restorable via afterEach.
 */
export const _internals: {
	loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
} = {
	loadPluginConfigWithMeta,
};

/**
 * Handles the /swarm turbo command.
 * Supports standard turbo toggle, lean turbo mode, and status reporting.
 *
 * @param directory - Project directory (used to persist Lean Turbo run state)
 * @param args - Optional arguments: "lean" | "standard" | "on" | "off" | "status" | undefined
 * @param sessionID - Session ID for accessing active session state
 * @returns Feedback message about Turbo Mode state
 */
export async function handleTurboCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	// Check for empty/blank sessionID - CLI context doesn't have session
	if (!sessionID || sessionID.trim() === '') {
		return 'Error: No active session context. Turbo Mode requires an active session. Use /swarm turbo from within an OpenCode session, or start a session first.';
	}

	// Validate session exists
	const session = getAgentSession(sessionID);
	if (!session) {
		return 'Error: No active session. Turbo Mode requires an active session to operate.';
	}

	// Parse arguments
	const arg0 = args[0]?.toLowerCase();
	const arg1 = args[1]?.toLowerCase();

	// Handle status command
	if (arg0 === 'status') {
		return buildStatusMessage(session, directory, sessionID);
	}

	// Determine current turbo state
	const isTurboOn = session.turboMode;
	const isLeanActive = session.leanTurboActive === true;

	// Disable helper - pauses lean if needed and resets all turbo flags
	const disableTurbo = (reason: string): void => {
		if (isLeanActive) {
			try {
				pauseLeanTurboRun(directory, sessionID, reason);
			} catch (error) {
				logger.error(
					`[turbo] pauseLeanTurboRun failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		session.turboMode = false;
		session.turboStrategy = undefined;
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
	};

	// --- Explicit off commands ---
	if (arg0 === 'off' || (arg0 === 'lean' && arg1 === 'off')) {
		// turbo off OR turbo lean off
		disableTurbo('/swarm turbo off');
		return 'Turbo Mode disabled';
	}

	if (arg0 === 'standard' && arg1 === 'off') {
		// turbo standard off
		disableTurbo('/swarm turbo standard off');
		return 'Turbo Mode disabled';
	}

	// --- Toggle (no args): off/standard → enable standard; standard on → disable ---
	if (arg0 === undefined) {
		if (isTurboOn) {
			// Any turbo is on (standard or lean) → disable all turbo
			disableTurbo('/swarm turbo (toggle off)');
			return 'Turbo Mode disabled';
		} else {
			// Turbo is off → enable standard
			session.turboMode = true;
			session.turboStrategy = 'standard';
			session.leanTurboActive = false;
			session.leanTurboCurrentPhase = undefined;
			return 'Turbo Mode enabled';
		}
	}

	// --- Explicit on commands ---
	if (arg0 === 'on') {
		// turbo on → enable standard UNLESS config says lean
		let strategy: 'standard' | 'lean' = 'standard';
		try {
			const { config } = _internals.loadPluginConfigWithMeta(directory);
			if (config.turbo?.strategy === 'lean') {
				strategy = 'lean';
			}
		} catch (error) {
			logger.warn(
				`[turbo] could not read config for strategy default: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (strategy === 'lean') {
			return enableLeanTurbo(session, directory, sessionID);
		}

		// Switch to standard (pause lean first if was active)
		if (isLeanActive) {
			disableTurbo('/swarm turbo on (switching from lean)');
		}
		session.turboMode = true;
		session.turboStrategy = 'standard';
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
		return 'Turbo Mode enabled';
	}

	// --- turbo standard on ---
	if (arg0 === 'standard' && arg1 === 'on') {
		// Pause lean if was active before switching to standard
		if (isLeanActive) {
			disableTurbo('/swarm turbo standard on (switching from lean)');
		}
		session.turboMode = true;
		session.turboStrategy = 'standard';
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
		return 'Turbo Mode enabled (standard)';
	}

	// --- turbo lean on ---
	if (arg0 === 'lean' && arg1 === 'on') {
		return enableLeanTurbo(session, directory, sessionID);
	}

	// --- turbo lean (no second arg): toggle lean ---
	if (arg0 === 'lean' && arg1 === undefined) {
		if (isLeanActive) {
			// Lean is active → disable
			disableTurbo('/swarm turbo lean (toggle off)');
			return 'Turbo Mode disabled';
		} else {
			// Lean is not active → enable lean
			return enableLeanTurbo(session, directory, sessionID);
		}
	}

	// Default fallback: unrecognized argument → toggle (restores legacy behavior)
	if (isTurboOn) {
		disableTurbo('/swarm turbo (toggle off via unknown arg)');
		return 'Turbo Mode disabled';
	} else {
		session.turboMode = true;
		session.turboStrategy = 'standard';
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
		return 'Turbo Mode enabled';
	}
}

/**
 * Enables Lean Turbo mode for the session.
 * Creates durable run state before flipping session flags (fail-closed pattern).
 */
function enableLeanTurbo(
	session: NonNullable<ReturnType<typeof getAgentSession>>,
	directory: string,
	sessionID: string,
): string {
	let maxParallelCoders = 4;
	let conflictPolicy: 'serialize' | 'degrade' = 'serialize';

	// Read config for lean settings
	try {
		const { config } = _internals.loadPluginConfigWithMeta(directory);
		const leanConfig = config.turbo?.lean;
		if (leanConfig) {
			maxParallelCoders = leanConfig.max_parallel_coders ?? 4;
			conflictPolicy = leanConfig.conflict_policy ?? 'serialize';
		}
	} catch (error) {
		logger.warn(
			`[turbo] could not read lean config: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Create durable run state FIRST (fail-closed pattern)
	// If this fails, do NOT flip session flags
	let durableError: string | undefined;
	try {
		const state = emptyRunState(sessionID, maxParallelCoders);
		state.status = 'running';
		saveLeanTurboRunState(directory, state);
	} catch (error) {
		durableError = error instanceof Error ? error.message : String(error);
		logger.error(`[turbo] durable run-state write failed: ${durableError}`);
	}

	if (durableError) {
		return [
			'Error: Lean Turbo could NOT be enabled — durable run-state write failed.',
			`Reason: ${durableError}.`,
			'Inspect .swarm/ permissions and disk space, then retry.',
		].join(' ');
	}

	// Check Full-Auto status for reporting
	const fullAutoActive = session.fullAutoMode;

	// Only flip session flags after durable write succeeds
	session.turboMode = true;
	session.turboStrategy = 'lean';
	session.leanTurboActive = true;
	session.leanTurboCurrentPhase = undefined;

	return [
		'Lean Turbo enabled',
		`(maxParallelCoders=${maxParallelCoders}, conflict_policy=${conflictPolicy},`,
		`Full-Auto: ${fullAutoActive ? 'active' : 'inactive'})`,
	].join(' ');
}

/**
 * Builds the status message for turbo mode.
 */
function buildStatusMessage(
	session: NonNullable<ReturnType<typeof getAgentSession>>,
	directory: string,
	sessionID: string,
): string {
	if (!session.turboMode) {
		return 'Turbo: off';
	}

	if (session.turboStrategy === 'standard' || !session.leanTurboActive) {
		return 'Turbo: standard (turboMode=true)';
	}

	// Lean Turbo active — load durable state for details
	if (isStateUnreadable(directory)) {
		return [
			'Turbo: lean (turboMode=true, leanTurboActive=true)',
			'WARNING: Durable state is unreadable — cannot report full status.',
		].join('\n');
	}

	const state = loadLeanTurboRunState(directory, sessionID);
	if (!state) {
		return [
			'Turbo: lean (turboMode=true, leanTurboActive=true)',
			'WARNING: Durable state not found.',
		].join('\n');
	}

	const phase =
		state.phase !== undefined ? `phase=${state.phase}` : 'phase=unset';
	const laneCount = state.lanes.length;
	const degradedCount = state.degradedTasks.length;
	const maxParallel = state.maxParallelCoders;
	const fullAutoActive = session.fullAutoMode;

	return [
		`Turbo: lean (turboMode=true, leanTurboActive=true)`,
		`Status: ${state.status}, ${phase}, lanes=${laneCount}, degraded=${degradedCount}`,
		`maxParallelCoders=${maxParallel}, Full-Auto: ${fullAutoActive ? 'active' : 'inactive'}`,
	].join('\n');
}
