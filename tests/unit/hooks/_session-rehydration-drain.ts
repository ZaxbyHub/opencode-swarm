/**
 * Shared fixture helper for the route suites (#3380 / #3509 / #3516 and the
 * exemption regressions).
 *
 * `ensureAgentSession(…, dir)` fires an ASYNC rehydration
 * (`rehydrateSessionFromDisk` → `applyRehydrationCache`, src/state.ts) that
 * applies durable-evidence- or plan-derived workflow states to the session
 * when it lands. If it lands while a fixture is mid-seed (the durable state
 * is temporarily `coder_delegated` between `accepted_mutation` and
 * `stage_a_passed`), it overwrites the session's workflow view and the
 * fixture's manual `advanceTaskState` then throws
 * `INVALID_TASK_STATE_TRANSITION: … coder_delegated → coder_delegated` — the
 * historical flake in these suites. Draining the in-flight rehydrations
 * right after session creation (BEFORE any durable seeding) makes the
 * rehydration only ever see the empty, plan-only pre-seed state.
 */
import { ensureAgentSession, swarmState } from '../../../src/state';

export async function ensureSessionDrained(
	sessionId: string,
	dir: string,
): Promise<void> {
	ensureAgentSession(sessionId, 'architect', dir);
	await Promise.allSettled([...swarmState.pendingRehydrations]);
}
