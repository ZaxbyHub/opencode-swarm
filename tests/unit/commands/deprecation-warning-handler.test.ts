import { describe, expect, test } from 'bun:test';
import { executeSwarmCommand } from '../../../src/commands/index.js';

describe('executeSwarmCommand deprecation warnings', () => {
	test('deprecated aliases still prepend registry warning in canonical output', async () => {
		const result = await executeSwarmCommand({
			directory: '/test/project',
			agents: {},
			sessionID: 's1',
			tokens: ['config-doctor'],
		});

		expect(result.text).toContain('deprecated');
		expect(result.text).toContain('Use "/swarm config doctor" instead');
	});

	test('canonical commands do not prepend deprecation warning', async () => {
		const result = await executeSwarmCommand({
			directory: '/test/project',
			agents: {},
			sessionID: 's1',
			tokens: ['config', 'doctor'],
		});

		expect(result.text).not.toContain('deprecated');
		expect(result.text).toContain('Config Doctor');
	});
});
