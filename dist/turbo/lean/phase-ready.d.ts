/**
 * Lean Turbo Phase Boundary Gate Verification.
 *
 * Provides a synchronous helper to check whether a Lean Turbo phase is ready
 * to advance to the next phase — i.e., whether all gates (lane completion,
 * lock clearance, degraded task resolution, reviewer/critic approval) have
 * been satisfied.
 */
import { listActiveLocks } from '../../parallel/file-locks';
import { listLaneEvidence } from './evidence';
import { readPersisted } from './state';
/**
 * Configuration options for phase gate checks.
 * Passed optionally so callers can control whether reviewer/critic checks run.
 */
export interface LeanTurboPhaseReadyConfig {
    phase_reviewer?: boolean;
    phase_critic?: boolean;
    integrated_diff_required?: boolean;
}
/**
 * Result of the Lean Turbo phase readiness check.
 */
export interface LeanTurboPhaseReadyResult {
    ok: boolean;
    reason: string;
    evidence?: {
        lanes: string[];
        degradedTasks: string[];
        reviewerVerdict?: string;
        criticVerdict?: string;
    };
}
/**
 * Shape of the plan.json file read by _internals.readPlanJson.
 */
interface PlanJson {
    phases: Array<{
        id?: number;
        tasks: Array<{
            id: string;
            status: string;
        }>;
    }>;
}
/**
 * Shape of the reviewer evidence file (lean-turbo-reviewer.json).
 */
interface ReviewerEvidence {
    phase: number;
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
    reason?: string | null;
    timestamp: string;
}
/**
 * Shape of the critic evidence file (lean-turbo-critic.json).
 */
interface CriticEvidence {
    phase: number;
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN';
    reason?: string | null;
    timestamp: string;
}
/**
 * Test-only seam. Replaces the lock-list and state-load functions so tests
 * can inject mock results without touching the real `file-locks` module or
 * the module-level `stateUnreadable` flag used by `loadLeanTurboRunState`.
 */
export declare const _internals: {
    listActiveLocks: typeof listActiveLocks;
    readPersisted: typeof readPersisted;
    readPlanJson: (dir: string) => PlanJson | null;
    readReviewerEvidence: (dir: string, phase: number) => ReviewerEvidence | null;
    readCriticEvidence: (dir: string, phase: number) => CriticEvidence | null;
    listLaneEvidence: typeof listLaneEvidence;
    listLaneEvidenceSync: (dir: string, phase: number) => string[];
    verifyLeanTurboPhaseReady: typeof verifyLeanTurboPhaseReady;
};
/**
 * Synchronously verify whether a Lean Turbo phase is ready to advance.
 *
 * Checks are performed in fail-fast order:
 *  1. Read `.swarm/turbo-state.json` via readPersisted → null/unreadable → ok: false
 *  2. Find a session with status === 'running' and phase === args.phase and strategy === 'lean'
 *     If sessionID is provided, also require sessionId === sessionID → none → ok: false
 *  3. Validate session.lanes is a non-empty array → empty → ok: false
 *  4. Check all eligible lanes have status 'completed' or 'failed' → not → ok: false
 *  5. Check no active lane locks exist for lanes in this phase → locks → ok: false
 *  6. Check all degraded tasks in lane plan are resolved → pending/in_progress → ok: false
 *  7. Check integrated diff evidence exists (when required) → missing → ok: false
 *  8. Check reviewer approval if phase_reviewer enabled → missing/rejected → ok: false
 *  9. Check critic approval if phase_critic enabled → missing/rejected → ok: false
 *  10. All checks pass → ok: true
 *
 * Supports two calling conventions for backward compatibility:
 * - New: verifyLeanTurboPhaseReady(dir, phase, sessionID?, config?)
 * - Legacy: verifyLeanTurboPhaseReady(dir, phase, config?) — config was previously the 3rd param
 *
 * @param directory - Project root directory
 * @param phase     - Phase number to verify readiness for
 * @param sessionIDOrConfig - Optional session ID (string) OR config object (legacy 3rd-param style)
 * @param config    - Optional config; defaults to { phase_reviewer: true, phase_critic: true, integrated_diff_required: true }
 */
export declare function verifyLeanTurboPhaseReady(directory: string, phase: number, sessionIDOrConfig?: string | LeanTurboPhaseReadyConfig, config?: LeanTurboPhaseReadyConfig): LeanTurboPhaseReadyResult;
export {};
