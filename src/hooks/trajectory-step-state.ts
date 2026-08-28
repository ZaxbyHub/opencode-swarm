/**
 * Module-level trajectory step counters shared by runtime reset code and the
 * trajectory logger without creating a state <-> hook import cycle.
 *
 * Keys are canonical-root + session id (issue #2041 Required 6): the counters
 * are process-global module state, so a host that loads one plugin module
 * instance for several project roots must not let two roots' sessions with
 * the same host session id share a counter — nor let two aliases of one root
 * diverge. The shared `src/utils/canonical-root.ts` helper owns the keying so
 * the trajectory store, these counters, and the logger's restart-seed gate
 * cannot drift. `directory` is required on the minting/seed path; the clear
 * paths may omit it and suffix-scan every root, because the reset entry
 * points legitimately lack a directory.
 */

import { compositeSessionKey, sessionKeySuffix } from '../utils/canonical-root';

const MAX_TRACKED_STEP_SESSIONS = 500;

const sessionStepCounters = new Map<string, number>();

/**
 * Bumped whenever counters are cleared or reset. The logger's restart-seed
 * gate folds this into its keys, so ANY counter invalidation — including
 * `resetSwarmState`'s direct `clearTrajectoryStepCounters()` here in module
 * state, which does not go through the logger's own gate-invalidating entry
 * points — structurally forces the next mint to re-seed from the persisted
 * high-water mark instead of minting duplicate step 1s (maintainer review
 * #2395 / PRR-013).
 */
let stepCounterGeneration = 0;

/** Current step-counter generation (changes on every clear/reset). */
export function trajectoryStepGeneration(): number {
	return stepCounterGeneration;
}

function bumpStepCounterGeneration(): void {
	stepCounterGeneration += 1;
}

function evictOldestStepSessionIfNeeded(key: string): void {
	if (sessionStepCounters.has(key)) return;
	while (sessionStepCounters.size >= MAX_TRACKED_STEP_SESSIONS) {
		const oldestSessionId = sessionStepCounters.keys().next().value;
		if (oldestSessionId === undefined) break;
		sessionStepCounters.delete(oldestSessionId);
	}
}

/**
 * Mints the next sequential step for a session. Restart continuity is the
 * logger's job (`ensureSessionStepSeeded` in trajectory-logger.ts seeds the
 * counter from the bounded store before the first mint), not this counter's.
 */
export function nextTrajectoryStep(
	sessionId: string,
	directory: string,
): number {
	const key = compositeSessionKey(directory, sessionId);
	evictOldestStepSessionIfNeeded(key);
	const step = (sessionStepCounters.get(key) ?? 0) + 1;
	sessionStepCounters.set(key, step);
	return step;
}

/**
 * Raises a session's counter to `step` when it is higher than the current
 * value. Used by the restart-seed path so a resumed session continues minting
 * monotonically after the on-disk high-water mark instead of restarting at 1
 * (which would duplicate step numbers against the persisted trajectory).
 * A lower value never lowers the counter (issue #2041 monotonicity).
 */
export function seedTrajectoryStepCounter(
	sessionId: string,
	directory: string,
	step: number,
): void {
	if (!Number.isFinite(step) || step <= 0) return;
	const key = compositeSessionKey(directory, sessionId);
	evictOldestStepSessionIfNeeded(key);
	const current = sessionStepCounters.get(key) ?? 0;
	if (step > current) {
		sessionStepCounters.set(key, Math.floor(step));
	}
}

/**
 * Resets the step counter for a session to zero (module-level semantics —
 * "restart at step one"). The production reset entry points go through
 * trajectory-logger.ts, which also invalidates the per-process restart-seed
 * gate so the next mint re-seeds from disk and steps stay monotonic against
 * the persisted trajectory.
 */
export function resetTrajectoryStepCounter(
	sessionId: string,
	directory: string,
): void {
	const key = compositeSessionKey(directory, sessionId);
	evictOldestStepSessionIfNeeded(key);
	sessionStepCounters.set(key, 0);
	bumpStepCounterGeneration();
}

/**
 * Clears trajectory step counters for one session (every canonical root — the
 * reset entry points legitimately lack a directory), or all sessions when
 * omitted.
 */
export function clearTrajectoryStepCounters(sessionId?: string): void {
	if (sessionId !== undefined) {
		const suffix = sessionKeySuffix(sessionId);
		let removed = false;
		for (const key of sessionStepCounters.keys()) {
			if (key.endsWith(suffix)) {
				sessionStepCounters.delete(key);
				removed = true;
			}
		}
		if (removed) bumpStepCounterGeneration();
	} else if (sessionStepCounters.size > 0) {
		sessionStepCounters.clear();
		bumpStepCounterGeneration();
	}
}

export const _test_exports = {
	MAX_TRACKED_STEP_SESSIONS,
	getTrackedStepSessionCount: () => sessionStepCounters.size,
	/** Whether a counter exists for this session+root in this process. */
	hasTrajectoryStepCounter: (sessionId: string, directory: string) =>
		sessionStepCounters.has(compositeSessionKey(directory, sessionId)),
	/** Current generation (test seam: gate-invalidation assertions). */
	getStepCounterGeneration: () => stepCounterGeneration,
};
