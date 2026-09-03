import { describe, expect, test } from 'bun:test';
import { createSwarmCommandHandler } from './index.js';

function textPart(output: { parts: unknown[] }): string {
	return (output.parts[0] as { text: string }).text;
}

describe('swarm command hook routing', () => {
	test('mutates the existing parts array in place for tool-backed commands', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const existing = [{ type: 'text', text: 'before' }];
		const output = { parts: existing as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(output.parts).toBe(existing);
		expect(output.parts).toHaveLength(1);
		expect(textPart(output)).toContain('Call the `swarm_command` tool');
		expect(textPart(output)).toContain('"command": "agents"');
	});

	test('canonicalizes compound shortcut aliases before routing to the tool', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm-config-doctor', arguments: '', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).toContain('"command": "config doctor"');
	});

	test('uses canonical fallback for commands outside the v1 tool allowlist', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'turbo on', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).not.toContain('Call the `swarm_command` tool');
		expect(textPart(output)).toContain(
			'Canonical opencode-swarm command output follows.',
		);
	});

	test('uses canonical fallback when the active agent does not own swarm_command', async () => {
		const handler = createSwarmCommandHandler(
			'/tmp/project',
			{
				critic_sounding_board: {
					name: 'critic_sounding_board',
					config: { model: 'gpt-4', tools: {} },
				},
			},
			{ getActiveAgentName: () => 'critic_sounding_board' },
		);
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).not.toContain('Call the `swarm_command` tool');
		expect(textPart(output)).toContain('## Registered Agents');
	});

	test('uses registered agent tools, not factory definitions, for tool ownership', async () => {
		const handler = createSwarmCommandHandler(
			'/tmp/project',
			{
				reviewer: {
					name: 'reviewer',
					config: { model: 'gpt-4', tools: {} },
				},
			},
			{
				getActiveAgentName: () => 'reviewer',
				registeredAgents: { reviewer: { tools: { swarm_command: true } } },
			},
		);
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).toContain('Call the `swarm_command` tool');
		expect(textPart(output)).toContain('"command": "agents"');
	});

	test('treats an empty registered tool map as authoritative no-tool state', async () => {
		const handler = createSwarmCommandHandler(
			'/tmp/project',
			{},
			{
				getActiveAgentName: () => 'reviewer',
				registeredAgents: { reviewer: { tools: {} } },
			},
		);
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).not.toContain('Call the `swarm_command` tool');
		expect(textPart(output)).toContain('No agents registered.');
	});

	test('routes prefixed active agent names through base role tool ownership', async () => {
		const handler = createSwarmCommandHandler(
			'/tmp/project',
			{},
			{
				getActiveAgentName: () => 'mega_reviewer',
			},
		);
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).toContain('Call the `swarm_command` tool');
		expect(textPart(output)).toContain('"command": "agents"');
	});

	test('post-#2528 shape: no emitted tools map still resolves ownership via the role map', async () => {
		// Since #2528 plugin-injected agents carry NO `tools` map (the host
		// never read it), so registeredAgents entries have no `tools` key and
		// the read-only factory maps declare only write-family denies. A
		// factory map that does not mention swarm_command must NOT be read
		// as "does not own it" — reviewer owns it via AGENT_TOOL_MAP.
		const handler = createSwarmCommandHandler(
			'/tmp/project',
			{
				reviewer: {
					name: 'reviewer',
					config: {
						model: 'gpt-4',
						tools: { write: false, edit: false, patch: false },
					},
				},
			},
			{
				getActiveAgentName: () => 'reviewer',
				registeredAgents: { reviewer: {} },
			},
		);
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).toContain('Call the `swarm_command` tool');
	});

	test('emitted permission block is authoritative: a restrictive override that denies swarm_command blocks the tool route', async () => {
		// Final-critic finding: with tool_filter.overrides.reviewer = ['diff'],
		// the emitted permission block carries swarm_command: 'deny' and the
		// host HIDES the tool. Routing must not instruct the agent to call a
		// tool it cannot call. Shape mirrors the real getAgentConfigs output
		// under that override (pinned by agent-permission-enforcement.test.ts).
		const handler = createSwarmCommandHandler(
			'/tmp/project',
			{
				reviewer: {
					name: 'reviewer',
					config: {
						model: 'gpt-4',
						tools: { write: false, edit: false, patch: false },
					},
				},
			},
			{
				getActiveAgentName: () => 'reviewer',
				registeredAgents: {
					reviewer: {
						permission: { swarm_command: 'deny', save_plan: 'deny' },
					},
				},
			},
		);
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).not.toContain('Call the `swarm_command` tool');
	});

	test('emitted permission block without a swarm_command deny grants the tool route', async () => {
		const handler = createSwarmCommandHandler(
			'/tmp/project',
			{
				reviewer: {
					name: 'reviewer',
					config: {
						model: 'gpt-4',
						tools: { write: false, edit: false, patch: false },
					},
				},
			},
			{
				getActiveAgentName: () => 'reviewer',
				registeredAgents: {
					reviewer: { permission: { write: 'deny', edit: 'deny' } },
				},
			},
		);
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).toContain('Call the `swarm_command` tool');
	});

	test('factory tools remain authoritative when they state swarm_command explicitly', async () => {
		const handler = createSwarmCommandHandler(
			'/tmp/project',
			{
				reviewer: {
					name: 'reviewer',
					config: {
						model: 'gpt-4',
						tools: { swarm_command: false },
					},
				},
			},
			{ getActiveAgentName: () => 'reviewer' },
		);
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).not.toContain('Call the `swarm_command` tool');
	});

	test('treats an empty swarm shortcut command as /swarm help', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm-', arguments: '', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).toContain('## Swarm Commands');
		expect(textPart(output)).toContain('Chat routing note');
		expect(textPart(output)).not.toContain('Command `/swarm ` not found.');
	});

	test('blocks knowledge mutators in chat fallback', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'knowledge migrate', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).toContain('not available through chat fallback');
		expect(textPart(output)).not.toContain(
			'Canonical opencode-swarm command output follows.',
		);
	});

	test('blocks config doctor --fix in chat fallback for non-tool agents', async () => {
		const handler = createSwarmCommandHandler(
			'/tmp/project',
			{
				critic_sounding_board: {
					name: 'critic_sounding_board',
					config: { model: 'gpt-4', tools: {} },
				},
			},
			{ getActiveAgentName: () => 'critic_sounding_board' },
		);
		const output = { parts: [] as unknown[] };

		await handler(
			{
				command: 'swarm',
				arguments: 'config doctor --fix',
				sessionID: 's1',
			},
			output,
		);

		expect(textPart(output)).toContain('not available through chat fallback');
		expect(textPart(output)).not.toContain('Config Doctor');
	});

	test('blocks rejected tool-policy requests before canonical execution', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{
				command: 'swarm',
				arguments: 'config doctor --fix',
				sessionID: 's1',
			},
			output,
		);

		expect(textPart(output)).toContain('not available through swarm_command');
		expect(textPart(output)).toContain('Do not invent command output');
		expect(textPart(output)).not.toContain(
			'Canonical opencode-swarm command output follows.',
		);
		expect(textPart(output)).not.toContain('Config Doctor');
	});

	test('does not invent output for unknown commands', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'nosuchcommand', sessionID: 's1' },
			output,
		);

		expect(textPart(output)).toContain('not found');
		expect(textPart(output)).toContain('/swarm help');
	});
});
