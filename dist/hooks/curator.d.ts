/**
 * Curator core — file I/O for curator summary persistence.
 * Extended incrementally: filterPhaseEvents, checkPhaseCompliance,
 * runCuratorInit, runCuratorPhase, applyCuratorKnowledgeUpdates added in subsequent tasks.
 *
 * LLM delegation: runCuratorPhase and runCuratorInit accept an optional llmDelegate
 * callback for LLM-based analysis. When provided, the prepared data context is sent
 * to the explorer agent in CURATOR_PHASE/CURATOR_INIT mode for richer analysis.
 * When the delegate is absent or fails, falls back to data-only behavior.
 *
 * ## Curator Agent Dispatch Modes
 *
 * Curator agents are dispatched in two ways:
 *
 * 1. **Factory dispatch** (standard): Created via `createCuratorAgent` from curator-agent.ts,
 *    exposed through agents/index.ts. These appear in agent lists and are part of the
 *    standard agent factory.
 *
 * 2. **Hook dispatch** (internal): curator.ts imports CURATOR_INIT_PROMPT and CURATOR_PHASE_PROMPT
 *    from explorer.ts and dispatches curator analysis directly via hook callbacks. These
 *    hook-dispatched curators do NOT go through the standard agent factory and are NOT
 *    included in agent lists (e.g., AGENTS.md, agent discovery, the agent registry).
 *
 * This dual dispatch means agent lists are incomplete — they capture factory-dispatched
 * curators but omit hook-dispatched ones. This is by design for hook-internal operations.
 */
import type { ComplianceObservation, CuratorConfig, CuratorInitResult, CuratorPhaseResult, CuratorSummary, KnowledgeRecommendation } from './curator-types.js';
import type { KnowledgeConfig } from './knowledge-types.js';
/**
 * Optional LLM delegate callback type.
 * Takes a system prompt and user input, returns the LLM output text.
 * Used to delegate analysis to the explorer agent in CURATOR mode.
 */
export type CuratorLLMDelegate = (systemPrompt: string, userInput: string, signal?: AbortSignal) => Promise<string>;
export declare const _internals: {
    parseKnowledgeRecommendations: typeof parseKnowledgeRecommendations;
    readCuratorSummary: typeof readCuratorSummary;
    writeCuratorSummary: typeof writeCuratorSummary;
    filterPhaseEvents: typeof filterPhaseEvents;
    checkPhaseCompliance: typeof checkPhaseCompliance;
    normalizeAgentName: typeof normalizeAgentName;
};
/**
 * Parse OBSERVATIONS section from curator LLM output.
 * Expected format per line: "- entry <uuid> (<observable>): [text]"
 * Observable types: appears high-confidence, appears stale, could be tighter,
 * contradicts project state, new candidate
 * Action hints are extracted from parenthetical directives like "(suggests boost confidence, mark hive_eligible)"
 */
export declare function parseKnowledgeRecommendations(llmOutput: string): KnowledgeRecommendation[];
/**
 * v2: Strict-JSON parser for the new curator output blocks.
 *
 * Curator prompts may now emit JSON-fenced blocks like:
 *
 * ```json knowledge_application_findings
 * [{ "knowledge_id": "...", "expected_behavior": "...", ... }]
 * ```
 *
 * ```json skill_candidates
 * [{ "slug": "...", "title": "...", ... }]
 * ```
 *
 * Malformed JSON or unexpected types are silently dropped: no knowledge or
 * skill writes happen when curator output is malformed.
 */
export declare function parseStructuredCuratorBlocks(llmOutput: string): {
    findings: import('./curator-types.js').KnowledgeApplicationFinding[];
    candidates: import('./curator-types.js').SkillCandidate[];
};
/**
 * Read curator summary from .swarm/curator-summary.json
 * @param directory - The workspace directory
 * @returns CuratorSummary if valid, null if missing or invalid
 */
export declare function readCuratorSummary(directory: string): Promise<CuratorSummary | null>;
/**
 * Write curator summary to .swarm/curator-summary.json
 * @param directory - The workspace directory
 * @param summary - The curator summary to write
 */
export declare function writeCuratorSummary(directory: string, summary: CuratorSummary): Promise<void>;
/**
 * Normalize an agent name to its canonical role.
 *
 * v2 (Phase F′ remediation): use the repository's canonical resolver
 * `getCanonicalAgentRole`, registry-aware. When the generated-agent registry
 * is populated (post plugin-init), an arbitrary swarm id like
 * `banana_coder` resolves to `coder` IFF it appears in the registry.
 * Pre-init (registry empty), the resolver falls back to a permissive
 * suffix-match against ALL_AGENT_NAMES — preserving today's behaviour for
 * arbitrary user prefixes without the hard-coded
 * `(mega|paid|local|lowtier|modelrelay)_` whitelist.
 *
 * Lower-casing is preserved for backwards compatibility with the prior
 * comparator code paths in this file.
 */
declare function normalizeAgentName(name: string): string;
/**
 * Filter events from JSONL by phase or timestamp.
 * @param eventsJsonl - Raw JSONL string of events
 * @param phase - Phase number to filter by
 * @param sinceTimestamp - Optional ISO 8601 timestamp to filter events after
 * @returns Array of parsed event objects
 */
export declare function filterPhaseEvents(eventsJsonl: string, phase: number, sinceTimestamp?: string): object[];
/**
 * Check compliance for a phase based on events and dispatched agents.
 * @param phaseEvents - Array of events for the phase
 * @param agentsDispatched - List of agent names that were dispatched
 * @param requiredAgents - List of required agent names for this phase
 * @param phase - Phase number
 * @returns Array of compliance observations
 */
export declare function checkPhaseCompliance(phaseEvents: object[], agentsDispatched: string[], requiredAgents: string[], phase: number): ComplianceObservation[];
/**
 * Prepare curator init data: reads prior summary, knowledge entries, and context.md.
 * When an llmDelegate is provided, delegates to the explorer agent in CURATOR_INIT mode
 * for LLM-based analysis that enhances the data-only briefing.
 * @param directory - The workspace directory
 * @param config - Curator configuration
 * @param llmDelegate - Optional LLM delegate for enhanced analysis
 * @returns CuratorInitResult with briefing text, contradictions, and stats
 */
export declare function runCuratorInit(directory: string, config: CuratorConfig, llmDelegate?: CuratorLLMDelegate): Promise<CuratorInitResult>;
/**
 * Run curator phase analysis: reads events, runs compliance, updates and writes summary.
 * When an llmDelegate is provided, delegates to the explorer agent in CURATOR_PHASE mode
 * for LLM-based architectural drift analysis and knowledge recommendations.
 * @param directory - The workspace directory
 * @param phase - The phase number that just completed
 * @param agentsDispatched - List of agent names dispatched in this phase
 * @param config - Curator configuration
 * @param knowledgeConfig - Knowledge configuration (used for knowledge path resolution)
 * @param llmDelegate - Optional LLM delegate for enhanced analysis
 * @returns CuratorPhaseResult with digest, compliance, and recommendations
 */
export declare function runCuratorPhase(directory: string, phase: number, agentsDispatched: string[], config: CuratorConfig, _knowledgeConfig: {
    directory?: string;
}, llmDelegate?: CuratorLLMDelegate): Promise<CuratorPhaseResult>;
/**
 * Apply curator knowledge recommendations: promote, archive, or flag contradictions.
 * Uses readKnowledge + rewriteKnowledge pattern for atomic updates.
 * @param directory - The workspace directory
 * @param recommendations - Array of knowledge recommendations to apply
 * @param knowledgeConfig - Knowledge configuration (for path resolution)
 * @returns Counts of applied and skipped recommendations
 */
export declare function applyCuratorKnowledgeUpdates(directory: string, recommendations: KnowledgeRecommendation[], knowledgeConfig: KnowledgeConfig): Promise<{
    applied: number;
    skipped: number;
}>;
export {};
