/**
 * Tool to configure the QA gate profile for the current plan.
 *
 * Architect-only: invoked during the QA GATE SELECTION phase of brainstorm
 * mode (or equivalent). Ratchet-tighter only — cannot disable gates that are
 * already enabled. Rejects all writes once the profile is locked.
 *
 * Creates the profile with defaults if missing, then applies the requested
 * partial update.
 */
import type { tool } from '@opencode-ai/plugin';
export interface SetQaGatesArgs {
    reviewer?: boolean;
    test_engineer?: boolean;
    council_mode?: boolean;
    sme_enabled?: boolean;
    critic_pre_plan?: boolean;
    hallucination_guard?: boolean;
    sast_enabled?: boolean;
    mutation_test?: boolean;
    council_general_review?: boolean;
    drift_check?: boolean;
    final_council?: boolean;
    project_type?: string;
}
interface SetQaGatesResult {
    success: boolean;
    reason?: string;
    message?: string;
    plan_id?: string;
    profile?: {
        plan_id: string;
        gates: Record<string, boolean>;
        locked_at: string | null;
        locked_by_snapshot_seq: number | null;
        profile_hash: string;
    };
}
export declare function executeSetQaGates(args: SetQaGatesArgs, directory: string): Promise<SetQaGatesResult>;
export declare const set_qa_gates: ReturnType<typeof tool>;
export {};
