import { describe, expect, it } from 'bun:test';
import { createSwarmCommandHandler } from './index';

function partText(output: { parts: unknown[] }): string {
	return (output.parts[0] as { text: string }).text;
}

describe('swarm-* shortcut command routing', () => {
	it('returns without setting output.parts for unrelated commands', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'status', arguments: '', sessionID: 's1' },
			output,
		);

		expect(output.parts).toHaveLength(0);
	});

	it('routes generic /swarm agents to swarm_command', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm', arguments: 'agents', sessionID: 's1' },
			output,
		);

		expect(partText(output)).toContain('Call the `swarm_command` tool');
		expect(partText(output)).toContain('"command": "agents"');
	});

	it('routes swarm-agents shortcut to swarm_command', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm-agents', arguments: '', sessionID: 's1' },
			output,
		);

		expect(partText(output)).toContain('"command": "agents"');
	});

	it('routes compound shortcut aliases canonically', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm-evidence-summary', arguments: '', sessionID: 's1' },
			output,
		);

		expect(partText(output)).toContain('"command": "evidence summary"');
	});

	it('uses canonical fallback for excluded stateful shortcuts', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm-turbo', arguments: 'on', sessionID: 's1' },
			output,
		);

		expect(partText(output)).not.toContain('Call the `swarm_command` tool');
		expect(partText(output)).toContain(
			'Canonical opencode-swarm command output follows.',
		);
	});

	it('keeps unknown shortcuts bounded and non-canonical', async () => {
		const handler = createSwarmCommandHandler('/tmp/project', {});
		const output = { parts: [] as unknown[] };

		await handler(
			{ command: 'swarm-unknowncmd', arguments: '', sessionID: 's1' },
			output,
		);

		expect(partText(output)).toContain('not found');
		expect(partText(output)).toContain('/swarm help');
	});
});
