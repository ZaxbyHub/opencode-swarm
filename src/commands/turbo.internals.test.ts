import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAgentSession, swarmState } from '../state';
import { _internals, handleTurboCommand } from './turbo';

// Track the original for restoration
type LoadPluginConfigWithMetaType = typeof _internals.loadPluginConfigWithMeta;
let original_loadPluginConfigWithMeta: LoadPluginConfigWithMetaType;

let testSessionId: string;
let tmpDir: string;

describe('turbo _internals DI seam', () => {
	beforeEach(() => {
		// Save original before each test
		original_loadPluginConfigWithMeta = _internals.loadPluginConfigWithMeta;

		// Create a temp directory for turbo state persistence (avoids writes outside repo sandbox)
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-internals-test-'));

		// Create a test session via swarmState (same pattern as other turbo test files)
		testSessionId = `internals-test-${Date.now()}`;
		swarmState.agentSessions.set(testSessionId, {
			agentName: 'architect',
			lastToolCallTime: Date.now(),
			lastAgentEventTime: Date.now(),
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: '1.1',
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set<string>(),
			selfFixAttempted: false,
			selfCodingWarnedAtCount: 0,
			catastrophicPhaseWarnings: new Set<number>(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			taskWorkflowStates: new Map(),
			stageBCompletion: new Map(),
			taskCouncilApproved: new Map(),
			lastGateOutcome: null,
			declaredCoderScope: null,
			turboMode: false,
			turboStrategy: undefined as string | undefined,
			leanTurboActive: false,
			leanTurboCurrentPhase: undefined as number | undefined,
			fullAutoMode: false,
		});
	});

	afterEach(() => {
		// Restore original _internals
		_internals.loadPluginConfigWithMeta = original_loadPluginConfigWithMeta;

		// Clean up session
		swarmState.agentSessions.delete(testSessionId);

		// Clean up temp directory
		if (tmpDir) {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('_internals is exported', () => {
		expect(_internals).toBeDefined();
		expect(typeof _internals).toBe('object');
	});

	test('_internals.loadPluginConfigWithMeta is a function', () => {
		expect(typeof _internals.loadPluginConfigWithMeta).toBe('function');
	});

	test('swapping _internals.loadPluginConfigWithMeta with a mock works — turbo on path (line 114)', async () => {
		// Arrange: swap with a mock
		const mockFn = mock(() => ({
			config: { turbo: { strategy: 'standard' } },
		}));
		_internals.loadPluginConfigWithMeta = mockFn;

		// Act: call handleTurboCommand with 'on' arg (exercises line 114)
		const result = await handleTurboCommand(tmpDir, ['on'], testSessionId);

		// Assert: mock was called
		expect(mockFn).toHaveBeenCalledWith(tmpDir);
		// Result should be 'Turbo Mode enabled' since strategy is 'standard'
		expect(result).toBe('Turbo Mode enabled');
	});

	test('swapping _internals.loadPluginConfigWithMeta with a mock works — lean turbo on path (line 196)', async () => {
		// Arrange: swap with a mock that returns lean strategy
		const mockFn = mock(() => ({
			config: {
				turbo: {
					strategy: 'lean',
					lean: { max_parallel_coders: 2, conflict_policy: 'degrade' as const },
				},
			},
		}));
		_internals.loadPluginConfigWithMeta = mockFn;

		// Act: call handleTurboCommand with 'lean on' args (exercises line 196)
		const result = await handleTurboCommand(
			tmpDir,
			['lean', 'on'],
			testSessionId,
		);

		// Assert: mock was called
		expect(mockFn).toHaveBeenCalledWith(tmpDir);
		// Result should indicate lean turbo was enabled
		expect(result).toContain('Lean Turbo enabled');
	});

	test('restoring the original works correctly', () => {
		// Arrange: swap with mock
		const mockFn = mock(() => ({ config: {} }));
		_internals.loadPluginConfigWithMeta = mockFn;

		// Act: restore
		_internals.loadPluginConfigWithMeta = original_loadPluginConfigWithMeta;

		// Assert: original function is restored
		expect(_internals.loadPluginConfigWithMeta).toBe(
			original_loadPluginConfigWithMeta,
		);
		// Verify it points to the actual imported function
		expect(typeof _internals.loadPluginConfigWithMeta).toBe('function');
	});

	test('original loadPluginConfigWithMeta is the real function', () => {
		// Verify the original is the actual imported function
		expect(original_loadPluginConfigWithMeta.name).toBe(
			'loadPluginConfigWithMeta',
		);
	});

	test('swap persists within a test (verifies isolated mutation)', async () => {
		// This test verifies that swapping _internals in one call affects subsequent calls
		// First call: mock returns lean strategy
		const mockFn = mock(() => ({
			config: { turbo: { strategy: 'lean', lean: { max_parallel_coders: 8 } } },
		}));
		_internals.loadPluginConfigWithMeta = mockFn;

		const result1 = await handleTurboCommand(
			tmpDir,
			['lean', 'on'],
			testSessionId,
		);
		expect(result1).toContain('Lean Turbo enabled');
		expect(result1).toContain('maxParallelCoders=8');

		// Second call with same mock should also use lean (mock still in place)
		const result2 = await handleTurboCommand(
			tmpDir,
			['lean', 'on'],
			testSessionId,
		);
		expect(result2).toContain('Lean Turbo enabled');
		expect(result2).toContain('maxParallelCoders=8');

		// Verify mock was called twice
		expect(mockFn).toHaveBeenCalledTimes(2);
	});
});
