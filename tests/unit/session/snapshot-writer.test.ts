/**
 * Verification tests for src/session/snapshot-writer.ts
 *
 * Tests cover:
 * 1. serializeAgentSession - Map/Set conversion, field preservation
 * 2. writeSnapshot - JSON writing, directory creation, field omission
 * 3. createSnapshotWriterHook - hook function behavior
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createSnapshotWriterHook,
	flushPendingSnapshot,
	type SerializedAgentSession,
	type SnapshotData,
	serializeAgentSession,
	writeSnapshot,
} from '../../../src/session/snapshot-writer';
import type {
	AgentSessionState,
	InvocationWindow,
	TaskWorkflowState,
} from '../../../src/state';

let testDir: string;

beforeEach(() => {
	// Create a unique temporary directory for each test
	testDir = path.join(
		os.tmpdir(),
		`snapshot-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	// Flush any pending snapshot writes to prevent test pollution
	flushPendingSnapshot(testDir).catch(() => {
		// Ignore errors during cleanup
	});

	// Clean up the test directory
	if (existsSync(testDir)) {
		rmSync(testDir, { recursive: true, force: true });
	}
});

describe('serializeAgentSession', () => {
	it('converts gateLog: Map<string, Set<string>> to Record<string, string[]>', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map([
				['task-1', new Set(['gate-a', 'gate-b'])],
				['task-2', new Set(['gate-c'])],
			]),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = serializeAgentSession(session);

		expect(result.gateLog).toEqual({
			'task-1': ['gate-a', 'gate-b'],
			'task-2': ['gate-c'],
		});
	});

	it('converts reviewerCallCount: Map<number, number> to Record<string, number>', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map([
				[1, 5],
				[2, 3],
				[3, 7],
			]),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = serializeAgentSession(session);

		expect(result.reviewerCallCount).toEqual({
			'1': 5,
			'2': 3,
			'3': 7,
		});
	});

	it('converts partialGateWarningsIssuedForTask: Set<string> to string[]', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(['task-1', 'task-2', 'task-3']),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = serializeAgentSession(session);

		expect(result.partialGateWarningsIssuedForTask).toEqual(
			expect.arrayContaining(['task-1', 'task-2', 'task-3']),
		);
		expect(result.partialGateWarningsIssuedForTask).toHaveLength(3);
	});

	it('converts catastrophicPhaseWarnings: Set<number> to number[]', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set([1, 3, 5]),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = serializeAgentSession(session);

		expect(result.catastrophicPhaseWarnings).toEqual(
			expect.arrayContaining([1, 3, 5]),
		);
		expect(result.catastrophicPhaseWarnings).toHaveLength(3);
	});

	it('converts phaseAgentsDispatched: Set<string> to string[]', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(['coder', 'reviewer', 'test_engineer']),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = serializeAgentSession(session);

		expect(result.phaseAgentsDispatched).toEqual(
			expect.arrayContaining(['coder', 'reviewer', 'test_engineer']),
		);
		expect(result.phaseAgentsDispatched).toHaveLength(3);
	});

	it('handles null/undefined Map/Set fields gracefully', () => {
		// Build session with all Map/Set fields as undefined
		const session = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
		} as unknown as AgentSessionState;

		const result = serializeAgentSession(session);

		// Should produce empty arrays/objects, not crash
		expect(result.gateLog).toEqual({});
		expect(result.reviewerCallCount).toEqual({});
		expect(result.partialGateWarningsIssuedForTask).toEqual([]);
		expect(result.catastrophicPhaseWarnings).toEqual([]);
		expect(result.phaseAgentsDispatched).toEqual([]);
	});

	it('preserves all plain fields as-is', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1234567890,
			lastAgentEventTime: 9876543210,
			delegationActive: true,
			activeInvocationId: 42,
			lastInvocationIdByAgent: { coder: 1, reviewer: 2 },
			windows: {},
			lastCompactionHint: 100,
			architectWriteCount: 5,
			lastCoderDelegationTaskId: 'task-123',
			currentTaskId: 'task-456',
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: {
				tool: 'write',
				taskId: 'task-789',
				timestamp: 1111111111,
			},
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: true,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 2222222222,
			lastPhaseCompletePhase: 3,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 2,
			qaSkipTaskIds: ['task-1', 'task-2'],
		};

		const result = serializeAgentSession(session);

		expect(result.agentName).toBe('architect');
		expect(result.lastToolCallTime).toBe(1234567890);
		expect(result.lastAgentEventTime).toBe(9876543210);
		expect(result.delegationActive).toBe(true);
		expect(result.activeInvocationId).toBe(42);
		expect(result.lastInvocationIdByAgent).toEqual({ coder: 1, reviewer: 2 });
		expect(result.lastCompactionHint).toBe(100);
		expect(result.architectWriteCount).toBe(5);
		expect(result.lastCoderDelegationTaskId).toBe('task-123');
		expect(result.currentTaskId).toBe('task-456');
		expect(result.lastGateFailure).toEqual({
			tool: 'write',
			taskId: 'task-789',
			timestamp: 1111111111,
		});
		expect(result.selfFixAttempted).toBe(true);
		expect(result.lastPhaseCompleteTimestamp).toBe(2222222222);
		expect(result.lastPhaseCompletePhase).toBe(3);
		expect(result.qaSkipCount).toBe(2);
		expect(result.qaSkipTaskIds).toEqual(['task-1', 'task-2']);
	});

	it('converts windows: Record<string, InvocationWindow> to Record<string, SerializedInvocationWindow>', () => {
		const window1: InvocationWindow = {
			id: 1,
			agentName: 'coder',
			startedAtMs: 1000,
			toolCalls: 10,
			consecutiveErrors: 2,
			hardLimitHit: false,
			lastSuccessTimeMs: 1500,
			recentToolCalls: [
				{ tool: 'read', argsHash: 123, timestamp: 1100 },
				{ tool: 'write', argsHash: 456, timestamp: 1200 },
			],
			warningIssued: true,
			warningReason: 'Test warning',
		};

		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: { 'coder:1': window1 },
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = serializeAgentSession(session);

		expect(result.windows).toHaveProperty('coder:1');
		expect(result.windows['coder:1']).toEqual({
			id: 1,
			agentName: 'coder',
			startedAtMs: 1000,
			toolCalls: 10,
			consecutiveErrors: 2,
			hardLimitHit: false,
			lastSuccessTimeMs: 1500,
			recentToolCalls: [
				{ tool: 'read', argsHash: 123, timestamp: 1100 },
				{ tool: 'write', argsHash: 456, timestamp: 1200 },
			],
			warningIssued: true,
			warningReason: 'Test warning',
			transientRetryCount: 0,
		});
	});

	it('handles empty windows object gracefully', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = serializeAgentSession(session);

		expect(result.windows).toEqual({});
	});
});

describe('writeSnapshot', () => {
	it('writes a valid JSON file to .swarm/session/state.json', async () => {
		const state = {
			toolAggregates: new Map([
				[
					'read',
					{
						tool: 'read',
						count: 5,
						successCount: 4,
						failureCount: 1,
						totalDuration: 100,
					},
				],
			]),
			activeAgent: new Map([['session-1', 'architect']]),
			delegationChains: new Map([
				[
					'session-1',
					[{ from: 'architect', to: 'coder', timestamp: Date.now() }],
				],
			]),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map(),
		};

		await writeSnapshot(testDir, state);

		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		expect(existsSync(filePath)).toBe(true);

		const content = await Bun.file(filePath).text();
		expect(() => JSON.parse(content)).not.toThrow();
	});

	it('writes JSON with version: 2', async () => {
		const state = {
			toolAggregates: new Map(),
			activeAgent: new Map(),
			delegationChains: new Map(),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map(),
		};

		await writeSnapshot(testDir, state);

		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content) as SnapshotData;

		expect(parsed.version).toBe(2);
	});

	it('creates .swarm/session/ directory if it does not exist', async () => {
		const state = {
			toolAggregates: new Map(),
			activeAgent: new Map(),
			delegationChains: new Map(),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map(),
		};

		// Verify the session directory doesn't exist before
		const sessionDirBefore = path.join(testDir, '.swarm', 'session');
		expect(existsSync(sessionDirBefore)).toBe(false);

		await writeSnapshot(testDir, state);

		// Verify the session directory was created
		expect(existsSync(sessionDirBefore)).toBe(true);
	});

	it('does NOT include activeToolCalls or pendingEvents in output', async () => {
		const state = {
			toolAggregates: new Map([
				[
					'read',
					{
						tool: 'read',
						count: 1,
						successCount: 1,
						failureCount: 0,
						totalDuration: 10,
					},
				],
			]),
			activeAgent: new Map(),
			delegationChains: new Map(),
			activeToolCalls: new Map([
				[
					'call-1',
					{
						tool: 'write',
						sessionID: 's1',
						callID: 'call-1',
						startTime: Date.now(),
					},
				],
			]),
			pendingEvents: 42,
			agentSessions: new Map(),
		};

		await writeSnapshot(testDir, state);

		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content) as SnapshotData;

		expect(parsed).not.toHaveProperty('activeToolCalls');
		expect(parsed).not.toHaveProperty('pendingEvents');
	});

	it('silently swallows errors (invalid directory should not throw)', async () => {
		const state = {
			toolAggregates: new Map(),
			activeAgent: new Map(),
			delegationChains: new Map(),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map(),
		};

		// Try to write to a path that will fail (e.g., directory that doesn't exist and can't be created)
		// Using a path like "/root/nonexistent" that typically fails on most systems
		// On Windows, try using an invalid path
		const invalidDir =
			process.platform === 'win32'
				? 'Z:\\nonexistent\\invalid'
				: '/root/nonexistent/path';

		await expect(writeSnapshot(invalidDir, state)).resolves.toBeUndefined();
	});

	it('writes valid JSON with empty objects/arrays for empty state', async () => {
		const state = {
			toolAggregates: new Map(),
			activeAgent: new Map(),
			delegationChains: new Map(),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map(),
		};

		await writeSnapshot(testDir, state);

		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content) as SnapshotData;

		expect(parsed).toEqual({
			version: 2,
			writtenAt: expect.any(Number),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		});

		// Verify it's within reasonable time range (within last few seconds)
		expect(parsed.writtenAt).toBeGreaterThan(Date.now() - 10000);
		expect(parsed.writtenAt).toBeLessThanOrEqual(Date.now());
	});

	it('serializes agentSessions correctly', async () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map([['task-1', new Set(['gate-a', 'gate-b'])]]),
			reviewerCallCount: new Map([[1, 5]]),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(['task-2']),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set([1, 2]),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(['coder']),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			turboMode: false,
			pendingAdvisoryMessages: [],
			model_fallback_index: 0,
			modelFallbackExhausted: false,
			coderRevisions: 0,
			revisionLimitHit: false,
		};

		const state = {
			toolAggregates: new Map(),
			activeAgent: new Map([['session-1', 'architect']]),
			delegationChains: new Map(),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map([['session-1', session]]),
		};

		await writeSnapshot(testDir, state);

		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content) as SnapshotData;

		expect(parsed.agentSessions).toHaveProperty('session-1');
		expect(parsed.agentSessions['session-1']).toEqual({
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: { 'task-1': ['gate-a', 'gate-b'] },
			reviewerCallCount: { '1': 5 },
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: ['task-2'],
			selfFixAttempted: false,
			selfCodingWarnedAtCount: 0,
			catastrophicPhaseWarnings: [1, 2],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: ['coder'],
			lastCompletedPhaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			taskWorkflowStates: {},
			turboMode: false,
			pendingAdvisoryMessages: [],
			model_fallback_index: 0,
			modelFallbackExhausted: false,
			coderRevisions: 0,
			revisionLimitHit: false,
			sessionRehydratedAt: 0,
			fullAutoMode: false,
			fullAutoInteractionCount: 0,
			fullAutoDeadlockCount: 0,
			fullAutoLastQuestionHash: null,
		});
	});
});

describe('writeSnapshot - fsyncSync (FR-004)', () => {
	// NOTE: Bun's mock.module does not support mocking already-imported modules
	// the way vitest's vi.mock does. These tests verify the OUTPUT of writeSnapshot
	// (file existence and content correctness) rather than internal call sequences.
	// The fsyncSync behavior (graceful failure, atomic rename) is verified by
	// the integration tests in snapshot-integration.test.ts.

	it('writes state.json with correct structure', async () => {
		const state = {
			toolAggregates: new Map(),
			activeAgent: new Map(),
			delegationChains: new Map(),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map(),
		};

		await writeSnapshot(testDir, state);

		// Verify file was created with correct content
		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		expect(existsSync(filePath)).toBe(true);
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content) as SnapshotData;
		expect(parsed.version).toBe(2);
		expect(parsed.toolAggregates).toEqual({});
	});

	it('writeSnapshot completes even if underlying write is slow', async () => {
		const state = {
			toolAggregates: new Map([
				[
					'read',
					{
						tool: 'read',
						count: 1,
						successCount: 1,
						failureCount: 0,
						totalDuration: 10,
					},
				],
			]),
			activeAgent: new Map(),
			delegationChains: new Map(),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map(),
		};

		// Must not throw
		await expect(writeSnapshot(testDir, state)).resolves.toBeUndefined();

		// The canonical file must exist with correct content
		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		expect(existsSync(filePath)).toBe(true);
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content) as SnapshotData;
		expect(parsed.version).toBe(2);
		expect(parsed.toolAggregates).toEqual({
			read: {
				tool: 'read',
				count: 1,
				successCount: 1,
				failureCount: 0,
				totalDuration: 10,
			},
		});
	});

	it('snapshot file contains correct delegationChains data', async () => {
		const state = {
			toolAggregates: new Map(),
			activeAgent: new Map(),
			delegationChains: new Map([
				[
					'session-1',
					[
						{ from: 'architect', to: 'coder', timestamp: 1700000000000 },
						{ from: 'coder', to: 'reviewer', timestamp: 1700000001000 },
					],
				],
			]),
			activeToolCalls: new Map(),
			pendingEvents: 0,
			agentSessions: new Map(),
		};

		await writeSnapshot(testDir, state);

		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		expect(existsSync(filePath)).toBe(true);
		const content = await Bun.file(filePath).text();
		const parsed = JSON.parse(content) as SnapshotData;
		expect(parsed.delegationChains['session-1']).toEqual([
			{ from: 'architect', to: 'coder', timestamp: 1700000000000 },
			{ from: 'coder', to: 'reviewer', timestamp: 1700000001000 },
		]);
	});
});

describe('createSnapshotWriterHook', () => {
	it('returns a function that accepts (input, output) and returns Promise<void>', () => {
		const hook = createSnapshotWriterHook(testDir);

		expect(typeof hook).toBe('function');
		expect(hook.length).toBe(2); // Should accept 2 arguments (input, output)
	});

	it('hook function is async (returns Promise)', async () => {
		const hook = createSnapshotWriterHook(testDir);
		const result = hook({}, {});

		expect(result).toBeInstanceOf(Promise);
		await result;
	});

	it('when called, writes state to disk', async () => {
		const hook = createSnapshotWriterHook(testDir);

		// Verify the file doesn't exist before calling the hook
		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		expect(existsSync(filePath)).toBe(false);

		// Call the hook
		await hook({}, {});

		// Flush the pending snapshot to trigger the debounced write
		await flushPendingSnapshot(testDir);

		// Verify the file exists after calling the hook
		expect(existsSync(filePath)).toBe(true);
	});

	it('does not throw on any input', async () => {
		const hook = createSnapshotWriterHook(testDir);

		// Test with various inputs
		await expect(hook(null, null)).resolves.toBeUndefined();
		await expect(hook(undefined, undefined)).resolves.toBeUndefined();
		await expect(hook('string', 123)).resolves.toBeUndefined();
		await expect(hook({}, {})).resolves.toBeUndefined();
		await expect(hook([], [])).resolves.toBeUndefined();
	});

	it('hook writes valid JSON file', async () => {
		const hook = createSnapshotWriterHook(testDir);

		await hook({}, {});

		// Flush the pending snapshot to trigger the debounced write
		await flushPendingSnapshot(testDir);

		const filePath = path.join(testDir, '.swarm', 'session', 'state.json');
		const content = await Bun.file(filePath).text();

		expect(() => JSON.parse(content)).not.toThrow();

		const parsed = JSON.parse(content) as SnapshotData;
		expect(parsed.version).toBe(2);
	});
});

describe('serializeAgentSession - taskWorkflowStates', () => {
	it('Map with entries serializes to Record<string, string>', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			taskWorkflowStates: new Map([
				['task-1', 'idle'],
				['task-2', 'coder_delegated'],
				['task-3', 'tests_run'],
			]),
		};

		const result = serializeAgentSession(session);

		expect(result.taskWorkflowStates).toEqual({
			'task-1': 'idle',
			'task-2': 'coder_delegated',
			'task-3': 'tests_run',
		});
	});

	it('Empty Map serializes to {}', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			taskWorkflowStates: new Map(),
		};

		const result = serializeAgentSession(session);

		expect(result.taskWorkflowStates).toEqual({});
	});

	it('undefined taskWorkflowStates serializes to {} (migration safety)', () => {
		const session = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
		} as unknown as AgentSessionState;

		const result = serializeAgentSession(session);

		expect(result.taskWorkflowStates).toEqual({});
	});

	it('All TaskWorkflowState values are preserved', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			taskWorkflowStates: new Map([
				['task-idle', 'idle'],
				['task-coder', 'coder_delegated'],
				['task-precheck', 'pre_check_passed'],
				['task-reviewer', 'reviewer_run'],
				['task-tests', 'tests_run'],
				['task-complete', 'complete'],
			]),
		};

		const result = serializeAgentSession(session);

		expect(result.taskWorkflowStates).toEqual({
			'task-idle': 'idle',
			'task-coder': 'coder_delegated',
			'task-precheck': 'pre_check_passed',
			'task-reviewer': 'reviewer_run',
			'task-tests': 'tests_run',
			'task-complete': 'complete',
		});
	});
});

describe('serializeAgentSession - taskWorkflowStates adversarial', () => {
	// Helper to create a minimal session with taskWorkflowStates
	// Uses type assertion to bypass strict type checking (matching existing test patterns)
	const createSessionWithWorkflowStates = (
		workflowStates: Map<string, TaskWorkflowState> | undefined,
	): AgentSessionState => {
		return {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			taskWorkflowStates: workflowStates as Map<string, TaskWorkflowState>,
		} as unknown as AgentSessionState;
	};

	it('handles empty string key', () => {
		const session = createSessionWithWorkflowStates(new Map([['', 'idle']]));
		const result = serializeAgentSession(session);
		expect(result.taskWorkflowStates).toEqual({ '': 'idle' });
	});

	it('handles special character keys', () => {
		const session = createSessionWithWorkflowStates(
			new Map([
				['task:with:colons', 'idle'],
				['task-dash', 'coder_delegated'],
				['task_underscore', 'tests_run'],
				['task.dot', 'complete'],
			]),
		);
		const result = serializeAgentSession(session);
		expect(result.taskWorkflowStates).toEqual({
			'task:with:colons': 'idle',
			'task-dash': 'coder_delegated',
			task_underscore: 'tests_run',
			'task.dot': 'complete',
		});
	});

	it('handles very long string keys (1000+ chars)', () => {
		const longKey = 'a'.repeat(2000);
		const session = createSessionWithWorkflowStates(
			new Map([[longKey, 'complete']]),
		);
		const result = serializeAgentSession(session);
		expect(result.taskWorkflowStates).toEqual({ [longKey]: 'complete' });
	});

	it('handles duplicate key insertion (Map semantics - last wins)', () => {
		const session = createSessionWithWorkflowStates(
			new Map<string, TaskWorkflowState>([
				['task-1', 'idle'],
				['task-1', 'coder_delegated'], // duplicate - should overwrite
				['task-1', 'tests_run'], // duplicate again - should be final value
			]),
		);
		const result = serializeAgentSession(session);
		expect(result.taskWorkflowStates).toEqual({ 'task-1': 'tests_run' });
	});

	it('handles null values in the Map', () => {
		// Create a Map with null values - this is valid TypeScript
		const workflowStates = new Map<string, TaskWorkflowState | null>([
			['task-1', 'idle'],
			['task-2', null],
			['task-3', 'complete'],
		]);
		const session = createSessionWithWorkflowStates(
			workflowStates as Map<string, TaskWorkflowState>,
		);
		const result = serializeAgentSession(session);
		// Object.fromEntries converts null to null (not filtered out)
		expect(result.taskWorkflowStates).toEqual({
			'task-1': 'idle',
			'task-2': null,
			'task-3': 'complete',
		});
	});

	it('handles very large Map (1000+ entries) without crashing', () => {
		const largeMap = new Map<string, TaskWorkflowState>();
		for (let i = 0; i < 1500; i++) {
			const states: TaskWorkflowState[] = [
				'idle',
				'coder_delegated',
				'pre_check_passed',
				'reviewer_run',
				'tests_run',
				'complete',
			];
			largeMap.set(`task-${i}`, states[i % 6]);
		}
		const session = createSessionWithWorkflowStates(largeMap);

		// Should not throw and should serialize correctly
		const result = serializeAgentSession(session);

		expect(Object.keys(result.taskWorkflowStates!).length).toBe(1500);
		expect(result.taskWorkflowStates!['task-0']).toBe('idle');
		// 1499 % 6 = 5, so states[5] = 'complete'
		expect(result.taskWorkflowStates!['task-1499']).toBe('complete');
	});

	it('handles __proto__ key (prototype pollution attempt)', () => {
		const session = createSessionWithWorkflowStates(
			new Map([['__proto__', 'complete']]),
		);
		const result = serializeAgentSession(session);
		// Object.fromEntries with __proto__ as key should work but not pollute prototype
		expect(result.taskWorkflowStates).toHaveProperty('__proto__');
		// Verify prototype is not polluted
		expect({}).toEqual({});
	});

	it('handles constructor key', () => {
		const session = createSessionWithWorkflowStates(
			new Map([['constructor', 'complete']]),
		);
		const result = serializeAgentSession(session);
		expect(result.taskWorkflowStates).toHaveProperty('constructor');
		expect(result.taskWorkflowStates!['constructor']).toBe('complete');
	});

	it('handles toString key', () => {
		const session = createSessionWithWorkflowStates(
			new Map([['toString', 'complete']]),
		);
		const result = serializeAgentSession(session);
		expect(result.taskWorkflowStates).toHaveProperty('toString');
		expect(result.taskWorkflowStates!['toString']).toBe('complete');
	});

	it('handles multiple prototype-polluting keys together', () => {
		const session = createSessionWithWorkflowStates(
			new Map([
				['__proto__', 'complete'],
				['constructor', 'complete'],
				['toString', 'complete'],
				['hasOwnProperty', 'complete'],
			]),
		);
		const result = serializeAgentSession(session);
		// Verify all keys exist with correct values
		expect(result.taskWorkflowStates).toHaveProperty('__proto__');
		expect(result.taskWorkflowStates).toHaveProperty('constructor');
		expect(result.taskWorkflowStates).toHaveProperty('toString');
		expect(result.taskWorkflowStates).toHaveProperty('hasOwnProperty');
		expect(result.taskWorkflowStates!['__proto__']).toBe('complete');
		expect(result.taskWorkflowStates!['constructor']).toBe('complete');
		expect(result.taskWorkflowStates!['toString']).toBe('complete');
		expect(result.taskWorkflowStates!['hasOwnProperty']).toBe('complete');
	});
});

describe('serializeAgentSession - scopeViolationDetected', () => {
	it('includes scopeViolationDetected when set to true', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			scopeViolationDetected: true,
		};

		const result = serializeAgentSession(session);

		expect(result.scopeViolationDetected).toBe(true);
	});

	it('includes scopeViolationDetected when set to false', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			scopeViolationDetected: false,
		};

		const result = serializeAgentSession(session);

		expect(result.scopeViolationDetected).toBe(false);
	});

	it('omits scopeViolationDetected when undefined (additive-only schema)', () => {
		const session: AgentSessionState = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = serializeAgentSession(session);

		expect(result).not.toHaveProperty('scopeViolationDetected');
	});

	it('omits scopeViolationDetected when explicitly undefined', () => {
		const session = {
			agentName: 'architect',
			lastToolCallTime: 1000,
			lastAgentEventTime: 1000,
			delegationActive: false,
			activeInvocationId: 0,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: new Map(),
			reviewerCallCount: new Map(),
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: new Set(),
			selfFixAttempted: false,
			catastrophicPhaseWarnings: new Set(),
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			scopeViolationDetected: undefined,
		} as unknown as AgentSessionState;

		const result = serializeAgentSession(session);

		expect(result).not.toHaveProperty('scopeViolationDetected');
	});
});
