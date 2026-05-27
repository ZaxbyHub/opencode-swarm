import { describe, expect, test } from 'bun:test';
import {
	ARCHITECTURE_SUPERVISOR_PROMPT,
	createCriticAgent,
} from '../../../src/agents/critic';
import { createAgents } from '../../../src/agents/index';
import { getAgentCategory } from '../../../src/config/agent-categories';
import {
	AGENT_TOOL_MAP,
	ALL_AGENT_NAMES,
	ALL_SUBAGENT_NAMES,
	DEFAULT_AGENT_CONFIGS,
	DEFAULT_MODELS,
	MEMORY_AGENT_TOOL_MAP,
} from '../../../src/config/constants';
import { normalizeMemoryAgentRole } from '../../../src/memory/role-profiles';

const TEST_MODEL = 'test/model';

describe('critic_architecture_supervisor role', () => {
	test('factory returns the architecture-supervisor name', () => {
		const agent = createCriticAgent(
			TEST_MODEL,
			undefined,
			undefined,
			'architecture_supervisor',
		);
		expect(agent.name).toBe('critic_architecture_supervisor');
	});

	test('uses the architecture-supervisor prompt', () => {
		const agent = createCriticAgent(
			TEST_MODEL,
			undefined,
			undefined,
			'architecture_supervisor',
		);
		expect(agent.config.prompt).toBe(ARCHITECTURE_SUPERVISOR_PROMPT);
		expect(agent.config.prompt).toContain('Architecture Supervisor');
		expect(agent.config.prompt).toContain('COMPRESSED SUMMARIES');
	});

	test('is read-only (write/edit/patch disabled)', () => {
		const agent = createCriticAgent(
			TEST_MODEL,
			undefined,
			undefined,
			'architecture_supervisor',
		);
		expect(agent.config.tools).toEqual({
			write: false,
			edit: false,
			patch: false,
		});
	});

	test('honors a custom model (override flow)', () => {
		const agent = createCriticAgent(
			'expensive/model',
			undefined,
			undefined,
			'architecture_supervisor',
		);
		expect(agent.config.model).toBe('expensive/model');
	});
});

describe('critic_architecture_supervisor registration', () => {
	test('is in ALL_SUBAGENT_NAMES and ALL_AGENT_NAMES', () => {
		expect(ALL_SUBAGENT_NAMES).toContain('critic_architecture_supervisor');
		expect(ALL_AGENT_NAMES).toContain('critic_architecture_supervisor');
	});

	test('has a read-only AGENT_TOOL_MAP entry (no write/edit/patch tools)', () => {
		const tools = AGENT_TOOL_MAP.critic_architecture_supervisor;
		expect(tools).toBeDefined();
		expect(tools).toContain('retrieve_summary');
		// must not include any mutation tools
		for (const t of tools) {
			expect(['write', 'edit', 'patch', 'suggest_patch']).not.toContain(t);
		}
		expect(tools.length).toBeLessThanOrEqual(20);
	});

	test('has a memory-recall entry', () => {
		expect(MEMORY_AGENT_TOOL_MAP.critic_architecture_supervisor).toEqual([
			'swarm_memory_recall',
		]);
	});

	test('is categorized as qa (parity with sibling verifiers)', () => {
		expect(getAgentCategory('critic_architecture_supervisor')).toBe('qa');
	});

	test('resolves to the security memory-recall profile (parity with sibling verifiers)', () => {
		expect(normalizeMemoryAgentRole('critic_architecture_supervisor')).toBe(
			'security',
		);
		// prefixed form normalizes too
		expect(
			normalizeMemoryAgentRole('mega_critic_architecture_supervisor'),
		).toBe('security');
	});

	test('has DEFAULT_MODELS and DEFAULT_AGENT_CONFIGS entries (expensive default)', () => {
		expect(DEFAULT_MODELS.critic_architecture_supervisor).toBe(
			'opencode/big-pickle',
		);
		expect(DEFAULT_AGENT_CONFIGS.critic_architecture_supervisor?.model).toBe(
			'opencode/big-pickle',
		);
	});
});

describe('critic_architecture_supervisor via createAgents', () => {
	test('is emitted and inherits the critic model when not overridden', () => {
		const agents = createAgents({
			agents: { critic: { model: 'custom/critic' } },
		});
		const found = agents.find(
			(a) => a.name === 'critic_architecture_supervisor',
		);
		expect(found).toBeDefined();
		expect(found?.config.model).toBe('custom/critic');
		expect(found?.config.tools).toEqual({
			write: false,
			edit: false,
			patch: false,
		});
	});

	test('honors its own model override over the critic model', () => {
		const agents = createAgents({
			agents: {
				critic: { model: 'cheap/critic' },
				critic_architecture_supervisor: { model: 'expensive/supervisor' },
			},
		});
		const found = agents.find(
			(a) => a.name === 'critic_architecture_supervisor',
		);
		expect(found?.config.model).toBe('expensive/supervisor');
	});
});
