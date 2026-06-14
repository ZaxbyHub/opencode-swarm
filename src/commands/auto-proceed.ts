import { stripKnownSwarmPrefix } from '../config/schema.js';
import { getAgentSession } from '../state';

/**
 * Handles the /swarm auto-proceed command.
 * Sets or toggles the auto-proceed override for the active session.
 *
 * Unlike full-auto, this command has no config-level enablement requirement,
 * no durable state, and no v2 oversight infrastructure.
 *
 * @param directory - Project directory (accepted for signature consistency with other command handlers; unused)
 * @param args - Optional argument: "on" | "off" | undefined (toggle behavior)
 * @param sessionID - Session ID for accessing active session state
 * @returns Feedback message about auto-proceed override state
 */
export async function handleAutoProceedCommand(
	_directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	// Check for empty/blank sessionID - CLI context doesn't have session
	if (!sessionID || sessionID.trim() === '') {
		return 'Error: No active session context. Auto-proceed requires an active session. Use /swarm auto-proceed from within an OpenCode session, or start a session first.';
	}

	// Validate session exists
	const session = getAgentSession(sessionID);
	if (!session) {
		return 'Error: No active session. Auto-proceed requires an active session to operate.';
	}

	// Architect-only check: only the architect session may toggle auto-proceed
	if (stripKnownSwarmPrefix(session.agentName) !== 'architect') {
		return `Error: Auto-proceed can only be toggled from the architect session. Currently active session is: ${session.agentName}`;
	}

	// Parse the argument (case-insensitive)
	const arg = args[0]?.toLowerCase();

	// Track prior state for toggle nudge semantics
	const wasUndefinedBefore = session.autoProceedOverride === undefined;

	let newAutoProceedOverride: boolean;

	if (arg === 'on') {
		newAutoProceedOverride = true;
	} else if (arg === 'off') {
		newAutoProceedOverride = false;
	} else if (arg === undefined) {
		// Toggle: if currently true set false, otherwise (false or absent) set true
		newAutoProceedOverride = !session.autoProceedOverride;
	} else {
		// Invalid argument
		return 'Error: Invalid argument for /swarm auto-proceed. Valid options: "on", "off", or omit the argument to toggle.';
	}

	// Apply the new state
	session.autoProceedOverride = newAutoProceedOverride;

	// Set autoProceedNudgeDone:
	// - Always for explicit 'on'/'off' (user is explicitly acting)
	// - For toggle, only on the first touch (when override was previously undefined)
	if (
		arg === 'on' ||
		arg === 'off' ||
		(arg === undefined && wasUndefinedBefore)
	) {
		session.autoProceedNudgeDone = true;
	}

	if (newAutoProceedOverride) {
		return 'Auto-proceed is now ON. Phase boundaries will advance automatically.';
	} else {
		return 'Auto-proceed is now OFF. You will be asked before advancing to the next phase.';
	}
}
