import type { AgentDefinition } from './architect';
import {
	CURATOR_INIT_PROMPT,
	CURATOR_PHASE_PROMPT,
	CURATOR_POSTMORTEM_PROMPT,
} from './explorer.js';

export type CuratorRole =
	| 'curator_init'
	| 'curator_phase'
	| 'curator_postmortem';

const ROLE_CONFIG: Record<
	CuratorRole,
	{ name: string; description: string; prompt: string }
> = {
	curator_init: {
		name: 'curator_init',
		description:
			'Curator (Init). Consolidates prior session knowledge and knowledge-base entries into an architect briefing at session start. Read-only.',
		prompt: CURATOR_INIT_PROMPT,
	},
	curator_phase: {
		name: 'curator_phase',
		description:
			'Curator (Phase). Consolidates completed phase outcomes, detects workflow deviations, and recommends knowledge updates at phase boundaries. Read-only.',
		prompt: CURATOR_PHASE_PROMPT,
	},
	curator_postmortem: {
		name: 'curator_postmortem',
		description:
			'Curator (Post-mortem). Synthesizes project-end evidence into an improvement agenda, consolidates knowledge, and triages pending proposals. Read-only.',
		prompt: CURATOR_POSTMORTEM_PROMPT,
	},
};

/**
 * Create a Curator agent definition for the given role.
 *
 * Follows the same pattern as createCriticAgent:
 * - Two named variants: curator_init and curator_phase
 * - Each carries its own baked-in system prompt so the correct agent is
 *   resolved by name in any swarm (default or prefixed)
 * - customPrompt replaces the default prompt entirely; customAppendPrompt
 *   appends to the role-specific default (same semantics as createCriticAgent)
 * - Read-only tool config: write/edit/patch all false
 */
export function createCuratorAgent(
	model: string,
	customPrompt?: string,
	customAppendPrompt?: string,
	role: CuratorRole = 'curator_init',
): AgentDefinition {
	const roleConfig = ROLE_CONFIG[role];

	let prompt: string;
	if (customPrompt) {
		prompt = customAppendPrompt
			? `${customPrompt}\n\n${customAppendPrompt}`
			: customPrompt;
	} else {
		prompt = customAppendPrompt
			? `${roleConfig.prompt}\n\n${customAppendPrompt}`
			: roleConfig.prompt;
	}

	return {
		name: roleConfig.name,
		description: roleConfig.description,
		config: {
			model,
			temperature: 0.1,
			prompt,
			// Curator is read-only — analyzes pre-assembled data, never modifies files
			tools: {
				write: false,
				edit: false,
				patch: false,
			},
			// Classification tasks don't benefit from extended thinking; disabling
			// avoids flooding OpenCode's session log with reasoning parts.
			// Users may re-enable via agents.curator_<role>.thinking in their config.
			thinking: { type: 'disabled' },
		},
	};
}
