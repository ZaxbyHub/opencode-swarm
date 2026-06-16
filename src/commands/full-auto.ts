import { loadPluginConfigWithMeta } from '../config';
import {
	disarmFullAutoRun,
	isFullAutoStateUnreadable,
	loadFullAutoRunState,
	startFullAutoRun,
	terminateFullAutoRun,
} from '../full-auto/state';
import { getAgentSession } from '../state';
import * as logger from '../utils/logger';

const VALID_MODES = ['assisted', 'supervised', 'strict'] as const;
type FullAutoMode = (typeof VALID_MODES)[number];

function isValidMode(value: string): value is FullAutoMode {
	return (VALID_MODES as readonly string[]).includes(value);
}

/**
 * Handles the /swarm full-auto command.
 * First-class session toggle for Full-Auto Mode: on / off / status / bare toggle.
 *
 * Full-Auto no longer requires `full_auto.enabled: true` in the plugin config —
 * the v2 hooks are always armed and gated at runtime by the durable per-session
 * run state, so activation is a pure runtime decision (like switching permission
 * modes in other agent CLIs). Administrators can set `full_auto.locked: true`
 * to refuse runtime activation entirely.
 *
 * `on` accepts an optional mode argument (`assisted` | `supervised` | `strict`)
 * that overrides `full_auto.mode` for this run. In every mode the critic
 * reviews escalations on the user's behalf; `strict` routes ALL plan mutations
 * through the critic, `supervised` (default) routes risky/high-impact actions,
 * `assisted` only consults the critic when the deterministic policy escalates.
 *
 * In Full-Auto v2 this also creates a durable run-state record under
 * .swarm/full-auto-state.json so the permission/oversight infrastructure can
 * fail-closed across hooks and across process restarts.
 *
 * H2 fix (preserved): durable write happens BEFORE flipping the legacy
 * `session.fullAutoMode` flag. If the durable write fails, the command
 * surfaces the error in its return string and does NOT enable the legacy
 * reactive intercept — preventing a silent fail-open where reactive checks
 * would believe Full-Auto is on while the v2 permission hook sees no
 * durable run.
 *
 * @param directory - Project directory (used to persist Full-Auto run state)
 * @param args - "on [mode]" | "off" | "status" | undefined (toggle behavior)
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

	if (arg === 'status') {
		return buildStatusReport(directory, sessionID, session.fullAutoMode);
	}

	let newFullAutoMode: boolean;
	let modeOverride: FullAutoMode | undefined;

	if (arg === 'on') {
		newFullAutoMode = true;
		const modeArg = args[1]?.toLowerCase();
		if (modeArg) {
			if (!isValidMode(modeArg)) {
				return `Error: invalid Full-Auto mode '${args[1]}'. Valid modes: ${VALID_MODES.join(', ')}.`;
			}
			modeOverride = modeArg;
		}
	} else if (arg === 'off') {
		newFullAutoMode = false;
	} else if (arg && isValidMode(arg)) {
		// A bare mode token (`/swarm full-auto strict`) means "turn on in that
		// mode" — treating it as a toggle could silently turn Full-Auto OFF
		// when the user meant to switch modes.
		newFullAutoMode = true;
		modeOverride = arg;
	} else {
		// Toggle behavior when no argument provided
		newFullAutoMode = !session.fullAutoMode;
	}

	// H2: durable Full-Auto v2 run-state write FIRST. If this fails, do not
	// flip the legacy `session.fullAutoMode` flag — surface the error.
	let v2Status: 'running' | 'idle' | 'unavailable' = 'unavailable';
	let modeLabel = 'supervised';
	let denialMaxConsecutive = 3;
	let denialMaxTotal = 20;
	let failClosed = true;
	let durableError: string | undefined;
	let criticModelAdvisory = '';
	try {
		const { config, configHadErrors } = loadPluginConfigWithMeta(directory);
		const fullAutoConfig = config.full_auto;

		// Fail-closed activation guard: if a config file existed but could
		// not be loaded (corrupt JSON, oversized, permission error), `locked`
		// may have silently defaulted to false. Refuse activation rather than
		// bypassing an unreadable lock.
		if (newFullAutoMode && configHadErrors) {
			return 'Error: Full-Auto Mode cannot be enabled — a swarm plugin config file exists but could not be loaded, so full_auto.locked cannot be verified. Fix the config file (see warnings above) and retry.';
		}

		// Administrative hard-off: `locked: true` refuses runtime activation.
		// `off` and `status` always work so a locked project can still be
		// cleanly deactivated.
		if (newFullAutoMode && fullAutoConfig?.locked === true) {
			return 'Error: Full-Auto Mode is locked for this project (full_auto.locked is true in the swarm plugin config). Runtime activation is disabled by configuration; remove the lock to use /swarm full-auto on.';
		}

		const effectiveMode = modeOverride ?? fullAutoConfig?.mode ?? 'supervised';
		modeLabel = effectiveMode;
		denialMaxConsecutive = fullAutoConfig?.denials?.max_consecutive ?? 3;
		denialMaxTotal = fullAutoConfig?.denials?.max_total ?? 20;
		failClosed = fullAutoConfig?.fail_closed !== false;
		if (newFullAutoMode) {
			startFullAutoRun(
				directory,
				sessionID,
				fullAutoConfig ? { ...fullAutoConfig, mode: effectiveMode } : undefined,
			);
			v2Status = 'running';

			// Activation-time advisory (moved from init, which only fired for
			// legacy `enabled: true` configs): the critic reviews on the user's
			// behalf, so reviewing with the same model the architect uses
			// weakens the independent-judgment guarantee. Only warn when the
			// user EXPLICITLY configured matching models — with a zero-config
			// install both sides resolve from defaults and the architect's
			// real runtime model is orchestrator-determined, so a warning
			// would be a standing false positive.
			const criticModel =
				fullAutoConfig?.critic_model ?? config.agents?.critic?.model;
			const architectModel = config.agents?.architect?.model;
			if (criticModel && architectModel && criticModel === architectModel) {
				criticModelAdvisory =
					' WARNING: critic model matches architect model — set full_auto.critic_model (or agents.critic.model) to a different model for independent oversight.';
			}
		} else {
			// Explicit user `off` DISARMS the run (status 'idle') so the session
			// returns to normal interactive operation. Pausing here would leave
			// every non-read-only tool blocked until the next `on` — a one-way
			// door. Paused/terminated states remain reserved for system-initiated
			// halts.
			const disarmed = disarmFullAutoRun(
				directory,
				sessionID,
				'/swarm full-auto off',
			);
			if (!disarmed) {
				// No prior durable state for this session — `terminateFullAutoRun`
				// is itself a no-op on a missing record (it just `return undefined`
				// from the withStateLock callback). The call is retained so a
				// future hook lookup that consults the durable state can rely on
				// the path being clearly absent rather than ambiguous.
				terminateFullAutoRun(directory, sessionID, 'never started');
			}
			v2Status = 'idle';
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

	return (
		[
			'Full-Auto Mode enabled',
			`(v2 mode=${modeLabel}, fail_closed=${failClosed},`,
			`denials max ${denialMaxConsecutive} consecutive / ${denialMaxTotal} total)`,
		].join(' ') + criticModelAdvisory
	);
}

/**
 * Builds a human-readable status report for `/swarm full-auto status`.
 * Read-only: never mutates session or durable state.
 */
function buildStatusReport(
	directory: string,
	sessionID: string,
	sessionFlag: boolean,
): string {
	const lines: string[] = [];
	lines.push(`Full-Auto session flag: ${sessionFlag ? 'on' : 'off'}`);
	try {
		const { config, configHadErrors } = loadPluginConfigWithMeta(directory);
		if (configHadErrors) {
			lines.push(
				'Config: UNREADABLE (a config file exists but could not be loaded; `full_auto.locked` cannot be verified, so runtime activation refuses by fail-closed default). Fix the config file to restore normal status.',
			);
		}
		if (config.full_auto?.locked === true) {
			lines.push(
				'Config: locked (runtime activation disabled via full_auto.locked)',
			);
		}
	} catch {
		// Config load failures must not break a read-only status report.
	}
	try {
		const runState = loadFullAutoRunState(directory, sessionID);
		// Surface a corrupt/unreadable state file explicitly — in that
		// situation the permission hook fail-closed-blocks non-read-only
		// tools project-wide, and reporting "none" would be actively
		// misleading.
		const stateHealth = isFullAutoStateUnreadable();
		if (stateHealth.unreadable) {
			lines.push(
				`Durable run-state: UNREADABLE (${stateHealth.reason}). Non-read-only tools are blocked fail-closed until .swarm/full-auto-state.json (or .bak) is restored or deleted.`,
			);
		} else if (!runState) {
			lines.push('Durable run-state: none (no Full-Auto run for this session)');
		} else {
			lines.push(
				`Durable run-state: ${runState.status} (mode=${runState.mode})`,
			);
			if (runState.pauseReason) {
				lines.push(`Pause reason: ${runState.pauseReason}`);
			}
			if (runState.terminateReason) {
				lines.push(`Terminate reason: ${runState.terminateReason}`);
			}
			lines.push(
				`Counters: ${runState.counters.toolCalls} tool calls, ${runState.counters.architectTurns} architect turns, ${runState.counters.oversightChecks} oversight checks`,
			);
			lines.push(
				`Denials: ${runState.denialCounters.consecutive} consecutive / ${runState.denialCounters.total} total`,
			);
			if (runState.lastOversightVerdict) {
				lines.push(
					`Last oversight verdict: ${runState.lastOversightVerdict}${runState.lastOversightAt ? ` at ${runState.lastOversightAt}` : ''}`,
				);
			}
		}
	} catch (error) {
		lines.push(
			`Durable run-state: unreadable (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	return lines.join('\n');
}
