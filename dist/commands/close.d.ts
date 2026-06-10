interface PlanPhase {
    id: number;
    name: string;
    status: string;
    tasks: Array<{
        id: string;
        status: string;
        close_reason?: string;
    }>;
}
interface PlanData {
    title: string;
    phases: PlanPhase[];
}
interface CloseCommandOptions {
    sessionID?: string;
    skillReviewTimeoutMs?: number;
}
interface CloseKnowledgeEntry {
    created_at?: string;
}
declare function countSessionKnowledgeEntries(entries: CloseKnowledgeEntry[], sessionStart: string | undefined, fallbackCount: number): number;
declare function copyDirRecursive(src: string, dest: string): Promise<number>;
/**
 * Guarantee all phases and tasks in a plan are marked complete/closed.
 * Mutates planData in place. Returns actual IDs of newly closed phases and
 * tasks so the caller can track only genuinely new closures (idempotent).
 */
declare function guaranteeAllPlansComplete(planData: PlanData): {
    closedPhaseIds: number[];
    closedTaskIds: string[];
};
/**
 * Handles /swarm close command - performs full terminal session finalization:
 * 0. Guarantee: mark all incomplete phases/tasks as closed
 * 1. Finalize: write retrospectives, produce terminal summary
 * 2. Archive: create timestamped bundle of swarm artifacts
 * 3. Clean: clear active-state files that confuse future swarms
 * 4. Align: safe git alignment to main
 *
 * Must be idempotent - safe to run multiple times.
 */
export declare function handleCloseCommand(directory: string, args: string[], options?: CloseCommandOptions): Promise<string>;
export declare const _internals: {
    countSessionKnowledgeEntries: typeof countSessionKnowledgeEntries;
    CLOSE_SKILL_REVIEW_TIMEOUT_MS: number;
    guaranteeAllPlansComplete: typeof guaranteeAllPlansComplete;
    copyDirRecursive: typeof copyDirRecursive;
};
export {};
