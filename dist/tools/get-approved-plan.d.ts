/**
 * Tool to retrieve the last critic-approved immutable plan snapshot.
 *
 * Wraps `loadLastApprovedPlan` from `src/plan/ledger.ts` as a tool callable
 * by the critic `phase_drift_verifier` agent. Enables active baseline drift
 * comparison: the drift verifier can compare the immutable approved snapshot
 * against the current `plan.json` to detect silent plan mutations introduced
 * after approval.
 *
 * The tool internally derives `plan_id` from the current plan for
 * cross-identity safety — the caller does not need to know the format.
 *
 * Read-only: no file writes.
 *
 * @see https://github.com/zaxbysauce/opencode-swarm/issues/449
 */
import type { tool } from '@opencode-ai/plugin';
interface GetApprovedPlanResult {
    success: boolean;
    reason?: string;
    approved_plan?: ApprovedPlanPayload;
    current_plan?: CurrentPlanPayload | null;
    drift_detected?: boolean | 'unknown';
    current_plan_error?: string;
    /** SHA-256 hex digest over {plan_id, gates} of the current QA gate profile,
     *  or null when no profile exists for this plan. Used by the critic to
     *  detect silent gate mutations post-approval. */
    qa_profile_hash?: string | null;
}
interface ApprovedPlanPayload {
    plan: unknown;
    approval_metadata: Record<string, unknown> | undefined;
    snapshot_seq: number;
    snapshot_timestamp: string;
    payload_hash: string;
    /** The execution_profile from the approved snapshot, if any. */
    execution_profile?: {
        parallelization_enabled: boolean;
        max_concurrent_tasks: number;
        council_parallel: boolean;
        locked: boolean;
    } | null;
}
interface CurrentPlanPayload {
    plan: unknown;
    current_hash: string;
}
/**
 * Core execution logic — exported for direct testing.
 */
export declare function executeGetApprovedPlan(args: {
    summary_only?: boolean;
}, directory: string): Promise<GetApprovedPlanResult>;
export declare const get_approved_plan: ReturnType<typeof tool>;
export {};
