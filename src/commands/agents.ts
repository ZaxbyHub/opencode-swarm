import type { AgentDefinition } from '../agents';
import { ALL_SUBAGENT_NAMES } from '../config/constants.js';
import type { GuardrailsConfig } from '../config/schema';
import { stripKnownSwarmPrefix } from '../config/schema.js';

const UNREGISTERED_AGENT_HINTS: Record<string, string> = {
	designer: 'enable ui_review.enabled',
	council_generalist: 'enable council.general.enabled',
	council_skeptic: 'enable council.general.enabled',
	council_domain_expert: 'enable council.general.enabled',
	skill_improver:
		'registered by default unless agents.skill_improver.disabled is true',
	spec_writer:
		'registered by default unless agents.spec_writer.disabled is true',
};

export function handleAgentsCommand(
	agents: Record<string, AgentDefinition>,
	guardrails?: GuardrailsConfig,
): string {
	const entries = Object.entries(agents);

	if (entries.length === 0) {
		return 'No agents registered.';
	}

	// Compute registered subagent base names by extracting the canonical
	// role suffix from each generated agent name. Generated names have an
	// arbitrary user-defined swarm prefix (e.g. "bananaSwarm_coder",
	// "acme-prod_reviewer"); the plugin extracts just the canonical role.
	const allAgentKeys = entries.map(([key]) => key);
	const registeredBaseNames = allAgentKeys
		.map((key) => stripKnownSwarmPrefix(key))
		.filter((stripped) =>
			(ALL_SUBAGENT_NAMES as readonly string[]).includes(stripped),
		);

	const unregistered = ALL_SUBAGENT_NAMES.filter(
		(name) => !registeredBaseNames.includes(name),
	);

	const hasUnregistered = unregistered.length > 0;
	const headerLabel = hasUnregistered
		? `${entries.length} registered + ${unregistered.length} unregistered`
		: `${entries.length} total`;

	const lines = [`## Registered Agents (${headerLabel})`, ''];

	for (const [key, agent] of entries) {
		const model = agent.config.model || 'default';
		const temp =
			agent.config.temperature !== undefined
				? agent.config.temperature.toString()
				: 'default';

		// Detect read-only: if tools has write/edit/patch set to false
		const tools = agent.config.tools || {};
		const isReadOnly = tools.write === false || tools.edit === false;
		const access = isReadOnly ? '🔒 read-only' : '✏️ read-write';

		const desc = agent.description || agent.config.description || '';

		// Check if agent has custom guardrail profile
		const hasCustomProfile = guardrails?.profiles?.[key] !== undefined;
		const profileIndicator = hasCustomProfile ? ' | ⚡ custom limits' : '';

		lines.push(
			`- **${key}** | model: \`${model}\` | temp: ${temp} | ${access}${profileIndicator}`,
		);
		if (desc) {
			lines.push(`  ${desc}`);
		}
	}

	// Add unregistered subagents section when any subagents are missing
	if (hasUnregistered) {
		lines.push('', '### Unregistered Subagents');
		for (const name of unregistered) {
			const hint = UNREGISTERED_AGENT_HINTS[name] ?? 'requires configuration';
			lines.push(`- **${name}** (${hint})`);
		}
	}

	// Add guardrail profiles summary if profiles exist
	if (guardrails?.profiles && Object.keys(guardrails.profiles).length > 0) {
		lines.push('', '### Guardrail Profiles', '');

		for (const [profileName, profile] of Object.entries(guardrails.profiles)) {
			const overrides: string[] = [];

			if (profile.max_tool_calls !== undefined) {
				overrides.push(`max_tool_calls=${profile.max_tool_calls}`);
			}
			if (profile.max_duration_minutes !== undefined) {
				overrides.push(`max_duration_minutes=${profile.max_duration_minutes}`);
			}
			if (profile.max_repetitions !== undefined) {
				overrides.push(`max_repetitions=${profile.max_repetitions}`);
			}
			if (profile.max_consecutive_errors !== undefined) {
				overrides.push(
					`max_consecutive_errors=${profile.max_consecutive_errors}`,
				);
			}
			if (profile.warning_threshold !== undefined) {
				overrides.push(`warning_threshold=${profile.warning_threshold}`);
			}

			const overrideStr =
				overrides.length > 0 ? overrides.join(', ') : 'no overrides';
			lines.push(`- **${profileName}**: ${overrideStr}`);
		}
	}

	return lines.join('\n');
}
