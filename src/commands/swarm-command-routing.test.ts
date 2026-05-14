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
