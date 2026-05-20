/**
 * Lean Turbo Stage B bypass verification.
 *
 * Provides a synchronous helper to check whether a task is eligible for
 * Lean Turbo Stage B bypass — i.e., whether it can be marked completed
 * without running the full reviewer + test_engineer gate.
 */
import { listActiveLocks } from '../../parallel/file-locks';
/**
 * Test-only seam. Replaces the lock-list function so tests can inject
 * mock results without touching the real `file-locks` module.
 */
export declare const _internals: {
    listActiveLocks: typeof listActiveLocks;
    verifyLeanTurboTaskCompletion: typeof verifyLeanTurboTaskCompletion;
};
/**
 * Result of the Lean Turbo task completion eligibility check.
 */
export interface LeanTurboTaskCompletionResult {
    ok: boolean;
    reason: string;
    laneFound?: boolean;
    evidence?: {
        laneId: string;
        laneStatus: string;
        taskIds: string[];
    };
}
/**
 * Synchronously verify whether a task is eligible for Lean Turbo Stage B bypass.
 *
 * Checks are performed in fail-fast order:
 *  1. Read `.swarm/turbo-state.json` — missing/unreadable → ok: false
 *  2. Find a Lean Turbo run state (strategy === 'lean' AND status === 'running')
 *     → none found → ok: false
 *     If sessionID is provided, also require sessionID to match
 *  3. Find the lane containing taskId in runState.lanes → none → ok: false
 *  4. Check if task is in runState.degradedTasks → yes → ok: false with degradation reason
 *  5. Check lane.status === 'completed' → not completed → ok: false
 *  6. Check lane evidence file exists at `.swarm/evidence/{phase}/lean-turbo/{laneId}.json`
 *     → missing → ok: false
 *  7. Check for active file locks on this lane → any active → ok: false
 *  8. Read plan.json to get task's files_touched and check Tier-3 patterns → matched → ok: false
 *  9. All checks pass → ok: true
 *
 * @param directory - Project root directory
 * @param taskId    - Task ID to verify
 * @param sessionID - Optional session ID to scope which Lean Turbo session may grant bypass.
 *                    When provided, only a running Lean Turbo session with a matching sessionID
 *                    can grant bypass — preventing cross-session Stage B bypass.
 */
export declare function verifyLeanTurboTaskCompletion(directory: string, taskId: string, sessionID?: string): LeanTurboTaskCompletionResult;
