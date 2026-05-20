/**
 * Skill-improver LLM delegate factory.
 *
 * Mirrors src/hooks/curator-llm-factory.ts so the skill_improver agent can be
 * dispatched via the same ephemeral-session-per-call pattern. Returns
 * `undefined` when `swarmState.opencodeClient` is null (e.g. in unit tests),
 * letting the caller fall back to deterministic mode behind an opt-in flag.
 *
 * Resolution priority for the registered agent name follows the curator
 * factory exactly: direct lookup via active session → heuristic scan → static
 * fallback. The `mode` parameter is reserved for future role variants (e.g.
 * "review_only" vs "draft_skills"); today both modes resolve to the same
 * `skill_improver` agent.
 */
export type SkillImproverLLMDelegate = (systemPrompt: string, userInput: string, signal?: AbortSignal) => Promise<string>;
declare function resolveSkillImproverAgentName(sessionId?: string): string;
/**
 * Create a SkillImproverLLMDelegate that dispatches the registered
 * skill_improver agent on an ephemeral OpenCode session.
 *
 * Returns `undefined` when no OpenCode client is wired (unit tests, library
 * mode). Callers MUST handle that case explicitly: if the deterministic
 * fallback is disabled, refuse the run BEFORE reserving any quota.
 */
export declare function createSkillImproverLLMDelegate(directory: string, sessionId?: string): SkillImproverLLMDelegate | undefined;
export declare const _internals: {
    createSkillImproverLLMDelegate: typeof createSkillImproverLLMDelegate;
    resolveSkillImproverAgentName: typeof resolveSkillImproverAgentName;
};
export {};
