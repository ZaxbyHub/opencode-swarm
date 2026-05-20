import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk';
import { type PluginConfig } from '../config';
import { type AgentDefinition } from './architect';
import { type ProjectContext } from './template';
export type { AgentDefinition } from './architect';
/**
 * Strip the user-defined swarm prefix from an agent name to get the base
 * canonical role.
 *
 * The `swarmPrefix` argument is the swarm ID that the USER configured in
 * their `swarms` map — it is an arbitrary string, NOT one of a known list.
 * Examples of valid prefixes: "banana", "acme-prod", "customer123",
 * "mySwarm". The plugin must not assume any fixed set of swarm names.
 *
 * Example: agentName="banana_coder" with swarmPrefix="banana" -> "coder".
 *
 * Returns the name unchanged if `swarmPrefix` is empty or does not match.
 */
export declare function stripSwarmPrefix(agentName: string, swarmPrefix?: string): string;
/**
 * Resolve the fallback model for an agent based on its config and fallback index.
 * Called by guardrails at runtime when a transient model error is detected.
 *
 * Fallback inheritance:
 * - curator_init/curator_phase inherit fallback_models from explorer if not explicitly configured
 * - This matches the model inheritance: curator agents default to explorer's model
 */
export declare function resolveFallbackModel(agentBaseName: string, fallbackIndex: number, swarmAgents?: Record<string, {
    model?: string;
    temperature?: number;
    disabled?: boolean;
    fallback_models?: string[];
}>): string | null;
/**
 * Get the swarm agents config (for runtime fallback resolution by guardrails).
 */
export declare function getSwarmAgents(): Record<string, {
    model?: string;
    fallback_models?: string[];
    disabled?: boolean;
}> | undefined;
/**
 * Create all agent definitions with configuration applied
 */
export declare function createAgents(config?: PluginConfig, projectContext?: ProjectContext): AgentDefinition[];
/**
 * Resolve the set of generated agent names that should be marked as primary
 * for OpenCode's session-default-agent resolution.
 *
 * Resolution rules (see schema.ts default_agent comment for full semantics):
 *   - default_agent omitted ⇒ every architect-role agent is primary
 *     (canonical base role === "architect"). This restores v7.0.0 behavior in
 *     multi-swarm configs where there is no unprefixed `architect` agent.
 *   - default_agent exactly matches a generated agent name ⇒ only that agent.
 *     Exact match wins over base-role match — `local_architect` resolves to
 *     just `local_architect`, never the entire architect role.
 *   - default_agent is a base role in ALL_AGENT_NAMES ⇒ every generated agent
 *     whose canonical base role matches that role.
 *   - default_agent is invalid (matches nothing) ⇒ fall back to architect-role
 *     primaries; if no architect roles exist (architects disabled), fall back
 *     to the first generated agent. Always warns. Never returns empty when
 *     `agentNames` is non-empty.
 *
 * Important matching detail: a value like "not_an_architect" is NOT treated
 * as a base-role request even though stripKnownSwarmPrefix() returns
 * "architect" for it. Base-role matching only fires when the user-supplied
 * value is itself one of ALL_AGENT_NAMES.
 */
export declare function resolvePrimaryAgentNames(agentNames: string[], defaultAgent?: string): {
    primaryNames: Set<string>;
    reason: 'implicit-architects' | 'exact' | 'base-role' | 'fallback-architects' | 'fallback-first';
    warning?: string;
};
/**
 * Get agent configurations formatted for the OpenCode SDK.
 */
export declare function getAgentConfigs(config?: PluginConfig, directory?: string, sessionId?: string, projectContext?: ProjectContext): Record<string, SDKAgentConfig>;
export { createArchitectAgent } from './architect';
export { createCoderAgent } from './coder';
export { DOMAIN_EXPERT_COUNCIL_PROMPT, GENERALIST_COUNCIL_PROMPT, SKEPTIC_COUNCIL_PROMPT, } from './council-prompts';
export { createCriticAgent } from './critic';
export { createCuratorAgent } from './curator-agent';
export { createDesignerAgent } from './designer';
export { createDocsAgent } from './docs';
export { createExplorerAgent } from './explorer';
export { createReviewerAgent, SECURITY_CATEGORIES, type SecurityCategory, } from './reviewer';
export { createSMEAgent } from './sme';
export { createTestEngineerAgent } from './test-engineer';
