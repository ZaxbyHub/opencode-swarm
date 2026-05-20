import { loadPluginConfigWithMeta } from '../config';
import {
	pauseFullAutoRun,
	startFullAutoRun,
	terminateFullAutoRun,
} from '../full-auto/state';
import { getAgentSession, swarmState } from '../state';
import * as logger from '../utils/logger';

/**
 * Handles the /swarm full-auto command.
 * Toggles Full-Auto Mode on or off for the active session.
 *
 * In Full-Auto v2 this also creates a durable run-state record under
 * .swarm/full-auto-state.json so the permission/oversight infrastructure can
 * fail-closed across hooks and across process restarts.
 *
 * H2 fix: durable write happens BEFORE flipping the legacy
 * `session.fullAutoMode` flag. If the durable write fails, the command
 * surfaces the error in its return string and does NOT enable the legacy
 * reactive intercept — preventing a silent fail-open where reactive checks
 * would believe Full-Auto is on while the v2 permission hook sees no
 * durable run.
 *
 * @param directory - Project directory (used to persist Full-Auto run state)
 * @param args - Optional argument: "on" | "off" | undefined (toggle behavior)
 * @param sessionID - Session ID for accessing active session state
 * @returns Feedback message about Full-Auto Mode state
 */
export async function handleFullAutoCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	// Check for empty/blank sessionID - CLI context doesn't have session
	if (!sessionID || sessionID.trim() === '') {
		return 'Error: No active session context. Full-Auto Mode requires an active session. Use /swarm-full-auto from within an OpenCode session, or start a session first.';
	}

	// Validate session exists
	const session = getAgentSession(sessionID);
	if (!session) {
		return 'Error: No active session. Full-Auto Mode requires an active session to operate.';
	}

	// Parse the argument
	const arg = args[0]?.toLowerCase();

	let newFullAutoMode: boolean;

	if (arg === 'on') {
		newFullAutoMode = true;
	} else if (arg === 'off') {
		newFullAutoMode = false;
	} else {
		// Toggle behavior when no argument provided
		newFullAutoMode = !session.fullAutoMode;
	}

	// Block activation if config-level full_auto is not enabled
	if (newFullAutoMode && !swarmState.fullAutoEnabledInConfig) {
		return 'Error: Full-Auto Mode cannot be enabled because full_auto.enabled is not set to true in the swarm plugin config. The autonomous oversight hook is inactive without config-level enablement. Set full_auto.enabled = true in your opencode-swarm config and restart.';
	}

	// H2: durable Full-Auto v2 run-state write FIRST. If this fails, do not
	// flip the legacy `session.fullAutoMode` flag — surface the error.
	let v2Status: 'running' | 'paused' | 'unavailable' = 'unavailable';
	let modeLabel = 'supervised';
	let denialMaxConsecutive = 3;
	let denialMaxTotal = 20;
	let failClosed = true;
	let durableError: string | undefined;
	try {
		const { config } = loadPluginConfigWithMeta(directory);
		const fullAutoConfig = config.full_auto;
		modeLabel = fullAutoConfig?.mode ?? 'supervised';
		denialMaxConsecutive = fullAutoConfig?.denials?.max_consecutive ?? 3;
		denialMaxTotal = fullAutoConfig?.denials?.max_total ?? 20;
		failClosed = fullAutoConfig?.fail_closed !== false;
		if (newFullAutoMode) {
			startFullAutoRun(directory, sessionID, fullAutoConfig);
			v2Status = 'running';
		} else {
			const paused = pauseFullAutoRun(
				directory,
				sessionID,
				'/swarm full-auto off',
			);
			if (!paused) {
				// No prior state — terminate cleanly so any future hook lookup sees idle.
				terminateFullAutoRun(directory, sessionID, 'never started');
			}
			v2Status = 'paused';
		}
	} catch (error) {
		durableError = error instanceof Error ? error.message : String(error);
		logger.error(`[full-auto] durable run-state write failed: ${durableError}`);
	}

	if (newFullAutoMode && durableError) {
		// Refuse to flip the legacy flag — the v2 permission hook would have
		// no durable run to consult, and reactive intercept alone is not the
		// advertised v2 control plane.
		return [
			'Error: Full-Auto Mode could NOT be enabled — durable run-state write failed.',
			`Reason: ${durableError}.`,
			'Inspect .swarm/ permissions and disk space, then retry.',
		].join(' ');
	}

	// Update the session state (legacy v1 reactive intercept toggle)
	session.fullAutoMode = newFullAutoMode;

	// Reset interaction counters when toggling off to ensure clean state on re-enable
	if (!newFullAutoMode) {
		session.fullAutoInteractionCount = 0;
		session.fullAutoDeadlockCount = 0;
		session.fullAutoLastQuestionHash = null;
	}

	if (!newFullAutoMode) {
		return [
			'Full-Auto Mode disabled',
			`(v2 run-state: ${v2Status}; mode=${modeLabel})`,
		].join(' ');
	}

	return [
		'Full-Auto Mode enabled',
		`(v2 mode=${modeLabel}, fail_closed=${failClosed},`,
		`denials max ${denialMaxConsecutive} consecutive / ${denialMaxTotal} total)`,
	].join(' ');
}
