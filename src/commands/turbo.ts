import { loadPluginConfigWithMeta } from '../config';
import { isEpicOpenForProject } from '../epic/lifecycle';
import { getAgentSession } from '../state';
import {
	emptyRunState,
	isStateUnreadable,
	loadLeanTurboRunState,
	pauseLeanTurboRun,
	saveLeanTurboRunState,
} from '../turbo/lean/state';
import * as logger from '../utils/logger';
import { stripControlCharacters } from '../utils/sanitize-display.js';
import { TURBO_BYPASS_DISCLOSURE } from './turbo-constants.js';

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.loadPluginConfigWithMeta(...)` so tests can replace the function
 * on this object without using `mock.module` from `bun:test`, which leaks
 * across files in Bun's shared test-runner process (AGENTS.md §7).
 * Mutating this local object is file-scoped and trivially restorable via afterEach.
 */
export const _internals: {
	loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
	isEpicOpenForProject: typeof isEpicOpenForProject;
} = {
	loadPluginConfigWithMeta,
	isEpicOpenForProject,
};

/**
 * Reply to `/swarm turbo epic [on|off]` and bare `/swarm turbo epic`. Epic
 * Mode is no longer a Turbo strategy: it is started with `/swarm epic start`
 * and never enables Lean or Turbo. The redirect changes no state.
 */
export const TURBO_EPIC_REDIRECT_MESSAGE =
	'Epic is no longer combined with Turbo; use `/swarm epic start` (it enables neither Lean nor Turbo, and per-task QA is never waived). Turbo state is unchanged.';

/**
 * Reply to any Turbo-enabling invocation while an Epic is open for the
 * project: Turbo/Lean relax gates that Epic keeps (phase_complete Gates 1–5,
 * the coder re-dispatch block before Stage A; per-task Stage B is required in
 * every mode), so enabling is refused until the Epic is closed. Disabling
 * Turbo stays available.
 */
export const TURBO_EPIC_OPEN_REFUSAL =
	'Turbo Mode NOT enabled — epic-open: close the epic first (/swarm epic close). Turbo state is unchanged.';

/**
 * Handles the /swarm turbo command.
 * Supports standard turbo toggle, lean turbo mode, and status reporting.
 *
 * @param directory - Project directory (used to persist Lean Turbo run state)
 * @param args - Arguments: (none) | "on" | "off" | "status" | "lean" ["on"|"off"] | "standard" ["on"|"off"]. "epic" ["on"|"off"] is refused with a redirect to `/swarm epic start`; every Turbo-enabling argument is refused while an Epic is open for the project. Unknown arguments are rejected without changing state.
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

	// Parse arguments. Empty/whitespace-only tokens (trailing-space
	// invocations arriving as ['']) are argument-less: only non-empty tokens
	// steer dispatch.
	const tokens = args.filter((a) => a !== undefined && a.trim() !== '');
	const arg0 = tokens[0]?.toLowerCase();
	const arg1 = tokens[1]?.toLowerCase();

	// Handle status command
	if (arg0 === 'status') {
		return buildStatusMessage(session, directory, sessionID);
	}

	// Determine current turbo state
	const isTurboOn = session.turboMode;
	const isLeanActive = session.leanTurboActive === true;

	// Enable guard: while an Epic is open for this project, every
	// Turbo-enabling path is refused before any state changes (Turbo/Lean
	// relax gates that Epic keeps). The probe is sentinel-first, so
	// a project without an Epic pays one existsSync and nothing else.
	const epicOpenRefusal = (): string | undefined =>
		_internals.isEpicOpenForProject(directory)
			? TURBO_EPIC_OPEN_REFUSAL
			: undefined;

	// Disable helper - pauses lean if needed and resets all turbo flags.
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
			const refused = epicOpenRefusal();
			if (refused !== undefined) return refused;
			session.turboMode = true;
			session.turboStrategy = 'standard';
			session.leanTurboActive = false;
			session.leanTurboCurrentPhase = undefined;
			return `Turbo Mode enabled. ${TURBO_BYPASS_DISCLOSURE}`;
		}
	}

	// --- Explicit on commands ---
	if (arg0 === 'on') {
		const refused = epicOpenRefusal();
		if (refused !== undefined) return refused;
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
		return `Turbo Mode enabled. ${TURBO_BYPASS_DISCLOSURE}`;
	}

	// --- turbo standard on ---
	if (arg0 === 'standard' && arg1 === 'on') {
		const refused = epicOpenRefusal();
		if (refused !== undefined) return refused;
		// Pause lean if was active before switching to standard
		if (isLeanActive) {
			disableTurbo('/swarm turbo standard on (switching from lean)');
		}
		session.turboMode = true;
		session.turboStrategy = 'standard';
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
		return `Turbo Mode enabled (standard). ${TURBO_BYPASS_DISCLOSURE}`;
	}

	// --- turbo standard (no second arg): toggle standard ---
	// #2493 review: the help text and JSDoc advertise `standard [on|off]`,
	// and bare `lean` / bare `epic` both toggle — bare `standard` used to
	// fall through to the unknown-argument rejection instead.
	if (arg0 === 'standard' && arg1 === undefined) {
		const isStandardActive =
			session.turboMode === true && session.turboStrategy === 'standard';
		if (isStandardActive) {
			disableTurbo('/swarm turbo standard (toggle off)');
			return 'Turbo Mode disabled';
		}
		const refused = epicOpenRefusal();
		if (refused !== undefined) return refused;
		if (isLeanActive) {
			disableTurbo('/swarm turbo standard (switching from lean)');
		}
		session.turboMode = true;
		session.turboStrategy = 'standard';
		session.leanTurboActive = false;
		session.leanTurboCurrentPhase = undefined;
		return `Turbo Mode enabled (standard). ${TURBO_BYPASS_DISCLOSURE}`;
	}

	// --- turbo lean on ---
	if (arg0 === 'lean' && arg1 === 'on') {
		return epicOpenRefusal() ?? enableLeanTurbo(session, directory, sessionID);
	}

	// --- turbo lean (no second arg): toggle lean ---
	if (arg0 === 'lean' && arg1 === undefined) {
		if (isLeanActive) {
			// Lean is active → disable
			disableTurbo('/swarm turbo lean (toggle off)');
			return 'Turbo Mode disabled';
		} else {
			// Lean is not active → enable lean
			return (
				epicOpenRefusal() ?? enableLeanTurbo(session, directory, sessionID)
			);
		}
	}

	// --- turbo epic [on|off] / bare turbo epic: Epic Mode is no longer a
	// Turbo strategy (it is started with `/swarm epic start` and enables
	// neither Lean nor Turbo). Redirect without touching any state.
	if (
		arg0 === 'epic' &&
		(arg1 === undefined || arg1 === 'on' || arg1 === 'off')
	) {
		return TURBO_EPIC_REDIRECT_MESSAGE;
	}

	// Unknown argument (issue #2493): reject instead of silently toggling.
	// The legacy fall-through made typos indistinguishable from intentional
	// toggles — `/swarm turbo fast` would flip turbo state with no signal
	// that the argument was never understood. State is left untouched.
	// Report the offending token: when a known mode subcommand (lean/
	// standard/epic) carried a bad second argument, that second token is the
	// unknown one — printing args[0] would name a valid subcommand (#2493).
	const MODE_SUBCOMMANDS = new Set(['lean', 'standard', 'epic']);
	const attempted = stripControlCharacters(
		arg0 !== undefined && MODE_SUBCOMMANDS.has(arg0) && arg1 !== undefined
			? arg1
			: (arg0 ?? ''),
	).slice(0, 100);
	return (
		`Unknown turbo argument "${attempted}". Turbo state is unchanged.\n` +
		'Valid arguments: (none) | on | off | status | lean [on|off] | standard [on|off] | epic [on|off].\n' +
		'Run `/swarm help` for details.'
	);
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
		`Lean Turbo enabled. ${TURBO_BYPASS_DISCLOSURE} ` +
			`Per-lane: reviewer gates and file-lock conflict detection.`,
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
