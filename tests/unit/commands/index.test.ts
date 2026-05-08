import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentDefinition } from '../../../src/agents';
import { createSwarmCommandHandler } from '../../../src/commands/index';

describe('createSwarmCommandHandler', () => {
	const testDir = '/test/project';
	const testAgents: Record<string, AgentDefinition> = {
		architect: {
			name: 'architect',
			config: { model: 'gpt-4', temperature: 0.1 },
		},
	};

	let handler: ReturnType<typeof createSwarmCommandHandler>;

	beforeEach(() => {
		handler = createSwarmCommandHandler(testDir, testAgents);
	});

	test('ignores non-swarm commands', async () => {
		const output = { parts: [] as unknown[] };
		await handler({ command: 'help', sessionID: 's1', arguments: '' }, output);
		expect(output.parts).toHaveLength(0);
	});

	test('shows help for empty arguments', async () => {
		const output = { parts: [] as unknown[] };
		await handler({ command: 'swarm', sessionID: 's1', arguments: '' }, output);
		expect(output.parts).toHaveLength(1);
		const part = output.parts[0] as any;
		expect(part.type).toBe('text');
		expect(part.text).toContain('Swarm Commands');
	});

	test('shows help for unknown subcommand', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'unknown' },
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as any).text).toContain('not found');
	});

	test('dispatches "status" to handleStatusCommand', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'status' },
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as any).type).toBe('text');
		// Just verify that some status-like content is returned (actual content varies)
		expect((output.parts[0] as any).text.length).toBeGreaterThan(0);
	});

	test('dispatches "plan" to handlePlanCommand', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'plan' },
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as any).type).toBe('text');
		expect((output.parts[0] as any).text.length).toBeGreaterThan(0);
	});

	test('dispatches "plan 2" with args', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'plan 2' },
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as any).type).toBe('text');
	});

	test('dispatches "agents" to handleAgentsCommand', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'agents' },
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as any).type).toBe('text');
		expect((output.parts[0] as any).text).toContain('architect');
	});

	test('dispatches "diagnose" to handleDiagnoseCommand', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'diagnose' },
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as any).type).toBe('text');
		// Just verify that some diagnose-like content is returned
		expect((output.parts[0] as any).text.length).toBeGreaterThan(0);
	});

	test('sets output.parts with type text', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'status' },
			output,
		);
		expect((output.parts[0] as any).type).toBe('text');
	});

	test('handles whitespace-only arguments', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: '   ' },
			output,
		);
		expect((output.parts[0] as any).text).toContain('Swarm Commands');
	});

	test('preserves output for non-swarm command', async () => {
		const existing = [{ type: 'existing' }];
		const output = { parts: existing as unknown[] };
		await handler({ command: 'other', sessionID: 's1', arguments: '' }, output);
		expect(output.parts).toBe(existing);
	});

	test('handles multiple spaces between args', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'plan    2   extra' },
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as any).type).toBe('text');
	});

	test('handles tab characters in arguments', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'plan\t2' },
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as any).type).toBe('text');
	});

	test('handles subcommand with trailing spaces', async () => {
		const output = { parts: [] as unknown[] };
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'agents   ' },
			output,
		);
		expect(output.parts).toHaveLength(1);
		expect((output.parts[0] as any).type).toBe('text');
		expect((output.parts[0] as any).text).toContain('architect');
	});
});
