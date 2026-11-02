/**
 * Process-local route-invalidation registry (issues #3509 / #3516).
 *
 * When a reviewer/test_engineer dispatch's routing block faults BEFORE its
 * pending receipt persists (pre-assignment reads, unresolved fallback, or the
 * persist itself), a stale prior receipt at the same per-(session, task) path
 * must never authorize THAT dispatch's Stage-B settlement. The routing catch
 * arm records a call-scoped invalidation here; every enforcement seam — the
 * foreground settlement loop, the background ingestion gates, and the
 * completion observer — consults it before authorizing advancement.
 *
 * Storage is keyed by canonical project directory (realpath, with a resolve
 * fallback for not-yet-existing roots) → sessionID → callID. A call's record
 * carries:
 *   - `callFault`: the WHOLE dispatch's routing failed pre-persist. It is NOT
 *     consumed per task — every verdict task of the call is blocked — and is
 *     removed only by whole-call retirement.
 *   - `taskKeys`: per-task keys (the routing-time task id, which may be an
 *     `unresolved-<callID>` fallback). Consulted with per-key consumption so a
 *     multi-key record blocks each named task exactly once.
 *
 * Lifetime: a record lives only from fault to terminal outcome. It is RETIRED
 * (deleted entirely, with empty session/directory containers pruned) at
 * exactly two owner families: (i) the FOREGROUND toolAfter settlement loop end
 * plus its terminal cleanup paths (denied calls, failed outputs — see
 * delegation-gate.ts), and (ii) the BACKGROUND completion observer's
 * post-commit confirmation (the only background retirement owner; consults in
 * stage-b-gates BLOCK but never retire). There is deliberately NO sessionEnded
 * pruning (sessionEnded also fires for session.idle; records are bounded by
 * retirement and the loud caps below, not by session lifetime).
 *
 * Capacity is FAIL-CLOSED, never evictive: when a bound is full the RECORD
 * operation returns false and the caller refuses the dispatch
 * (ROUTE_INVALIDATION_CAPACITY). No pre-existing marker is ever dropped —
 * an unconsumed invalidation always survives to its settlement consult.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactPath } from '../hooks/guardrails/audit-log.js';
import * as logger from '../utils/logger.js';

export const MAX_LIVE_CALLS_PER_SESSION = 256;
export const MAX_LIVE_SESSIONS_PER_DIRECTORY = 128;
export const MAX_LIVE_DIRECTORIES = 64;

/** One call's invalidation state (see module doc). */
interface RouteInvalidationCallRecord {
	taskKeys: Set<string>;
	callFault: boolean;
}

const registryByDirectory = new Map<
	string,
	Map<string, Map<string, RouteInvalidationCallRecord>>
>();

/**
 * Canonical directory key. `fs.realpathSync` canonicalizes junctions/case
 * (a bare `path.resolve` does not — two spellings of one root must share one
 * registry entry); a not-yet-existing root falls back to resolve so a fault
 * recorded between mkdir and first realpath still keys consistently.
 */
function canonicalDirectory(directory: string): string {
	try {
		return fs.realpathSync(directory);
	} catch {
		return path.resolve(directory);
	}
}

function describeCapacityBound(
	missed: 'calls' | 'sessions' | 'directories',
): string {
	if (missed === 'calls') {
		return `MAX_LIVE_CALLS_PER_SESSION=${MAX_LIVE_CALLS_PER_SESSION}`;
	}
	if (missed === 'sessions') {
		return `MAX_LIVE_SESSIONS_PER_DIRECTORY=${MAX_LIVE_SESSIONS_PER_DIRECTORY}`;
	}
	return `MAX_LIVE_DIRECTORIES=${MAX_LIVE_DIRECTORIES}`;
}

/**
 * Find (or admit) the call record. Returns null — WITHOUT mutating anything —
 * when a capacity bound refuses the admission; the caller then fails closed.
 */
function ensureCallRecord(
	directory: string,
	sessionId: string,
	callID: string,
): RouteInvalidationCallRecord | null {
	const key = canonicalDirectory(directory);
	let sessions = registryByDirectory.get(key);
	if (!sessions) {
		if (registryByDirectory.size >= MAX_LIVE_DIRECTORIES) return null;
		sessions = new Map();
		registryByDirectory.set(key, sessions);
	}
	let calls = sessions.get(sessionId);
	if (!calls) {
		if (sessions.size >= MAX_LIVE_SESSIONS_PER_DIRECTORY) return null;
		calls = new Map();
		sessions.set(sessionId, calls);
	}
	let record = calls.get(callID);
	if (!record) {
		if (calls.size >= MAX_LIVE_CALLS_PER_SESSION) return null;
		record = { taskKeys: new Set<string>(), callFault: false };
		calls.set(callID, record);
	}
	return record;
}

/**
 * Which capacity bound a refused admission hit (for the operator signal),
 * probed in admission order.
 */
function probeCapacityMiss(
	directory: string,
	sessionId: string,
): 'calls' | 'sessions' | 'directories' {
	const sessions = registryByDirectory.get(canonicalDirectory(directory));
	if (!sessions) return 'directories';
	if (!sessions.get(sessionId)) return 'sessions';
	return 'calls';
}

function warnCapacityRefusal(
	operation: string,
	directory: string,
	sessionId: string,
	callID: string,
	probe: 'calls' | 'sessions' | 'directories',
): void {
	// Loud by design (AGENTS.md invariant 8): a silent capacity miss would let
	// the next dispatch through unprotected. The directory is operator-relevant
	// project state, bounded and home-path redacted like every other warn
	// surface (#3516 item 11 posture).
	const boundedDirectory = redactPath(directory).slice(0, 120);
	logger.criticalWarn(
		`[route-invalidation-registry] refusing to record ${operation} for call ${callID.slice(0, 64)} (session ${sessionId.slice(0, 64)}, dir ${boundedDirectory}): registry bound reached (${describeCapacityBound(
			probe,
		)}); the dispatch must be refused fail-closed (no marker was evicted)`,
	);
}

/**
 * Record that THIS call's routing faulted before its pending receipt
 * persisted. Returns false (recording nothing) when a capacity bound is full —
 * callers must then refuse the dispatch (fail-closed admission).
 */
export function recordRouteFault(
	directory: string,
	sessionId: string,
	callID: string,
): boolean {
	const admitted = ensureCallRecord(directory, sessionId, callID);
	if (!admitted) {
		warnCapacityRefusal(
			'route fault',
			directory,
			sessionId,
			callID,
			probeCapacityMiss(directory, sessionId),
		);
		return false;
	}
	admitted.callFault = true;
	return true;
}

/**
 * Record a per-task invalidation key for the call (the routing-time task id,
 * including the `unresolved-<callID>` fallback). Returns false at capacity.
 */
export function recordRouteInvalidation(
	directory: string,
	sessionId: string,
	callID: string,
	taskKey: string,
): boolean {
	const admitted = ensureCallRecord(directory, sessionId, callID);
	if (!admitted) {
		warnCapacityRefusal(
			'route invalidation',
			directory,
			sessionId,
			callID,
			probeCapacityMiss(directory, sessionId),
		);
		return false;
	}
	admitted.taskKeys.add(taskKey);
	return true;
}

/**
 * Settlement-side consult: is THIS call blocked for THIS verdict task? The
 * whole-call fault blocks every task (not consumed per task — only whole-call
 * retirement removes it); otherwise the per-task key set is consulted with
 * per-key consumption. Unknown call/task consults return false and mutate
 * nothing.
 */
export function isRouteBlockedForSettlement(
	directory: string,
	callID: string,
	sessionId: string,
	taskId: string,
): boolean {
	const record = registryByDirectory
		.get(canonicalDirectory(directory))
		?.get(sessionId)
		?.get(callID);
	if (!record) return false;
	if (record.callFault) return true;
	return record.taskKeys.delete(taskId);
}

/**
 * Retire the call's record at its terminal outcome (foreground settlement
 * loop end / terminal cleanup, or the background observer's confirmed
 * consumed commit). Empty session maps and empty directory entries are
 * deleted so settled traffic leaves no residue (invariant 8).
 */
export function retireRouteInvalidationsForCall(
	directory: string,
	sessionId: string,
	callID: string,
): void {
	const key = canonicalDirectory(directory);
	const sessions = registryByDirectory.get(key);
	if (!sessions) return;
	const calls = sessions.get(sessionId);
	if (!calls) return;
	calls.delete(callID);
	if (calls.size === 0) sessions.delete(sessionId);
	if (sessions.size === 0) registryByDirectory.delete(key);
}

/**
 * Session-agnostic retirement sweep for callers that know the directory and
 * callID but not the session (the failed-output terminal path). Scans at most
 * MAX_LIVE_SESSIONS_PER_DIRECTORY entries; prunes empty containers.
 */
export function retireRouteInvalidationsForCallInDirectory(
	directory: string,
	callID: string,
): void {
	const key = canonicalDirectory(directory);
	const sessions = registryByDirectory.get(key);
	if (!sessions) return;
	for (const [sessionId, calls] of sessions) {
		calls.delete(callID);
		if (calls.size === 0) sessions.delete(sessionId);
	}
	if (sessions.size === 0) registryByDirectory.delete(key);
}

/** Test-only: drop the entire registry (also wired into resetSwarmState). */
export const _test_exports = {
	reset(): void {
		registryByDirectory.clear();
	},
	/** Read-only size probes for capacity assertions. */
	size(): number {
		return registryByDirectory.size;
	},
	sessionCount(directory: string): number {
		return registryByDirectory.get(canonicalDirectory(directory))?.size ?? 0;
	},
	callCount(directory: string, sessionId: string): number {
		return (
			registryByDirectory
				.get(canonicalDirectory(directory))
				?.get(sessionId)?.size ?? 0
		);
	},
};
