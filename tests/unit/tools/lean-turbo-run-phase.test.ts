/**
 * Tests for lean_turbo_run_phase tool.
 *
 * Verifies leanConfig propagation from plugin config to LeanTurboRunner.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	executeLeanTurboRunPhase,
	type LeanTurboRunPhaseArgs,
} from '../../../src/tools/lean-turbo-run-phase';

// ---------------------------------------------------------------------------
// MOCKS
// ---------------------------------------------------------------------------

// Mock LeanTurboRunner to capture constructor options
interface LeanTurboRunnerCapture {
	options: {
		directory: string;
		sessionID: string;
		opencodeClient: unknown;
		generatedAgentNames: string[];
		leanConfig?: unknown;
	} | null;
}
const leanTurboRunnerCapture: LeanTurboRunnerCapture = { options: null };

const MockLeanTurboRunner = mock(function MockLeanTurboRunner(options: {
	directory: string;
	sessionID: string;
	opencodeClient?: unknown;
	generatedAgentNames?: string[];
	leanConfig?: unknown;
}) {
	leanTurboRunnerCapture.options = options;
	return {
		runPhase: mock(async () => ({
			ok: true,
			lanes: [],
			degradedTasks: [],
			serializedTasks: [],
		})),
		cleanup: mock(async () => {}),
		cleanupAfterSuccess: mock(async () => {}),
		cleanupAfterFailure: mock(async () => {}),
	};
});

// Mock loadPluginConfigWithMeta
const mockLoadPluginConfigWithMeta = mock(() => ({
	config: {},
	meta: { path: '/tmp/test' },
}));

// ---------------------------------------------------------------------------
// TEST SETUP
// ---------------------------------------------------------------------------

let tmpDir: string;
// Store originals for afterEach
let origLeanTurboRunner: typeof _internals.LeanTurboRunner;
let origLoadConfig: typeof _internals.loadPluginConfigWithMeta;

beforeEach(() => {
	// Save originals
	origLeanTurboRunner = _internals.LeanTurboRunner;
	origLoadConfig = _internals.loadPluginConfigWithMeta;

	// Inject mocks via _internals seam
	_internals.LeanTurboRunner = MockLeanTurboRunner as any;
	_internals.loadPluginConfigWithMeta = mockLoadPluginConfigWithMeta as any;

	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'lean-turbo-phase-test-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	leanTurboRunnerCapture.options = null;
	mockLoadPluginConfigWithMeta.mockClear();
	MockLeanTurboRunner.mockClear();
});

afterEach(() => {
	// Restore originals
	_internals.LeanTurboRunner = origLeanTurboRunner;
	_internals.loadPluginConfigWithMeta = origLoadConfig;

	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ---------------------------------------------------------------------------
// MERGE-BACK FAILURES PROPAGATION TESTS
// ---------------------------------------------------------------------------

describe('mergeBackFailures propagation', () => {
	test('executeLeanTurboRunPhase propagates mergeBackFailures from runner result', async () => {
		// Configure mock to return mergeBackFailures
		const mockFailures = [
			{ laneId: 'lane-1', reason: 'merge conflict on src/main.ts' },
			{
				laneId: 'lane-2',
				reason: 'rebase failed',
				conflictFiles: ['src/utils.ts', 'src/index.ts'],
			},
		];

		// Replace the default runPhase mock to include mergeBackFailures
		const mockRunnerInstance = {
			runPhase: mock(async () => ({
				ok: true,
				lanes: [],
				degradedTasks: [],
				serializedTasks: [],
				mergeBackFailures: mockFailures,
			})),
			cleanup: mock(async () => {}),
			cleanupAfterSuccess: mock(async () => {}),
			cleanupAfterFailure: mock(async () => {}),
		};

		// Override the mock constructor for this test
		const origConstructor = MockLeanTurboRunner;
		_internals.LeanTurboRunner = mock(function CustomRunner(_options: unknown) {
			return mockRunnerInstance;
		}) as any;

		const args: LeanTurboRunPhaseArgs = {
			directory: tmpDir,
			phase: 1,
			sessionID: 'test-session',
		};

		const result = await executeLeanTurboRunPhase(args);

		// Verify mergeBackFailures are present in the tool response
		expect(result.success).toBe(true);
		expect(result.mergeBackFailures).toBeDefined();
		expect(result.mergeBackFailures).toHaveLength(2);
		expect(result.mergeBackFailures).toEqual(mockFailures);

		// Restore original constructor
		_internals.LeanTurboRunner = origConstructor;
	});

	test('executeLeanTurboRunPhase propagates empty mergeBackFailures array', async () => {
		const mockRunnerInstance = {
			runPhase: mock(async () => ({
				ok: true,
				lanes: [],
				degradedTasks: [],
				serializedTasks: [],
				mergeBackFailures: [],
			})),
			cleanup: mock(async () => {}),
			cleanupAfterSuccess: mock(async () => {}),
			cleanupAfterFailure: mock(async () => {}),
		};

		const origConstructor = MockLeanTurboRunner;
		_internals.LeanTurboRunner = mock(function CustomRunner(_options: unknown) {
			return mockRunnerInstance;
		}) as any;

		const args: LeanTurboRunPhaseArgs = {
			directory: tmpDir,
			phase: 1,
			sessionID: 'test-session',
		};

		const result = await executeLeanTurboRunPhase(args);

		expect(result.success).toBe(true);
		expect(result.mergeBackFailures).toEqual([]);

		_internals.LeanTurboRunner = origConstructor;
	});

	test('executeLeanTurboRunPhase includes undefined mergeBackFailures when runner omits it', async () => {
		// The default MockLeanTurboRunner returns no mergeBackFailures
		const args: LeanTurboRunPhaseArgs = {
			directory: tmpDir,
			phase: 1,
			sessionID: 'test-session',
		};

		const result = await executeLeanTurboRunPhase(args);

		expect(result.success).toBe(true);
		expect(result.mergeBackFailures).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// CONFIG PROPAGATION TESTS
// ---------------------------------------------------------------------------

describe('leanConfig propagation', () => {
	test('executeLeanTurboRunPhase loads plugin config and passes leanConfig when strategy is lean', async () => {
		const customLeanConfig = { max_parallel_coders: 3 };

		// Configure mock to return lean strategy
		mockLoadPluginConfigWithMeta.mockReturnValueOnce({
			config: {
				turbo: {
					strategy: 'lean' as const,
					lean: customLeanConfig,
				},
			},
			meta: { path: tmpDir },
		});

		const args: LeanTurboRunPhaseArgs = {
			directory: tmpDir,
			phase: 1,
			sessionID: 'test-session',
		};

		const result = await executeLeanTurboRunPhase(args);

		// Verify config was loaded
		expect(mockLoadPluginConfigWithMeta).toHaveBeenCalledWith(tmpDir);

		// Verify leanConfig was passed to LeanTurboRunner
		expect(leanTurboRunnerCapture.options).not.toBeNull();
		expect(leanTurboRunnerCapture.options!.leanConfig).toEqual(
			customLeanConfig,
		);
	});

	test('executeLeanTurboRunPhase passes undefined leanConfig when strategy is standard', async () => {
		// Configure mock to return standard strategy
		mockLoadPluginConfigWithMeta.mockReturnValueOnce({
			config: {
				turbo: {
					strategy: 'standard' as const,
					lean: { max_parallel_coders: 4 },
				},
			},
			meta: { path: tmpDir },
		});

		const args: LeanTurboRunPhaseArgs = {
			directory: tmpDir,
			phase: 1,
			sessionID: 'test-session',
		};

		await executeLeanTurboRunPhase(args);

		// Verify leanConfig is undefined (not passed) when strategy is not lean
		expect(leanTurboRunnerCapture.options).not.toBeNull();
		expect(leanTurboRunnerCapture.options!.leanConfig).toBeUndefined();
	});

	test('executeLeanTurboRunPhase passes undefined leanConfig when turbo config is absent', async () => {
		// Configure mock to return no turbo config
		mockLoadPluginConfigWithMeta.mockReturnValueOnce({
			config: {},
			meta: { path: tmpDir },
		});

		const args: LeanTurboRunPhaseArgs = {
			directory: tmpDir,
			phase: 1,
			sessionID: 'test-session',
		};

		await executeLeanTurboRunPhase(args);

		// Verify leanConfig is undefined when no turbo config
		expect(leanTurboRunnerCapture.options).not.toBeNull();
		expect(leanTurboRunnerCapture.options!.leanConfig).toBeUndefined();
	});
});
