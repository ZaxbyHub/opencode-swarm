import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
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

// Task 2.4: Verify task handoff debug leakage is absent from visible output
// Tests the src/index.ts surface - verifies hooks created by src/index.ts don't emit debug text
describe('task handoff debug leakage absent (Task 2.4)', () => {
	let consoleLogSpy: any;

	beforeEach(() => {
		// Spy on console.log to capture output during plugin init and config
		consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		// Restore console.log after each test to avoid pollution
		consoleLogSpy.mockRestore();
	});

	it('does not emit debug text during plugin initialization', async () => {
		// Initialize plugin - this creates delegation tracker hook among others
		await OpenCodeSwarm.server(mockPluginInput);

		// Verify no debug leakage in console output during init
		const loggedOutput = consoleLogSpy.mock.calls
			.map((c: any[]) => c.join(' '))
			.join('\n');
		expect(loggedOutput).not.toContain('[swarm-debug-task]');
		expect(loggedOutput).not.toContain('chat.message');
		expect(loggedOutput).not.toContain('taskStates=');
	});

	it('does not emit debug text during config function execution', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		// Execute config function - this is the handoff setup path
		await plugin.config?.(mockConfig);

		// Verify no debug leakage in console output during config
		const loggedOutput = consoleLogSpy.mock.calls
			.map((c: any[]) => c.join(' '))
			.join('\n');
		expect(loggedOutput).not.toContain('[swarm-debug-task]');
		expect(loggedOutput).not.toContain('chat.message');
		expect(loggedOutput).not.toContain('taskStates=');
	});

	it('does not emit debug text during combined init and config flow', async () => {
		// Initialize plugin and run config in sequence - this covers the full setup path
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};
		await plugin.config?.(mockConfig);

		// Verify no debug leakage in console output during full setup flow
		const loggedOutput = consoleLogSpy.mock.calls
			.map((c: any[]) => c.join(' '))
			.join('\n');
		expect(loggedOutput).not.toContain('[swarm-debug-task]');
		expect(loggedOutput).not.toContain('chat.message');
		expect(loggedOutput).not.toContain('session=');
		expect(loggedOutput).not.toContain('agent=');
		expect(loggedOutput).not.toContain('prevAgent=');
		expect(loggedOutput).not.toContain('taskStates=');
	});
});
