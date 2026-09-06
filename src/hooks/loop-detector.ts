/**
 * Loop detector for Task tool delegations.
 * Tracks the last 10 delegation patterns per session using a sliding window.
 * Detects loops when the same (toolName + targetAgent + firstArgKey) hash
 * appears 3 or more consecutive times.
 */

import { createActionIdentity } from '../failures/action-identity.js';
import { swarmState } from '../state';
import { normalizeToolNameLowerCase } from './normalize-tool-name.js';

export interface LoopDetectResult {
	looping: boolean;
	count: number;
	pattern: string;
}

/**
 * Detect delegation loops for a session.
 * Only tracks Task tool calls (agent delegations).
 * Returns the current loop state after recording this call.
 */
export function detectLoop(
	sessionId: string,
	toolName: string,
	args: unknown,
): LoopDetectResult {
	// Only track native task delegations. The host's tool id is lowercase
	// `task` (issue #2507 / HOOKS-2); the shared normalizer also strips
	// namespace prefixes, so the legacy capitalised spelling keeps working.
	if (normalizeToolNameLowerCase(toolName) !== 'task') {
		return { looping: false, count: 0, pattern: '' };
	}

	const session = swarmState.agentSessions.get(sessionId);
	if (!session) {
		return { looping: false, count: 0, pattern: '' };
	}

	// Ensure the window exists
	if (!session.loopDetectionWindow) {
		session.loopDetectionWindow = [];
	}

	const argsRecord =
		args != null && typeof args === 'object' && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: undefined;

	const hash = createActionIdentity({
		tool: toolName,
		args: argsRecord,
	}).pattern;
	const now = Date.now();

	// Append to sliding window, cap at 10 entries
	session.loopDetectionWindow.push({ hash, timestamp: now });
	if (session.loopDetectionWindow.length > 10) {
		session.loopDetectionWindow.shift();
	}

	// Count consecutive identical hashes at the tail
	const window = session.loopDetectionWindow;
	let consecutiveCount = 0;
	for (let i = window.length - 1; i >= 0; i--) {
		if (window[i].hash === hash) {
			consecutiveCount++;
		} else {
			break;
		}
	}

	return {
		looping: consecutiveCount >= 3,
		count: consecutiveCount,
		pattern: hash,
	};
}
