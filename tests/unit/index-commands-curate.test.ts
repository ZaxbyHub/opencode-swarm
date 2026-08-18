import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'bun:test';
import OpenCodeSwarm from '../../src/index';
import {
	createIndexCommandsIsolation,
	createIndexCommandsModuleGuards,
	createMockPluginInput,
} from '../helpers/index-commands-shared.js';

// Split out of tests/unit/index-commands.test.ts, which had grown past the
// FR-006 500-line test-file cap enforced by scripts/check-test-file-cap.ts
// (PR #2173 F-003). Assertions are unchanged from the original file.
//
// Each split file owns its OWN mock plugin input: the object is mutated per
// test, so sharing one across files would let one file's teardown invalidate
// another file's paths.
const mockPluginInput = createMockPluginInput();
const isolation = createIndexCommandsIsolation(mockPluginInput);
// File-scoped, NOT per-test — see `createIndexCommandsModuleGuards` (PR #2173
// F-006): `OpenCodeSwarm.server()` schedules unref'd background tasks that
// would otherwise fire after `afterEach` and recreate this file's temp dirs as
// permanent orphans in the system temp directory.
const moduleGuards = createIndexCommandsModuleGuards();

beforeAll(moduleGuards.setUpAll);
beforeEach(isolation.setUp);
afterEach(isolation.tearDown);
afterAll(moduleGuards.tearDownAll);

// Task 4.4: Tests for curate command summary behavior, clear failure messaging, and alias discoverability
describe('swarm-curate command (Task 4.4)', () => {
	it('should register swarm-curate command', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Verify swarm-curate is registered
		expect(commands['swarm-curate']).toBeDefined();
	});

	it('should have correct template for swarm-curate command', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Verify template is /swarm curate (no arguments needed)
		expect(commands['swarm-curate'].template).toBe('/swarm curate');
	});

	it('should have syntax-hint description for discoverability', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Verify description contains syntax hint for discoverability
		const description = commands['swarm-curate'].description;
		expect(description).toContain('Use /swarm curate');
		expect(description).toContain('curate');
	});

	it('should include curate in the swarm management commands list', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Verify swarm command description includes curate in the list
		expect(commands.swarm.description).toContain('curate');
	});

	it('should have non-empty description for swarm-curate', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Verify description is not empty
		expect(commands['swarm-curate'].description).toBeTruthy();
		expect(commands['swarm-curate'].description.length).toBeGreaterThan(0);
	});

	it('should have one-line description for swarm-curate', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Verify description does not contain newlines
		expect(commands['swarm-curate'].description).not.toContain('\n');
	});
});
