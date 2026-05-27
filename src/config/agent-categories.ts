/**
 * Single source of truth for agent categorization.
 * Used by the monitor server /metadata endpoint to classify agents.
 */
export type AgentCategory = 'orchestrator' | 'pipeline' | 'qa' | 'support';

export const AGENT_CATEGORY: Readonly<Record<string, AgentCategory>> = {
	// Orchestrator
	architect: 'orchestrator',

	// Pipeline agents (do the actual work)
	explorer: 'pipeline',
	coder: 'pipeline',
	test_engineer: 'pipeline',

	// QA agents (review and verify)
	reviewer: 'qa',
	critic: 'qa',
	critic_sounding_board: 'qa',
	critic_drift_verifier: 'qa',
	critic_hallucination_verifier: 'qa',
	critic_architecture_supervisor: 'qa',

	// Support agents (advise, document, design)
	sme: 'support',
	docs: 'support',
	designer: 'support',
} as const;

/**
 * Resolve an agent's category.
 * @param agentName - Agent name (e.g. "architect", "critic_sounding_board")
 * @returns The agent's category, or undefined if the agent name is unknown
 */
export function getAgentCategory(agentName: string): AgentCategory | undefined {
	return AGENT_CATEGORY[agentName];
}
