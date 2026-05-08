/** Read path for the opencode-swarm v6.17 two-tier knowledge system.
 * Merges swarm + hive knowledge, deduplicates (hive wins), ranks by composite score,
 * and provides utility tracking.
 */
import type { KnowledgeConfig, KnowledgeEntryBase, KnowledgeRetrievalContext } from './knowledge-types.js';
export interface ProjectContext {
    projectName: string;
    currentPhase: string;
    techStack?: string[];
    recentErrors?: string[];
}
export interface RankedEntry extends KnowledgeEntryBase {
    tier: 'swarm' | 'hive';
    relevanceScore: {
        category: number;
        confidence: number;
        keywords: number;
    };
    finalScore: number;
}
export declare function readMergedKnowledge(directory: string, config: KnowledgeConfig, context?: ProjectContext): Promise<RankedEntry[]>;
export declare function updateRetrievalOutcome(directory: string, phaseInfo: string, phaseSucceeded: boolean): Promise<void>;
/** Returns 0..1 score representing trigger/action match strength against the context. */
export declare function scoreDirectiveAgainstContext(entry: KnowledgeEntryBase, ctx: KnowledgeRetrievalContext): {
    triggerHit: boolean;
    actionHit: boolean;
    agentHit: boolean;
    score: number;
};
/**
 * v2: Action-aware retrieval. Returns RankedEntry[] but uses the richer
 * KnowledgeRetrievalContext to bias ranking toward entries whose triggers,
 * applies_to_tools, applies_to_agents, or directive_priority match the
 * current decision point. Falls back to readMergedKnowledge ordering for
 * non-matching entries.
 */
export declare function readContextualKnowledge(directory: string, config: KnowledgeConfig, ctx: KnowledgeRetrievalContext): Promise<RankedEntry[]>;
export declare const _internals: {
    readMergedKnowledge: typeof readMergedKnowledge;
    readContextualKnowledge: typeof readContextualKnowledge;
    updateRetrievalOutcome: typeof updateRetrievalOutcome;
    scoreDirectiveAgainstContext: typeof scoreDirectiveAgainstContext;
};
