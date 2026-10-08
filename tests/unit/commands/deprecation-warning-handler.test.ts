import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { executeSwarmCommand } from '../../../src/commands/index.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

describe('executeSwarmCommand deprecation warnings', () => {
	// config doctor falls back to the user config dir when the project has
	// none: point XDG/HOME roots at a temp dir so it never reads the
	// developer's real ~/.config/opencode/opencode-swarm.json.
	let cleanupEnv: () => void;
	beforeEach(() => {
		cleanupEnv = createIsolatedTestEnv().cleanup;
	});
	afterEach(() => {
		cleanupEnv();
	});

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
