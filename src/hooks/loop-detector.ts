/**
 * Loop detector for Task tool delegations.
 * Tracks the last 10 delegation patterns per session using a sliding window.
 * Detects loops when the same semantic action digest appears 3 or more
 * consecutive times (issue #2103 workstream B).
 */

import { createHash } from 'node:crypto';
import { stripKnownSwarmPrefix } from '../config/schema';
import { swarmState } from '../state';
import { isStrictTaskId } from '../validation/task-id.js';

export interface LoopDetectResult {
	looping: boolean;
	count: number;
	pattern: string;
}

/**
 * Canonicalize a bounded value for hashing (issue #2103 workstream B).
 * Strings are trimmed and length-capped BEFORE hashing; the digest is the only
 * thing stored, so raw prompt/secret text never lands in the window,
 * telemetry, or errors.
 */
function boundedValueHash(value: unknown): string | null {
	if (typeof value === 'string') {
		if (value.length === 0) return null;
		return createHash('sha256')
			.update(value.slice(0, 2_000))
			.digest('hex')
			.slice(0, 16);
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return null;
}

/**
 * Semantic, privacy-safe delegation action digest (issue #2103 workstream B).
 *
 * Identifier allowlist: tool name, normalized target role, strict plan-task id
 * when present, and a SHA-256 digest of the bounded values of non-prompt
 * argument keys. Argument KEY ORDER does not change the digest (sorted keys);
 * a RELEVANT VALUE change does. Five distinct tasks to one role therefore do
 * NOT collide, while a true retry of the same action DOES.
 *
 * Raw prompt/message/description text never enters the digest IDENTIFIER — it
 * is hashed separately as a bounded value so an identical re-dispatch still
 * collides, without storing or keying on the text itself.
 */
export function canonicalDelegationDigest(
	toolName: string,
	args: Record<string, unknown> | undefined,
): string {
	const targetAgentRaw =
		typeof args?.subagent_type === 'string' ? args.subagent_type : 'unknown';
	const targetAgent = stripKnownSwarmPrefix(targetAgentRaw)
		.trim()
		.toLowerCase();

	const taskIdRaw = args?.task_id ?? args?.taskId;
	const taskId =
		typeof taskIdRaw === 'string' && isStrictTaskId(taskIdRaw) ? taskIdRaw : '';

	const parts: string[] = [];
	for (const key of Object.keys(args ?? {}).sort()) {
		if (key === 'subagent_type' || key === 'task_id' || key === 'taskId') {
			continue;
		}
		const hashed = boundedValueHash(args?.[key]);
		if (hashed !== null) parts.push(`${key}=${hashed}`);
	}
	const argDigest = createHash('sha256')
		.update(parts.join('|'))
		.digest('hex')
		.slice(0, 16);

	return `${toolName}:${targetAgent}${taskId ? `#${taskId}` : ''}:${argDigest}`;
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
	// Only track Task tool calls
	if (toolName !== 'Task') {
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

	const hash = canonicalDelegationDigest(toolName, argsRecord);
	const now = Date.now();

	// Append to sliding window, cap at 10 entries. Only the digest is stored.
	session.loopDetectionWindow.push({ hash, timestamp: now });
	if (session.loopDetectionWindow.length > 10) {
		session.loopDetectionWindow.shift();
	}

	// Count consecutive identical digests at the tail
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

/** Test seam (AGENTS.md invariant 7). */
export const _test_exports = {
	canonicalDelegationDigest,
};
