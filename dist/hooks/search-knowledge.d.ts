/**
 * Unified knowledge retrieval service.
 *
 * This is the single core through which BOTH manual recall (`knowledge_recall`)
 * and automatic injection (the phase-start injector) retrieve knowledge. It
 * replaces the former split between Jaccard-only manual recall and the
 * metadata-only action-aware injection ranker with one hybrid algorithm:
 *
 *   finalScore = TEXT_WEIGHT  * textScore        (Jaccard query↔lesson)
 *              + META_WEIGHT  * metadataScore     (phase/confidence/keywords)
 *              + directiveScore                   (trigger/action/agent/priority)
 *              + boosts (status, generated-skill)
 *
 * Each signal degrades to 0 when its input is absent, so a query-only call
 * (manual recall) is text-dominated while a context-only call (injection) is
 * metadata/directive-dominated — without branching into two algorithms.
 *
 * Responsibilities (per the P0 plan):
 *   load → normalize → filter archived/quarantined → dedup (hive wins) →
 *   apply scope & agent-role constraints → hybrid score → rerank
 *   (critical force-include) → emit a `retrieved` event → return trace_id.
 */
import { type RetrievalEventMode } from './knowledge-events.js';
import { type RankedEntry } from './knowledge-reader.js';
import type { KnowledgeConfig, KnowledgeRetrievalContext } from './knowledge-types.js';
export interface SearchKnowledgeParams {
    directory: string;
    config: KnowledgeConfig;
    /** Free-text query (manual recall). */
    query?: string;
    /** Action-aware decision-point context (injection / context packs). */
    context?: KnowledgeRetrievalContext;
    /** Retrieval mode — recorded on the emitted event. */
    mode: RetrievalEventMode;
    /** Agent role doing the retrieval (used for role scoping + the event). */
    agent?: string;
    /** Session id for the emitted event. */
    sessionId?: string;
    /** Tier filter. Default 'all'. */
    tier?: 'all' | 'swarm' | 'hive';
    /** Max results to return. Falls back to config.max_inject_count. */
    maxResults?: number;
    /** Emit a `retrieved` event (default true). */
    emitEvent?: boolean;
    /**
     * Apply config.scope_filter (default true). Manual recall passes false so an
     * explicit query can surface non-global-scoped lessons.
     */
    applyScopeFilter?: boolean;
    /**
     * Read the hive tier regardless of config.hive_enabled (default false).
     * Manual recall passes true so `hive_enabled:false` (an injection knob) does
     * not also hide hive entries from explicit queries.
     */
    forceReadHive?: boolean;
    /**
     * Apply agent-role scoping via applies_to_agents (default true). Manual recall
     * passes false so an explicit query is not silently role-gated.
     */
    applyRoleScope?: boolean;
}
export interface SearchKnowledgeResult {
    trace_id: string;
    results: RankedEntry[];
}
/**
 * Run unified knowledge retrieval. Returns a trace_id (always minted, even when
 * no entries match) and the ranked results. Reading/scoring failures degrade to
 * an empty result set; the event emission is fail-open.
 */
export declare function searchKnowledge(params: SearchKnowledgeParams): Promise<SearchKnowledgeResult>;
export declare const _internals: {
    searchKnowledge: typeof searchKnowledge;
};
