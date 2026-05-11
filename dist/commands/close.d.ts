interface CloseCommandOptions {
    sessionID?: string;
    skillReviewTimeoutMs?: number;
}
interface CloseKnowledgeEntry {
    created_at?: string;
}
declare function countSessionKnowledgeEntries(entries: CloseKnowledgeEntry[], sessionStart: string | undefined, fallbackCount: number): number;
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
};
export {};
