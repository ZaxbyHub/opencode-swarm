import { describe, expect, test } from 'bun:test';
import { executeSwarmCommand } from '../../../src/commands/index.js';

describe('executeSwarmCommand error-safe fallback', () => {
	test('unknown commands return bounded not-found text', async () => {
		const result = await executeSwarmCommand({
			directory: '/test/directory',
			agents: {},
			sessionID: 's1',
			tokens: ['nosuchcommand'],
		});

		expect(result.text).toContain('Command `/swarm nosuchcommand` not found.');
		expect(result.text).toContain('Run `/swarm help` for all commands.');
	});

	test('oversized unknown commands are truncated in display text', async () => {
		const longCommand = 'x'.repeat(200);

		const result = await executeSwarmCommand({
			directory: '/test/directory',
			agents: {},
			sessionID: 's1',
			tokens: [longCommand],
		});

		expect(result.text).toContain(`${'x'.repeat(100)}...`);
		expect(result.text).not.toContain(longCommand);
	});
});
