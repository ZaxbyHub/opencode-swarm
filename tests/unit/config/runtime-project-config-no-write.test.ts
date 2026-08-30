import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenCodeSwarm from '../../../src/index';
import { createIndexCommandsModuleGuards } from '../../helpers/index-commands-shared.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

// PRR-004 (issue #2420 follow-up): runtime startup used to call
// writeProjectConfigIfNew(ctx.directory), auto-creating an empty project
// override at <workspace>/.opencode/opencode-swarm.json. The writer is now
// removed; this test pins the runtime half of the "no auto-created project
// override" obligation. The CLI install half is covered by
// tests/unit/cli/install-default-agent-configs.test.ts.

const moduleGuards = createIndexCommandsModuleGuards();

describe('runtime startup does not create the project override', () => {
	let tempDir: string;
	let cleanupIsolatedEnv: () => void = () => {};

	const mockPluginInput = {
		client: {} as any,
		project: {} as any,
		directory: '' as string,
		worktree: '' as string,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as any,
	};

	beforeAll(moduleGuards.setUpAll);
	afterAll(moduleGuards.tearDownAll);

	beforeEach(async () => {
		// Same isolation as tests/unit/index.test.ts: redirect XDG config/cache
		// dirs away from the developer's real home before the unstubbed boot.
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
		tempDir = await mkdtemp(path.join(tmpdir(), 'swarm-test-'));
		mockPluginInput.directory = tempDir;
		mockPluginInput.worktree = tempDir;
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		cleanupIsolatedEnv();
		cleanupIsolatedEnv = () => {};
	});

	test('server() boot leaves .opencode/opencode-swarm.json absent', async () => {
		await OpenCodeSwarm.server(mockPluginInput);

		expect(
			existsSync(path.join(tempDir, '.opencode', 'opencode-swarm.json')),
		).toBe(false);
	});
});
