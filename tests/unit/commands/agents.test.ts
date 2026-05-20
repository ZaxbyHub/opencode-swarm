import { describe, expect, test } from 'bun:test';
import type { AgentDefinition } from '../../../src/agents';
import { handleAgentsCommand } from '../../../src/commands/agents';
import { ALL_SUBAGENT_NAMES } from '../../../src/config/constants';
import type { GuardrailsConfig } from '../../../src/config/schema';

/** Generate the unregistered subagents list string for test assertions */
function unregisteredList(names: readonly string[]): string {
	return (
		'\n' + names.map((n) => `- **${n}** (requires configuration)`).join('\n')
	);
}

describe('handleAgentsCommand', () => {
	test('Returns "No agents registered." for empty agents', () => {
		const emptyAgents: Record<string, AgentDefinition> = {};

		const result = handleAgentsCommand(emptyAgents);

		expect(result).toBe('No agents registered.');
	});

	test('Lists agents with model and temperature', () => {
		const agentsWithModelAndTemp: Record<string, AgentDefinition> = {
			architect: {
				name: 'architect',
				description: 'The swarm architect',
				config: {
					model: 'gpt-4',
					temperature: 0.1,
				},
			},
			coder: {
				name: 'coder',
				description: 'The coder agent',
				config: {
					model: 'claude-3',
					temperature: 0.2,
					tools: {
						write: true,
						edit: true,
					},
				},
			},
		};

		const result = handleAgentsCommand(agentsWithModelAndTemp);
		const unregisteredNames = ALL_SUBAGENT_NAMES.filter((n) => n !== 'coder');

		expect(
			result,
		).toBe(`## Registered Agents (2 registered + ${unregisteredNames.length} unregistered)

- **architect** | model: \`gpt-4\` | temp: 0.1 | ✏️ read-write
  The swarm architect
- **coder** | model: \`claude-3\` | temp: 0.2 | ✏️ read-write
  The coder agent

### Unregistered Subagents${unregisteredList(unregisteredNames)}`);
	});

	test('Shows read-only for agents with tools.write === false', () => {
		const readWriteAgent: Record<string, AgentDefinition> = {
			tester: {
				name: 'tester',
				description: 'The test agent',
				config: {
					model: 'gpt-4',
					temperature: 0.1,
					tools: {
						write: false,
						edit: true,
					},
				},
			},
		};

		const result = handleAgentsCommand(readWriteAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **tester** | model: \`gpt-4\` | temp: 0.1 | 🔒 read-only
  The test agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});

	test('Shows read-only for agents with tools.edit === false', () => {
		const readWriteAgent: Record<string, AgentDefinition> = {
			reviewer: {
				name: 'reviewer',
				description: 'The review agent',
				config: {
					model: 'gpt-4',
					temperature: 0.1,
					tools: {
						write: true,
						edit: false,
					},
				},
			},
		};

		const result = handleAgentsCommand(readWriteAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length - 1} unregistered)

- **reviewer** | model: \`gpt-4\` | temp: 0.1 | 🔒 read-only
  The review agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES.filter((n) => n !== 'reviewer'))}`);
	});

	test('Shows read-write for agents without tool restrictions', () => {
		const readWriteAgent: Record<string, AgentDefinition> = {
			developer: {
				name: 'developer',
				description: 'The developer agent',
				config: {
					model: 'gpt-4',
					temperature: 0.2,
					tools: {
						write: true,
						edit: true,
					},
				},
			},
		};

		const result = handleAgentsCommand(readWriteAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **developer** | model: \`gpt-4\` | temp: 0.2 | ✏️ read-write
  The developer agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});

	test('Shows read-write for agents with tools undefined', () => {
		const noToolsAgent: Record<string, AgentDefinition> = {
			designer: {
				name: 'designer',
				description: 'The designer agent',
				config: {
					model: 'gpt-4',
					temperature: 0.15,
				},
			},
		};

		const result = handleAgentsCommand(noToolsAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length - 1} unregistered)

- **designer** | model: \`gpt-4\` | temp: 0.15 | ✏️ read-write
  The designer agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES.filter((n) => n !== 'designer'))}`);
	});

	test('Shows default for missing model', () => {
		const noModelAgent: Record<string, AgentDefinition> = {
			helper: {
				name: 'helper',
				description: 'The helper agent',
				config: {
					temperature: 0.3,
					tools: {
						write: true,
						edit: true,
					},
				},
			},
		};

		const result = handleAgentsCommand(noModelAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **helper** | model: \`default\` | temp: 0.3 | ✏️ read-write
  The helper agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});

	test('Shows default for missing temperature', () => {
		const noTempAgent: Record<string, AgentDefinition> = {
			analyst: {
				name: 'analyst',
				description: 'The analyst agent',
				config: {
					model: 'claude-3',
					tools: {
						write: false,
						edit: false,
					},
				},
			},
		};

		const result = handleAgentsCommand(noTempAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **analyst** | model: \`claude-3\` | temp: default | 🔒 read-only
  The analyst agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});

	test('Shows default for missing temperature even when tools are read-write', () => {
		const noTempReadWriteAgent: Record<string, AgentDefinition> = {
			executor: {
				name: 'executor',
				description: 'The executor agent',
				config: {
					model: 'gpt-3.5',
					tools: {
						write: true,
						edit: true,
					},
				},
			},
		};

		const result = handleAgentsCommand(noTempReadWriteAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **executor** | model: \`gpt-3.5\` | temp: default | ✏️ read-write
  The executor agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});

	test('Includes description when available', () => {
		const agentsWithDesc: Record<string, AgentDefinition> = {
			architect: {
				name: 'architect',
				description:
					'Responsible for project planning and architecture decisions',
				config: {
					model: 'gpt-4',
					temperature: 0.1,
					tools: {
						write: false,
						edit: false,
					},
				},
			},
			coder: {
				name: 'coder',
				config: {
					model: 'claude-3',
					temperature: 0.2,
					tools: {
						write: true,
						edit: true,
					},
				},
			},
		};

		const result = handleAgentsCommand(agentsWithDesc);
		const unregisteredNames = ALL_SUBAGENT_NAMES.filter((n) => n !== 'coder');

		expect(
			result,
		).toBe(`## Registered Agents (2 registered + ${unregisteredNames.length} unregistered)

- **architect** | model: \`gpt-4\` | temp: 0.1 | 🔒 read-only
  Responsible for project planning and architecture decisions
- **coder** | model: \`claude-3\` | temp: 0.2 | ✏️ read-write

### Unregistered Subagents${unregisteredList(unregisteredNames)}`);
	});

	test('Handles multiple agents with mixed configurations', () => {
		const mixedAgents: Record<string, AgentDefinition> = {
			arch: {
				name: 'arch',
				description: 'The architect agent',
				config: {
					model: 'gpt-4',
					temperature: 0.1,
					tools: {
						write: false,
						edit: false,
					},
				},
			},
			dev: {
				name: 'dev',
				description: 'The developer agent',
				config: {
					model: 'gpt-3.5',
					temperature: 0.3,
					tools: {
						write: true,
						edit: true,
					},
				},
			},
			tester: {
				name: 'tester',
				config: {
					model: 'claude-2',
					temperature: 0.2,
					tools: {
						write: false,
						edit: true,
					},
				},
			},
		};

		const result = handleAgentsCommand(mixedAgents);

		expect(
			result,
		).toBe(`## Registered Agents (3 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **arch** | model: \`gpt-4\` | temp: 0.1 | 🔒 read-only
  The architect agent
- **dev** | model: \`gpt-3.5\` | temp: 0.3 | ✏️ read-write
  The developer agent
- **tester** | model: \`claude-2\` | temp: 0.2 | 🔒 read-only

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});

	test('Handles agent with description in config rather than agent level', () => {
		const agentWithConfigDesc: Record<string, AgentDefinition> = {
			reviewer: {
				name: 'reviewer',
				config: {
					model: 'gpt-4',
					temperature: 0.1,
					description: 'Reviews code and provides feedback',
					tools: {
						write: false,
						edit: false,
					},
				},
			},
		};

		const result = handleAgentsCommand(agentWithConfigDesc);
		const unregisteredNames = ALL_SUBAGENT_NAMES.filter(
			(n) => n !== 'reviewer',
		);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${unregisteredNames.length} unregistered)

- **reviewer** | model: \`gpt-4\` | temp: 0.1 | 🔒 read-only
  Reviews code and provides feedback

### Unregistered Subagents${unregisteredList(unregisteredNames)}`);
	});

	test('Prioritizes agent-level description over config description', () => {
		const agentWithBothDesc: Record<string, AgentDefinition> = {
			reviewer: {
				name: 'reviewer',
				description: 'Agent-level description',
				config: {
					model: 'gpt-4',
					temperature: 0.1,
					description: 'Config-level description',
					tools: {
						write: false,
						edit: false,
					},
				},
			},
		};

		const result = handleAgentsCommand(agentWithBothDesc);
		const unregisteredNames = ALL_SUBAGENT_NAMES.filter(
			(n) => n !== 'reviewer',
		);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${unregisteredNames.length} unregistered)

- **reviewer** | model: \`gpt-4\` | temp: 0.1 | 🔒 read-only
  Agent-level description

### Unregistered Subagents${unregisteredList(unregisteredNames)}`);
	});

	test('shows "temp: 0" for agent with temperature of 0', () => {
		const agentWithZeroTemp: Record<string, AgentDefinition> = {
			precise: {
				name: 'precise',
				description: 'The precise agent',
				config: {
					model: 'gpt-4',
					temperature: 0,
				},
			},
		};

		const result = handleAgentsCommand(agentWithZeroTemp);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **precise** | model: \`gpt-4\` | temp: 0 | ✏️ read-write
  The precise agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});

	test('shows read-only for agent with both write and edit set to false', () => {
		const bothFalseAgent: Record<string, AgentDefinition> = {
			restricted: {
				name: 'restricted',
				description: 'Restricted agent',
				config: {
					model: 'gpt-4',
					temperature: 0.1,
					tools: {
						write: false,
						edit: false,
					},
				},
			},
		};

		const result = handleAgentsCommand(bothFalseAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **restricted** | model: \`gpt-4\` | temp: 0.1 | 🔒 read-only
  Restricted agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});

	test('shows read-write for agent with empty tools object', () => {
		const emptyToolsAgent: Record<string, AgentDefinition> = {
			flexible: {
				name: 'flexible',
				description: 'Flexible agent',
				config: {
					model: 'gpt-4',
					temperature: 0.2,
					tools: {},
				},
			},
		};

		const result = handleAgentsCommand(emptyToolsAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **flexible** | model: \`gpt-4\` | temp: 0.2 | ✏️ read-write
  Flexible agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});
});

describe('enhanced agent view', () => {
	// Test fixtures
	const baseAgents: Record<string, AgentDefinition> = {
		coder: {
			name: 'coder',
			description: 'The coder agent',
			config: {
				model: 'gpt-4',
				temperature: 0.2,
				tools: { write: true, edit: true },
			},
		},
		explorer: {
			name: 'explorer',
			description: 'The explorer agent',
			config: {
				model: 'claude-3',
				temperature: 0.1,
				tools: { write: false, edit: false },
			},
		},
		architect: {
			name: 'architect',
			description: 'The architect agent',
			config: {
				model: 'gpt-4',
				temperature: 0.1,
				tools: { write: false, edit: false },
			},
		},
	};

	const baseGuardrails: GuardrailsConfig = {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.5,
	};

	const guardrailsWithProfiles: GuardrailsConfig = {
		...baseGuardrails,
		profiles: {
			coder: { max_tool_calls: 400 },
			explorer: { max_tool_calls: 100, max_duration_minutes: 10 },
		},
	};

	const guardrailsWithEmptyProfile: GuardrailsConfig = {
		...baseGuardrails,
		profiles: {
			architect: {},
		},
	};

	const guardrailsWithMultipleOverrides: GuardrailsConfig = {
		...baseGuardrails,
		profiles: {
			coder: {
				max_tool_calls: 500,
				max_duration_minutes: 60,
				max_repetitions: 20,
				max_consecutive_errors: 10,
				warning_threshold: 0.8,
			},
		},
	};

	test('shows custom limits indicator for agent with profile', () => {
		const result = handleAgentsCommand(baseAgents, guardrailsWithProfiles);

		expect(result).toContain(
			'**coder** | model: `gpt-4` | temp: 0.2 | ✏️ read-write | ⚡ custom limits',
		);
		expect(result).toContain(
			'**explorer** | model: `claude-3` | temp: 0.1 | 🔒 read-only | ⚡ custom limits',
		);
		expect(result).toContain(
			'**architect** | model: `gpt-4` | temp: 0.1 | 🔒 read-only',
		);
	});

	test('does NOT show custom limits indicator for agent without profile', () => {
		const result = handleAgentsCommand(baseAgents, guardrailsWithEmptyProfile);

		expect(result).toContain(
			'**architect** | model: `gpt-4` | temp: 0.1 | 🔒 read-only | ⚡ custom limits',
		);
		expect(result).toContain(
			'**coder** | model: `gpt-4` | temp: 0.2 | ✏️ read-write',
		);
		expect(result).toContain(
			'**explorer** | model: `claude-3` | temp: 0.1 | 🔒 read-only',
		);
	});

	test('shows guardrail profiles summary section at bottom', () => {
		const result = handleAgentsCommand(baseAgents, guardrailsWithProfiles);

		expect(result).toContain('### Guardrail Profiles');
		expect(result).toContain('**coder**: max_tool_calls=400');
		expect(result).toContain(
			'**explorer**: max_tool_calls=100, max_duration_minutes=10',
		);
	});

	test('does NOT show guardrail profiles section when no profiles', () => {
		const result = handleAgentsCommand(baseAgents, baseGuardrails);

		expect(result).not.toContain('### Guardrail Profiles');
	});

	test('does NOT show guardrail profiles section when guardrails param is undefined', () => {
		const result = handleAgentsCommand(baseAgents);

		expect(result).not.toContain('### Guardrail Profiles');
	});

	test('shows multiple profile overrides in summary', () => {
		const result = handleAgentsCommand(
			baseAgents,
			guardrailsWithMultipleOverrides,
		);

		expect(result).toContain('### Guardrail Profiles');
		expect(result).toContain(
			'**coder**: max_tool_calls=500, max_duration_minutes=60, max_repetitions=20, max_consecutive_errors=10, warning_threshold=0.8',
		);
	});

	test('shows "no overrides" for empty profile', () => {
		const result = handleAgentsCommand(baseAgents, guardrailsWithEmptyProfile);

		expect(result).toContain('### Guardrail Profiles');
		expect(result).toContain('**architect**: no overrides');
	});
});

describe('unregistered subagents', () => {
	test('When all subagents are registered, no unregistered section appears', () => {
		// Create agents object with ALL_SUBAGENT_NAMES as keys
		const allSubagentAgents: Record<string, AgentDefinition> =
			Object.fromEntries(
				ALL_SUBAGENT_NAMES.map((name) => [
					name,
					{
						name,
						description: `The ${name} agent`,
						config: { model: 'gpt-4', temperature: 0.1 },
					},
				]),
			);

		const result = handleAgentsCommand(allSubagentAgents);

		// Header should show total count (no split) since all are registered
		expect(result).toContain(
			`## Registered Agents (${ALL_SUBAGENT_NAMES.length} total)`,
		);
		// No unregistered section
		expect(result).not.toContain('### Unregistered Subagents');
	});

	test('When some subagents are missing, they appear in unregistered section with "requires configuration" label', () => {
		// Only register 'coder' and 'explorer' — rest are missing
		const partialAgents: Record<string, AgentDefinition> = {
			coder: {
				name: 'coder',
				description: 'The coder agent',
				config: { model: 'gpt-4', temperature: 0.2 },
			},
			explorer: {
				name: 'explorer',
				description: 'The explorer agent',
				config: { model: 'claude-3', temperature: 0.1 },
			},
		};

		const result = handleAgentsCommand(partialAgents);
		const unregisteredCount = ALL_SUBAGENT_NAMES.length - 2;

		// Header should show split format
		expect(result).toContain(
			`## Registered Agents (2 registered + ${unregisteredCount} unregistered)`,
		);
		// Unregistered section should exist
		expect(result).toContain('### Unregistered Subagents');
		// Each unregistered subagent should have "(requires configuration)" label
		const missingSubagents = ALL_SUBAGENT_NAMES.filter(
			(n) => n !== 'coder' && n !== 'explorer',
		);
		for (const name of missingSubagents) {
			expect(result).toContain(`**${name}** (requires configuration)`);
		}
	});

	test('Shows read-write for agents without tool restrictions', () => {
		const noToolsAgent: Record<string, AgentDefinition> = {
			developer: {
				name: 'developer',
				description: 'The developer agent',
				config: { model: 'gpt-4', temperature: 0.2 },
			},
		};

		const result = handleAgentsCommand(noToolsAgent);

		expect(
			result,
		).toBe(`## Registered Agents (1 registered + ${ALL_SUBAGENT_NAMES.length} unregistered)

- **developer** | model: \`gpt-4\` | temp: 0.2 | ✏️ read-write
  The developer agent

### Unregistered Subagents${unregisteredList(ALL_SUBAGENT_NAMES)}`);
	});

	test('When no subagents are registered (only non-subagent names), header shows "(N registered + M unregistered)" with unregistered section', () => {
		const nonSubagentAgents: Record<string, AgentDefinition> = {
			tester: {
				name: 'tester',
				description: 'The tester agent',
				config: { model: 'gpt-4', temperature: 0.1 },
			},
			developer: {
				name: 'developer',
				description: 'The developer agent',
				config: { model: 'gpt-4', temperature: 0.2 },
			},
		};

		const result = handleAgentsCommand(nonSubagentAgents);
		const unregisteredCount = ALL_SUBAGENT_NAMES.length;

		// Header shows 2 registered + rest unregistered (tester, developer are registered but not subagents)
		expect(result).toContain(
			`## Registered Agents (2 registered + ${unregisteredCount} unregistered)`,
		);
		// Unregistered section present when any subagents are missing
		expect(result).toContain('### Unregistered Subagents');
		// All ALL_SUBAGENT_NAMES listed as unregistered
		for (const name of ALL_SUBAGENT_NAMES) {
			expect(result).toContain(`**${name}** (requires configuration)`);
		}
	});
});

describe('prefixed agent name matching', () => {
	test('prefixed agent counts as its base name being registered', () => {
		// mega_coder strips to coder — coder should NOT appear in unregistered
		const agents: Record<string, AgentDefinition> = {
			mega_coder: {
				name: 'mega_coder',
				config: { model: 'gpt-4', temperature: 0.2 },
			},
		};

		const result = handleAgentsCommand(agents);

		expect(result).not.toContain('**coder** (requires configuration)');
	});

	test('local_ prefixed agent counts as its base name being registered', () => {
		// local_reviewer strips to reviewer
		const agents: Record<string, AgentDefinition> = {
			local_reviewer: {
				name: 'local_reviewer',
				config: { model: 'gpt-4', temperature: 0.1 },
			},
		};

		const result = handleAgentsCommand(agents);

		expect(result).not.toContain('**reviewer** (requires configuration)');
	});

	test('all subagents registered via prefix variants shows "N total" header', () => {
		// Register all ALL_SUBAGENT_NAMES via their base names — should produce no unregistered
		const agents: Record<string, AgentDefinition> = Object.fromEntries(
			ALL_SUBAGENT_NAMES.map((name) => [
				`mega_${name}`,
				{ name: `mega_${name}`, config: { model: 'gpt-4', temperature: 0.1 } },
			]),
		);

		const result = handleAgentsCommand(agents);

		expect(result).not.toContain('### Unregistered Subagents');
		expect(result).toContain(
			`## Registered Agents (${ALL_SUBAGENT_NAMES.length} total)`,
		);
	});
});
