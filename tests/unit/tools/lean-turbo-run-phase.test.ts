/**
 * Tests for lean_turbo_run_phase tool.
 *
 * Verifies the tool is properly exported, has correct structure, and
 * propagates leanConfig from plugin config to LeanTurboRunner.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	executeLeanTurboRunPhase,
	type LeanTurboRunPhaseArgs,
	type LeanTurboRunPhaseResult,
	lean_turbo_run_phase,
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
// STRUCTURE TESTS
// ---------------------------------------------------------------------------

describe('lean_turbo_run_phase tool', () => {
	test('lean_turbo_run_phase is exported', () => {
		expect(lean_turbo_run_phase).toBeDefined();
	});

	test('lean_turbo_run_phase has required structure', () => {
		// Tool definition must have required fields
		expect(lean_turbo_run_phase.description).toBeDefined();
		expect(typeof lean_turbo_run_phase.description).toBe('string');
		expect(lean_turbo_run_phase.args).toBeDefined();
		expect(lean_turbo_run_phase.execute).toBeDefined();
	});

	test('lean_turbo_run_phase args have required fields', () => {
		const args = lean_turbo_run_phase.args as {
			directory: { describe: (label: string) => string };
			phase: { describe: (label: string) => string };
			sessionID: { describe: (label: string) => string };
		};

		expect(args.directory.describe('directory')).toBeTruthy();
		expect(args.phase.describe('phase')).toBeTruthy();
		expect(args.sessionID.describe('sessionID')).toBeTruthy();
	});

	test('lean_turbo_run_phase execute is a function', () => {
		expect(typeof lean_turbo_run_phase.execute).toBe('function');
	});

	test('LeanTurboRunPhaseArgs interface is exported', () => {
		const args: LeanTurboRunPhaseArgs = {
			directory: '/test/dir',
			phase: 1,
			sessionID: 'test-session',
		};
		expect(args.directory).toBe('/test/dir');
		expect(args.phase).toBe(1);
		expect(args.sessionID).toBe('test-session');
	});

	test('LeanTurboRunPhaseResult interface is exported', () => {
		const result: LeanTurboRunPhaseResult = {
			success: true,
			lanes: [],
			degradedTasks: [],
		};
		expect(result.success).toBe(true);
		expect(result.lanes).toEqual([]);
		expect(result.degradedTasks).toEqual([]);
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
