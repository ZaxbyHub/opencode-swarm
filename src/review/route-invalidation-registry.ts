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
 * Storage is keyed by a canonical project directory key (see
 * {@link canonicalDirectory}: realpath when it resolves, else a
 * `lexical:`-prefixed resolve, MEMOIZED PER INPUT SPELLING so record, consult,
 * and retirement always derive the same key; degenerate inputs share one
 * sentinel key and never throw) → sessionID → callID. A call's record
 * carries:
 *   - `callFault`: the WHOLE dispatch's routing failed pre-persist. It is NOT
 *     consumed per task — every verdict task of the call is blocked — and is
 *     removed only by whole-call retirement.
 *   - `taskKeys`: per-task keys (the routing-time task id, which may be an
 *     `unresolved-<callID>` fallback). Consulted with per-key consumption so a
 *     multi-key record blocks each named task exactly once.
 *
 * Lifetime: a record lives only from fault to terminal outcome. It is RETIRED
 * (deleted entirely, with empty session/directory containers pruned) through
 * structurally guaranteed owners (#3564): every admitted record carries a
 * retirement obligation, every retirement path discharges it, and the
 * FOREGROUND toolAfter finally flushes whatever remains unless the call's
 * ownership was deliberately deferred to the BACKGROUND completion observer
 * (a durable, consumable, gate-bearing record). Background ownership ends at
 * the observer's post-commit confirmation, the pending-record stale-sweep
 * discharge (a swept record can never consult again), or the observer's
 * terminal/promotion-failure arms; a marker DELIBERATELY retained after a
 * failed ingestion commit (#3509 replay-refusal) keeps waiting for its
 * replay. There is deliberately NO sessionEnded pruning (sessionEnded also
 * fires for session.idle; records are bounded by retirement and the loud caps
 * below, not by session lifetime).
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
 * #3564: retirement obligations — the structural half of marker lifecycle.
 * Every ADMITTED call record carries a retirement obligation from birth
 * (registered at ensureCallRecord admission, after every capacity refusal);
 * every retirement path discharges it unconditionally (even when the marker is
 * already gone); flushRouteRetirementObligation is the toolAfter-level
 * backstop that makes leaving a recorded marker with no reachable retirement
 * owner impossible. The index mirrors the registry's own
 * directory→session→callID identity (never a bare callID) and is structurally
 * bounded by the registry itself: obligations exist only for admitted records
 * and are deleted by every retirement path, so the index can never outgrow the
 * capped registry (no eviction, matching the never-evictive capacity posture).
 */
const retirementObligationsByDirectory = new Map<
	string,
	Map<string, Set<string>>
>();

function registerRetirementObligation(
	directory: string,
	sessionId: string,
	callID: string,
): void {
	const key = canonicalDirectory(directory);
	let sessions = retirementObligationsByDirectory.get(key);
	if (!sessions) {
		sessions = new Map();
		retirementObligationsByDirectory.set(key, sessions);
	}
	let calls = sessions.get(sessionId);
	if (!calls) {
		calls = new Set();
		sessions.set(sessionId, calls);
	}
	calls.add(callID);
}

function dischargeRetirementObligation(
	directory: string,
	sessionId: string | undefined,
	callID: string,
): void {
	const key = canonicalDirectory(directory);
	if (sessionId !== undefined) {
		const calls = retirementObligationsByDirectory.get(key)?.get(sessionId);
		if (!calls) return;
		calls.delete(callID);
		if (calls.size === 0)
			retirementObligationsByDirectory.get(key)?.delete(sessionId);
		if ((retirementObligationsByDirectory.get(key)?.size ?? 0) === 0)
			retirementObligationsByDirectory.delete(key);
		return;
	}
	// Session-agnostic sweep (mirrors retireRouteInvalidationsForCallInDirectory).
	const sessions = retirementObligationsByDirectory.get(key);
	if (!sessions) return;
	for (const [sid, calls] of sessions) {
		calls.delete(callID);
		if (calls.size === 0) sessions.delete(sid);
	}
	if (sessions.size === 0) retirementObligationsByDirectory.delete(key);
}

/**
 * #3564 structural backstop: if the call's marker still carries an
 * outstanding retirement obligation, retire it now (session-keyed when the
 * session is known, session-agnostic directory sweep otherwise) and discharge
 * the obligation. Idempotent no-op when the obligation is already discharged.
 */
export function flushRouteRetirementObligation(
	directory: string,
	sessionId: string | undefined,
	callID: string,
): void {
	const key = canonicalDirectory(directory);
	const hasObligation =
		sessionId !== undefined
			? retirementObligationsByDirectory.get(key)?.get(sessionId)?.has(callID)
			: [...(retirementObligationsByDirectory.get(key)?.values() ?? [])].some(
					(calls) => calls.has(callID),
				);
	if (!hasObligation) return;
	if (sessionId !== undefined) {
		retireRouteInvalidationsForCall(directory, sessionId, callID);
	} else {
		retireRouteInvalidationsForCallInDirectory(directory, callID);
	}
}

/**
 * Degenerate-directory sentinel: hook construction tolerates a non-string
 * directory (`initDurableStatusPath` early-returns), and the adversarial
 * contract (src/hooks/delegation-gate.plan-fallback-security.test.ts)
 * requires degenerate inputs never crash toolBefore/toolAfter. All operations
 * for such a directory (non-string OR empty) share this ONE key, so
 * record/consult/retire stay mutually consistent and capacity accounting
 * still bounds them.
 */
const DEGENERATE_DIRECTORY_KEY =
	'\u0000route-invalidation:degenerate-directory';

/**
 * Directory keys are MEMOIZED PER INPUT SPELLING, first computation wins
 * (PRR-002): recomputing per operation let realpath succeed on one side and
 * fail on the other (not-yet-existing root, transient Windows EPERM/EBUSY),
 * storing the marker under a lexical key but consulting under a realpath key
 * — a silent fail-open consult plus a slot leak (junction probe, review
 * pr3553-20261003). realpathSync does NOT canonicalize filename case on every
 * runtime (Bun/Windows preserves input case), so two spellings of one root
 * can still key differently; production always passes a single spelling
 * (`bootstrapRoot`), and per-spelling memoization keeps every operation for
 * that spelling mutually consistent.
 */
const MAX_MEMOIZED_DIRECTORY_KEYS = 64;
const directoryKeyBySpelling = new Map<string, string>();

function canonicalDirectory(rawSpelling: string): string {
	// The parameter is named rawSpelling deliberately: this map keys by the
	// CALLER'S INPUT SPELLING (not a canonical project identity — that is the
	// whole point of the memo), which also keeps check:path-identity's
	// project-key rule (raw path-resolve results as project keys) out of this
	// by-design raw-keyed table.
	if (typeof rawSpelling !== 'string' || rawSpelling.length === 0) {
		return DEGENERATE_DIRECTORY_KEY;
	}
	const memoized = directoryKeyBySpelling.get(rawSpelling);
	if (memoized !== undefined) return memoized;
	let key: string;
	try {
		key = fs.realpathSync(rawSpelling);
	} catch {
		// First-computation-wins: freeze the lexical key for this spelling so a
		// realpath that starts succeeding mid-dispatch cannot flip the key
		// between record and consult/retire. The `lexical:` prefix keeps a
		// fallback key from colliding with any realpath-derived key.
		key = `lexical:${path.resolve(rawSpelling)}`;
	}
	directoryKeyBySpelling.set(rawSpelling, key);
	while (directoryKeyBySpelling.size > MAX_MEMOIZED_DIRECTORY_KEYS) {
		const oldest = directoryKeyBySpelling.keys().next().value;
		if (oldest === undefined) break;
		directoryKeyBySpelling.delete(oldest);
	}
	return key;
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
	// #3564: admission succeeded — the call's marker now carries its retirement
	// obligation from birth (registered only here, after every capacity
	// refusal, so a refused record never creates one).
	registerRetirementObligation(directory, sessionId, callID);
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
	if (!sessions) {
		// #3564: discharge unconditionally — a late or double retirement must
		// never leave a stale obligation behind just because the marker is
		// already gone.
		dischargeRetirementObligation(directory, sessionId, callID);
		return;
	}
	const calls = sessions.get(sessionId);
	if (!calls) {
		dischargeRetirementObligation(directory, sessionId, callID);
		return;
	}
	calls.delete(callID);
	if (calls.size === 0) sessions.delete(sessionId);
	if (sessions.size === 0) registryByDirectory.delete(key);
	dischargeRetirementObligation(directory, sessionId, callID);
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
	if (!sessions) {
		dischargeRetirementObligation(directory, undefined, callID);
		return;
	}
	for (const [sessionId, calls] of sessions) {
		calls.delete(callID);
		if (calls.size === 0) sessions.delete(sessionId);
	}
	if (sessions.size === 0) registryByDirectory.delete(key);
	dischargeRetirementObligation(directory, undefined, callID);
}

/** Test-only: drop the entire registry (also wired into resetSwarmState). */
export const _test_exports = {
	reset(): void {
		registryByDirectory.clear();
		directoryKeyBySpelling.clear();
		retirementObligationsByDirectory.clear();
	},
	/** Read-only size probes for capacity assertions. */
	size(): number {
		return registryByDirectory.size;
	},
	sessionCount(directory: string): number {
		return registryByDirectory.get(canonicalDirectory(directory))?.size ?? 0;
	},
	/** #3564: read-only obligation probes for structural-ownership assertions. */
	hasObligation(
		directory: string,
		sessionId: string | undefined,
		callID: string,
	): boolean {
		const sessions = retirementObligationsByDirectory.get(
			canonicalDirectory(directory),
		);
		if (!sessions) return false;
		if (sessionId !== undefined)
			return sessions.get(sessionId)?.has(callID) ?? false;
		for (const calls of sessions.values()) if (calls.has(callID)) return true;
		return false;
	},
};
