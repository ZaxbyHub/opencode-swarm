import { describe, expect, test } from 'bun:test';
import { createSwarmCommandHandler } from '../../../src/commands/index';

function text(output: { parts: unknown[] }): string {
	return (output.parts[0] as { text: string }).text;
}

describe('createSwarmCommandHandler', () => {
	test('ignores non-swarm commands', async () => {
		const output = { parts: [] as unknown[] };
		const handler = createSwarmCommandHandler('/test/project', {});

		await handler({ command: 'help', sessionID: 's1', arguments: '' }, output);

		expect(output.parts).toHaveLength(0);
	});

	test('shows help for empty /swarm', async () => {
		const output = { parts: [] as unknown[] };
		const handler = createSwarmCommandHandler('/test/project', {});

		await handler({ command: 'swarm', sessionID: 's1', arguments: '' }, output);

		expect(text(output)).toContain('## Swarm Commands');
	});

	test('routes supported commands to swarm_command with canonical command', async () => {
		const output = { parts: [] as unknown[] };
		const handler = createSwarmCommandHandler('/test/project', {});

		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'plan 2' },
			output,
		);

		expect(text(output)).toContain('"command": "show-plan"');
		expect(text(output)).toContain('"2"');
	});

	test('preserves output parts array identity while replacing contents', async () => {
		const existing = [{ type: 'existing', text: 'old' }];
		const output = { parts: existing as unknown[] };
		const handler = createSwarmCommandHandler('/test/project', {});

		await handler(
			{ command: 'swarm-agents', sessionID: 's1', arguments: '' },
			output,
		);

		expect(output.parts).toBe(existing);
		expect(output.parts).toHaveLength(1);
		expect(text(output)).toContain('"command": "agents"');
	});

	test('returns bounded not-found output for unknown commands', async () => {
		const output = { parts: [] as unknown[] };
		const handler = createSwarmCommandHandler('/test/project', {});

		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'unknown' },
			output,
		);

		expect(text(output)).toContain('not found');
		expect(text(output)).toContain('/swarm help');
	});
});
