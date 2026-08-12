/**
 * Session-keyed bounded accumulator for DrainSummary counts (issue #1821, task 1.2).
 *
 * The admission drain computes per-drain tallies (admitted, reinforced, rejected)
 * that are currently logged to stderr via the debug gate and then discarded. This
 * module stashes those counts in an in-memory, session-keyed map so they can be
 * wired into the session-reflection report at finalize time.
 *
 * Follows AGENTS.md invariant 8: keyed by sessionID, bounded by
 * `MAX_TRACKED_SESSIONS` with FIFO eviction, same pattern as
 * `candidate-queue.ts`. Performs NO I/O and holds no clock dependency.
 *
 * In-memory only (not disk) — preserves Phase A zero-write contract.
 */

import type { DrainSummary } from './admission.js';

/** Hard ceiling on distinct sessions tracked at once. Mirrors candidate-queue.ts. */
const MAX_TRACKED_SESSIONS = 500;

/**
 * Accumulated drain counters for a session. Tracks the three positive outcomes
 * (admitted, reinforced, rejected) that the reflection report surfaces.
 */
export interface DrainCounters {
	admitted: number;
	reinforced: number;
	rejected: number;
}

const countersBySession = new Map<string, DrainCounters>();

function createCounters(): DrainCounters {
	return { admitted: 0, reinforced: 0, rejected: 0 };
}

/**
 * Stash drain counts from a DrainSummary into the session-keyed map.
 *
 * Accumulates (adds to existing counters) rather than replacing, because a
 * session may have multiple drain cycles. Each drain's admitted/reinforced/
 * rejected are added to the running total.
 *
 * Fail-open: invalid sessionID is silently ignored, matching the precedent
 * in candidate-queue.ts `enqueueCandidate`.
 */
export function stashDrainSummary(
	sessionID: string,
	summary: DrainSummary,
): void {
	if (typeof sessionID !== 'string' || sessionID.length === 0) return;
	if (!summary) return;

	let counters = countersBySession.get(sessionID);
	if (!counters) {
		counters = createCounters();
		countersBySession.set(sessionID, counters);
		// FIFO-cap the KEY count to bound memory. Skip evicting the entry
		// we just created, matching candidate-queue.ts getOrCreateQueue.
		while (countersBySession.size > MAX_TRACKED_SESSIONS) {
			const oldest = countersBySession.keys().next().value;
			if (oldest === undefined || oldest === sessionID) break;
			countersBySession.delete(oldest);
		}
	}

	counters.admitted += summary.admitted;
	counters.reinforced += summary.reinforced;
	counters.rejected += summary.rejected;
}

/**
 * Retrieve accumulated drain counters for a session. Returns undefined for
 * unknown sessions (no drain has occurred).
 */
export function getDrainCounters(sessionID: string): DrainCounters | undefined {
	if (typeof sessionID !== 'string' || sessionID.length === 0) return undefined;
	return countersBySession.get(sessionID);
}

/** Drop one session's counters, or every session when `sessionID` is omitted. */
export function resetDrainCounters(sessionID?: string): void {
	if (sessionID === undefined) {
		countersBySession.clear();
		return;
	}
	countersBySession.delete(sessionID);
}

/** Number of distinct sessions currently tracked. Test seam. */
function getTrackedSessionCount(): number {
	return countersBySession.size;
}

/**
 * Tier-0 DI seam (AGENTS.md invariant 7, writing-tests skill).
 * Exports internals that have no production callers but are needed for tests.
 */
export const _internals = {
	MAX_TRACKED_SESSIONS,
	getTrackedSessionCount,
};
