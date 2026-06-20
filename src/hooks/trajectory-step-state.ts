/**
 * Module-level trajectory step counters shared by runtime reset code and the
 * trajectory logger without creating a state <-> hook import cycle.
 */

const MAX_TRACKED_STEP_SESSIONS = 500;
const sessionStepCounters = new Map<string, number>();

function evictOldestStepSessionIfNeeded(sessionId: string): void {
	if (sessionStepCounters.has(sessionId)) return;
	while (sessionStepCounters.size >= MAX_TRACKED_STEP_SESSIONS) {
		const oldestSessionId = sessionStepCounters.keys().next().value;
		if (oldestSessionId === undefined) break;
		sessionStepCounters.delete(oldestSessionId);
	}
}

export function nextTrajectoryStep(sessionId: string): number {
	evictOldestStepSessionIfNeeded(sessionId);
	const step = (sessionStepCounters.get(sessionId) ?? 0) + 1;
	sessionStepCounters.set(sessionId, step);
	return step;
}

export function resetTrajectoryStepCounter(sessionId: string): void {
	evictOldestStepSessionIfNeeded(sessionId);
	sessionStepCounters.set(sessionId, 0);
}

export function clearTrajectoryStepCounters(sessionId?: string): void {
	if (sessionId !== undefined) {
		sessionStepCounters.delete(sessionId);
	} else {
		sessionStepCounters.clear();
	}
}

export const _test_exports = {
	MAX_TRACKED_STEP_SESSIONS,
	getTrackedStepSessionCount: () => sessionStepCounters.size,
};
