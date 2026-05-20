/** Knowledge curator hook for opencode-swarm v6.17 two-tier knowledge system. */
import type { KnowledgeConfig } from './knowledge-types.js';
/**
 * Check if the input is a write operation targeting an evidence file.
 * Exported for testing purposes only.
 */
export declare function isWriteToEvidenceFile(input: unknown): boolean;
/**
 * Curate and store swarm knowledge entries from lessons.
 * @returns Promise resolving to an object with counts of stored, skipped, and rejected lessons.
 */
export declare function curateAndStoreSwarm(lessons: string[], projectName: string, phaseInfo: {
    phase_number: number;
}, directory: string, config: KnowledgeConfig): Promise<{
    stored: number;
    skipped: number;
    rejected: number;
}>;
/**
 * Auto-promote swarm entries based on phase confirmations and age.
 */
export declare function runAutoPromotion(directory: string, config: KnowledgeConfig): Promise<void>;
/**
 * Create the knowledge curator hook.
 * Watches for writes to .swarm/plan.md and extracts lessons from the retrospective section.
 */
export declare function createKnowledgeCuratorHook(directory: string, config: KnowledgeConfig): (input: unknown, output: unknown) => Promise<void>;
export declare const _internals: {
    isWriteToEvidenceFile: typeof isWriteToEvidenceFile;
    curateAndStoreSwarm: typeof curateAndStoreSwarm;
    runAutoPromotion: typeof runAutoPromotion;
    createKnowledgeCuratorHook: typeof createKnowledgeCuratorHook;
};
