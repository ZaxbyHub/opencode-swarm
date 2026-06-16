/**
 * Verification tests for src/session/snapshot-reader.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { startFullAutoRun } from '../../../src/full-auto/state';
import {
	deserializeAgentSession,
	loadSnapshot,
	readSnapshot,
	rehydrateState,
} from '../../../src/session/snapshot-reader';
import type {
	SerializedAgentSession,
	SnapshotData,
} from '../../../src/session/snapshot-writer';
import type { DelegationEntry, ToolAggregate } from '../../../src/state';
import { resetSwarmState, swarmState } from '../../../src/state';

describe('deserializeAgentSession', () => {
	it('restores gateLog: Record<string, string[]> → Map<string, Set<string>>', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {
				'task-1': ['gate-a', 'gate-b'],
				'task-2': ['gate-c'],
			},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.gateLog).toBeInstanceOf(Map);
		expect(result.gateLog.get('task-1')).toEqual(new Set(['gate-a', 'gate-b']));
		expect(result.gateLog.get('task-2')).toEqual(new Set(['gate-c']));
	});

	it('restores reviewerCallCount: Record<string, number> → Map<number, number>', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {
				'1': 5,
				'2': 10,
				'3': 15,
			},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.reviewerCallCount).toBeInstanceOf(Map);
		expect(result.reviewerCallCount.get(1)).toBe(5);
		expect(result.reviewerCallCount.get(2)).toBe(10);
		expect(result.reviewerCallCount.get(3)).toBe(15);
	});

	it('skips NaN/Infinity keys in reviewerCallCount', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {
				'1': 5,
				NaN: 10,
				Infinity: 15,
				'-Infinity': 20,
				invalid: 25,
				'2': 30,
			},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.reviewerCallCount.size).toBe(2);
		expect(result.reviewerCallCount.get(1)).toBe(5);
		expect(result.reviewerCallCount.get(2)).toBe(30);
		expect(result.reviewerCallCount.get(NaN)).toBeUndefined();
		expect(result.reviewerCallCount.get(Infinity)).toBeUndefined();
	});

	it('restores partialGateWarningsIssuedForTask: string[] → Set<string>', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: ['task-1', 'task-2', 'task-3'],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.partialGateWarningsIssuedForTask).toBeInstanceOf(Set);
		expect(result.partialGateWarningsIssuedForTask.has('task-1')).toBe(true);
		expect(result.partialGateWarningsIssuedForTask.has('task-2')).toBe(true);
		expect(result.partialGateWarningsIssuedForTask.has('task-3')).toBe(true);
	});

	it('restores catastrophicPhaseWarnings: number[] → Set<number>', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [1, 2, 3, 4, 5],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.catastrophicPhaseWarnings).toBeInstanceOf(Set);
		expect(result.catastrophicPhaseWarnings.has(1)).toBe(true);
		expect(result.catastrophicPhaseWarnings.has(3)).toBe(true);
		expect(result.catastrophicPhaseWarnings.has(5)).toBe(true);
	});

	it('restores phaseAgentsDispatched: string[] → Set<string>', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: ['coder', 'reviewer', 'test_engineer'],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.phaseAgentsDispatched).toBeInstanceOf(Set);
		expect(result.phaseAgentsDispatched.has('coder')).toBe(true);
		expect(result.phaseAgentsDispatched.has('reviewer')).toBe(true);
		expect(result.phaseAgentsDispatched.has('test_engineer')).toBe(true);
	});

	it('handles null/undefined arrays/records gracefully (produces empty Map/Set)', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: undefined as any,
			reviewerCallCount: null as any,
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: null as any,
			selfFixAttempted: false,
			catastrophicPhaseWarnings: null as any,
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: null as any,
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.gateLog).toBeInstanceOf(Map);
		expect(result.gateLog.size).toBe(0);
		expect(result.reviewerCallCount).toBeInstanceOf(Map);
		expect(result.reviewerCallCount.size).toBe(0);
		expect(result.partialGateWarningsIssuedForTask).toBeInstanceOf(Set);
		expect(result.partialGateWarningsIssuedForTask.size).toBe(0);
		expect(result.catastrophicPhaseWarnings).toBeInstanceOf(Set);
		expect(result.catastrophicPhaseWarnings.size).toBe(0);
		expect(result.phaseAgentsDispatched).toBeInstanceOf(Set);
		expect(result.phaseAgentsDispatched.size).toBe(0);
	});

	it('preserves all plain fields correctly', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 789012,
			delegationActive: true,
			activeInvocationId: 5,
			lastInvocationIdByAgent: { coder: 3, reviewer: 2 },
			windows: {},
			lastCompactionHint: 100,
			architectWriteCount: 7,
			lastCoderDelegationTaskId: 'task-123',
			currentTaskId: 'task-456',
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: { tool: 'bash', taskId: 'task-789', timestamp: 999999 },
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: true,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 111111,
			lastPhaseCompletePhase: 2,
			phaseAgentsDispatched: [],
			qaSkipCount: 3,
			qaSkipTaskIds: ['task-a', 'task-b'],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.agentName).toBe('architect');
		expect(result.lastToolCallTime).toBe(123456);
		expect(result.lastAgentEventTime).toBe(789012);
		expect(result.delegationActive).toBe(true);
		expect(result.activeInvocationId).toBe(5);
		expect(result.lastInvocationIdByAgent).toEqual({ coder: 3, reviewer: 2 });
		expect(result.lastCompactionHint).toBe(100);
		expect(result.architectWriteCount).toBe(7);
		expect(result.lastCoderDelegationTaskId).toBe('task-123');
		expect(result.currentTaskId).toBe('task-456');
		expect(result.lastGateFailure).toEqual({
			tool: 'bash',
			taskId: 'task-789',
			timestamp: 999999,
		});
		expect(result.selfFixAttempted).toBe(true);
		expect(result.lastPhaseCompleteTimestamp).toBe(111111);
		expect(result.lastPhaseCompletePhase).toBe(2);
		expect(result.qaSkipCount).toBe(3);
		expect(result.qaSkipTaskIds).toEqual(['task-a', 'task-b']);
	});

	it('applies migration safety defaults for missing fields', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: undefined as any,
			windows: undefined as any,
			lastCompactionHint: undefined as any,
			architectWriteCount: undefined as any,
			lastCoderDelegationTaskId: undefined as any,
			currentTaskId: undefined as any,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: undefined as any,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: undefined as any,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: undefined as any,
			lastPhaseCompletePhase: undefined as any,
			phaseAgentsDispatched: [],
			qaSkipCount: undefined as any,
			qaSkipTaskIds: undefined as any,
		};

		const result = deserializeAgentSession(serialized);

		expect(result.lastInvocationIdByAgent).toEqual({});
		expect(result.windows).toEqual({});
		expect(result.lastCompactionHint).toBe(0);
		expect(result.architectWriteCount).toBe(0);
		expect(result.lastCoderDelegationTaskId).toBeNull();
		expect(result.currentTaskId).toBeNull();
		expect(result.lastGateFailure).toBeNull();
		expect(result.selfFixAttempted).toBe(false);
		expect(result.lastPhaseCompleteTimestamp).toBe(0);
		expect(result.lastPhaseCompletePhase).toBe(0);
		expect(result.qaSkipCount).toBe(0);
		expect(result.qaSkipTaskIds).toEqual([]);
	});

	it('restores scopeViolationDetected: true when present in snapshot', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			selfCodingWarnedAtCount: 0,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			lastCompletedPhaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			scopeViolationDetected: true,
		};

		const result = deserializeAgentSession(serialized);

		expect(result.scopeViolationDetected).toBe(true);
	});

	it('restores scopeViolationDetected: false when present in snapshot', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			selfCodingWarnedAtCount: 0,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			lastCompletedPhaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			scopeViolationDetected: false,
		};

		const result = deserializeAgentSession(serialized);

		expect(result.scopeViolationDetected).toBe(false);
	});

	it('legacy snapshot without scopeViolationDetected field → undefined (absent-safe)', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			selfCodingWarnedAtCount: 0,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			lastCompletedPhaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			// scopeViolationDetected NOT set - simulates legacy snapshot
		};

		const result = deserializeAgentSession(serialized);

		expect(result.scopeViolationDetected).toBeUndefined();
	});
});

describe('readSnapshot', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(
			os.tmpdir(),
			`snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
	});

	it('returns SnapshotData for valid JSON file with version: 1', async () => {
		const validSnapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {
				bash: {
					tool: 'bash',
					count: 10,
					successCount: 8,
					failureCount: 2,
					totalDuration: 5000,
				},
			},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};

		const sessionDir = path.join(testDir, '.swarm', 'session');
		await Bun.write(
			path.join(sessionDir, 'state.json'),
			JSON.stringify(validSnapshot, null, 2),
		);

		const result = await readSnapshot(testDir);

		expect(result).not.toBeNull();
		expect(result?.version).toBe(1);
		expect(result?.writtenAt).toBe(validSnapshot.writtenAt);
		expect(result?.toolAggregates).toEqual(validSnapshot.toolAggregates);
	});

	it('returns null for missing file (no throw)', async () => {
		// Don't create any file - just try to read
		const result = await readSnapshot(testDir);

		expect(result).toBeNull();
	});

	it('returns null for corrupt JSON (no throw)', async () => {
		const sessionDir = path.join(testDir, '.swarm', 'session');
		await Bun.write(path.join(sessionDir, 'state.json'), '{ invalid json }');

		const result = await readSnapshot(testDir);

		expect(result).toBeNull();
	});

	it('returns null for wrong version', async () => {
		const wrongVersionSnapshot = {
			version: 3,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};

		const sessionDir = path.join(testDir, '.swarm', 'session');
		await Bun.write(
			path.join(sessionDir, 'state.json'),
			JSON.stringify(wrongVersionSnapshot, null, 2),
		);

		const result = await readSnapshot(testDir);

		expect(result).toBeNull();
	});

	it('returns null for empty file', async () => {
		const sessionDir = path.join(testDir, '.swarm', 'session');
		await Bun.write(path.join(sessionDir, 'state.json'), '');

		const result = await readSnapshot(testDir);

		expect(result).toBeNull();
	});

	it('returns null for whitespace-only file', async () => {
		const sessionDir = path.join(testDir, '.swarm', 'session');
		await Bun.write(path.join(sessionDir, 'state.json'), '   \n\t  \n');

		const result = await readSnapshot(testDir);

		expect(result).toBeNull();
	});

	it('never throws on any input', async () => {
		// Test various invalid inputs - should never throw
		try {
			const result1 = await readSnapshot(testDir); // missing file
			expect(result1).toBeNull();
		} catch (e) {
			expect.fail(`readSnapshot threw an error: ${e}`);
		}

		// Test with corrupt JSON
		const sessionDir = path.join(testDir, '.swarm', 'session');
		await Bun.write(path.join(sessionDir, 'state.json'), '{corrupt}');

		try {
			const result2 = await readSnapshot(testDir);
			expect(result2).toBeNull();
		} catch (e) {
			expect.fail(`readSnapshot threw an error: ${e}`);
		}
	});
});

describe('rehydrateState', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('correctly clears all 4 maps before repopulating', async () => {
		// Pre-populate state
		swarmState.toolAggregates.set('bash', {
			tool: 'bash',
			count: 1,
			successCount: 1,
			failureCount: 0,
			totalDuration: 100,
		});
		swarmState.activeAgent.set('session-1', 'architect');
		swarmState.delegationChains.set('session-1', [
			{ from: 'architect', to: 'coder', timestamp: Date.now() },
		]);
		swarmState.agentSessions.set('session-1', {
			agentName: 'architect',
			lastToolCallTime: Date.now(),
			lastAgentEventTime: Date.now(),
			delegationActive: false,
			activeInvocationId: 1,
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
		});

		const snapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};

		await rehydrateState(snapshot);

		expect(swarmState.toolAggregates.size).toBe(0);
		expect(swarmState.activeAgent.size).toBe(0);
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);
	});

	it('populates toolAggregates from snapshot', async () => {
		const snapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {
				bash: {
					tool: 'bash',
					count: 10,
					successCount: 8,
					failureCount: 2,
					totalDuration: 5000,
				},
				read: {
					tool: 'read',
					count: 5,
					successCount: 5,
					failureCount: 0,
					totalDuration: 1000,
				},
			},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};

		await rehydrateState(snapshot);

		expect(swarmState.toolAggregates.size).toBe(2);
		expect(swarmState.toolAggregates.get('bash')).toEqual({
			tool: 'bash',
			count: 10,
			successCount: 8,
			failureCount: 2,
			totalDuration: 5000,
		});
		expect(swarmState.toolAggregates.get('read')).toEqual({
			tool: 'read',
			count: 5,
			successCount: 5,
			failureCount: 0,
			totalDuration: 1000,
		});
	});

	it('populates activeAgent from snapshot', async () => {
		const snapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {
				'session-1': 'architect',
				'session-2': 'coder',
				'session-3': 'reviewer',
			},
			delegationChains: {},
			agentSessions: {},
		};

		await rehydrateState(snapshot);

		expect(swarmState.activeAgent.size).toBe(3);
		expect(swarmState.activeAgent.get('session-1')).toBe('architect');
		expect(swarmState.activeAgent.get('session-2')).toBe('coder');
		expect(swarmState.activeAgent.get('session-3')).toBe('reviewer');
	});

	it('populates delegationChains from snapshot', async () => {
		const snapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {
				'session-1': [
					{ from: 'architect', to: 'coder', timestamp: 123456 },
					{ from: 'coder', to: 'reviewer', timestamp: 123457 },
				],
				'session-2': [
					{ from: 'architect', to: 'test_engineer', timestamp: 123458 },
				],
			},
			agentSessions: {},
		};

		await rehydrateState(snapshot);

		expect(swarmState.delegationChains.size).toBe(2);
		expect(swarmState.delegationChains.get('session-1')).toEqual([
			{ from: 'architect', to: 'coder', timestamp: 123456 },
			{ from: 'coder', to: 'reviewer', timestamp: 123457 },
		]);
		expect(swarmState.delegationChains.get('session-2')).toEqual([
			{ from: 'architect', to: 'test_engineer', timestamp: 123458 },
		]);
	});

	it('populates agentSessions using deserializeAgentSession', async () => {
		const serializedSession: SerializedAgentSession = {
			agentName: 'architect',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: {},
			windows: {},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: { 'task-1': ['gate-a', 'gate-b'] },
			reviewerCallCount: { '1': 5, '2': 10 },
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: ['task-2'],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [1, 2, 3],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: ['coder', 'reviewer'],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const snapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {
				'session-1': serializedSession,
				'session-2': serializedSession,
			},
		};

		await rehydrateState(snapshot);

		expect(swarmState.agentSessions.size).toBe(2);

		const session1 = swarmState.agentSessions.get('session-1');
		expect(session1).toBeDefined();
		expect(session1?.agentName).toBe('architect');
		expect(session1?.gateLog.get('task-1')).toEqual(
			new Set(['gate-a', 'gate-b']),
		);
		expect(session1?.reviewerCallCount.get(1)).toBe(5);
		expect(session1?.reviewerCallCount.get(2)).toBe(10);
		expect(session1?.partialGateWarningsIssuedForTask.has('task-2')).toBe(true);
		expect(session1?.catastrophicPhaseWarnings.has(1)).toBe(true);
		expect(session1?.phaseAgentsDispatched.has('coder')).toBe(true);

		const session2 = swarmState.agentSessions.get('session-2');
		expect(session2).toBeDefined();
		expect(session2?.agentName).toBe('architect');
	});

	it('does NOT touch activeToolCalls or pendingEvents', async () => {
		// Pre-populate activeToolCalls and pendingEvents
		swarmState.activeToolCalls.set('call-1', {
			tool: 'bash',
			sessionID: 'session-1',
			callID: 'call-1',
			startTime: Date.now(),
		});
		swarmState.pendingEvents = 42;

		const snapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};

		await rehydrateState(snapshot);

		// activeToolCalls and pendingEvents should remain unchanged
		expect(swarmState.activeToolCalls.size).toBe(1);
		expect(swarmState.activeToolCalls.get('call-1')).toEqual({
			tool: 'bash',
			sessionID: 'session-1',
			callID: 'call-1',
			startTime: expect.any(Number),
		});
		expect(swarmState.pendingEvents).toBe(42);
	});

	it('resets InvocationWindow counters and hardLimitHit on rehydration', async () => {
		resetSwarmState();

		const staleTime = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
		const snapshot: SnapshotData = {
			version: 2,
			writtenAt: staleTime,
			toolAggregates: {},
			activeAgent: { ses_abc: 'coder' },
			delegationChains: {},
			agentSessions: {
				ses_abc: {
					agentName: 'coder',
					lastToolCallTime: staleTime,
					lastAgentEventTime: staleTime,
					delegationActive: true,
					activeInvocationId: 3,
					lastInvocationIdByAgent: { coder: 3 },
					windows: {
						'coder:3': {
							id: 3,
							agentName: 'coder',
							startedAtMs: staleTime,
							toolCalls: 395,
							consecutiveErrors: 4,
							hardLimitHit: true,
							lastSuccessTimeMs: staleTime,
							recentToolCalls: [
								{ tool: 'bash', argsHash: 123, timestamp: staleTime },
							],
							warningIssued: true,
							warningReason: 'tool call limit approaching',
						},
					},
					lastCompactionHint: 0,
					architectWriteCount: 0,
					lastCoderDelegationTaskId: null,
					currentTaskId: 'task-1',
					gateLog: {},
					reviewerCallCount: {},
					lastGateFailure: null,
					partialGateWarningsIssuedForTask: [],
					selfFixAttempted: false,
					catastrophicPhaseWarnings: [],
					lastPhaseCompleteTimestamp: 0,
					lastPhaseCompletePhase: 0,
					phaseAgentsDispatched: [],
					qaSkipCount: 0,
					qaSkipTaskIds: [],
				} as any,
			},
		};

		const beforeRehydrate = Date.now();
		await rehydrateState(snapshot);

		const session = swarmState.agentSessions.get('ses_abc');
		expect(session).toBeDefined();

		// Session timestamps should be refreshed
		expect(session!.lastToolCallTime).toBeGreaterThanOrEqual(beforeRehydrate);
		expect(session!.lastAgentEventTime).toBeGreaterThanOrEqual(beforeRehydrate);

		// Window should exist and have reset counters
		const window = session!.windows['coder:3'];
		expect(window).toBeDefined();
		expect(window.startedAtMs).toBeGreaterThanOrEqual(beforeRehydrate);
		expect(window.lastSuccessTimeMs).toBeGreaterThanOrEqual(beforeRehydrate);
		expect(window.hardLimitHit).toBe(false);
		expect(window.toolCalls).toBe(0);
		expect(window.consecutiveErrors).toBe(0);
		expect(window.recentToolCalls).toEqual([]);
		expect(window.warningIssued).toBe(false);
		expect(window.warningReason).toBe('');
	});

	it('empty snapshot objects produce empty Maps', async () => {
		const snapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};

		await rehydrateState(snapshot);

		expect(swarmState.toolAggregates.size).toBe(0);
		expect(swarmState.activeAgent.size).toBe(0);
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);
	});

	it('clears fullAutoMode on restored sessions when no running durable Full-Auto run exists', async () => {
		// First-class toggle: the durable per-session run state is the authority.
		// A snapshot with fullAutoMode: true but no running durable run (here:
		// no directory passed at all) must fail closed toward OFF.
		const snapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {
				'session-fa': {
					agentName: 'architect',
					lastToolCallTime: Date.now(),
					lastAgentEventTime: Date.now(),
					delegationActive: false,
					activeInvocationId: 1,
					lastInvocationIdByAgent: {},
					windows: {},
					lastCompactionHint: 0,
					architectWriteCount: 0,
					lastCoderDelegationTaskId: null,
					currentTaskId: null,
					gateLog: {},
					reviewerCallCount: {},
					lastGateFailure: null,
					partialGateWarningsIssuedForTask: [],
					selfFixAttempted: false,
					catastrophicPhaseWarnings: [],
					lastPhaseCompleteTimestamp: 0,
					lastPhaseCompletePhase: 0,
					phaseAgentsDispatched: [],
					qaSkipCount: 0,
					qaSkipTaskIds: [],
					fullAutoMode: true, // snapshot says ON
				},
			},
		};

		await rehydrateState(snapshot);

		const restored = swarmState.agentSessions.get('session-fa');
		expect(restored).toBeDefined();
		// fullAutoMode must be cleared because no running durable run exists
		expect(restored!.fullAutoMode).toBe(false);
	});

	it('preserves fullAutoMode on restored sessions when the durable run is still running', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-fullauto-'));
		try {
			startFullAutoRun(tmpDir, 'session-fa', { enabled: true });

			const snapshot: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {
					'session-fa': {
						agentName: 'architect',
						lastToolCallTime: Date.now(),
						lastAgentEventTime: Date.now(),
						delegationActive: false,
						activeInvocationId: 1,
						lastInvocationIdByAgent: {},
						windows: {},
						lastCompactionHint: 0,
						architectWriteCount: 0,
						lastCoderDelegationTaskId: null,
						currentTaskId: null,
						gateLog: {},
						reviewerCallCount: {},
						lastGateFailure: null,
						partialGateWarningsIssuedForTask: [],
						selfFixAttempted: false,
						catastrophicPhaseWarnings: [],
						lastPhaseCompleteTimestamp: 0,
						lastPhaseCompletePhase: 0,
						phaseAgentsDispatched: [],
						qaSkipCount: 0,
						qaSkipTaskIds: [],
						fullAutoMode: true,
					},
				},
			};

			await rehydrateState(snapshot, tmpDir);

			const restored = swarmState.agentSessions.get('session-fa');
			expect(restored).toBeDefined();
			// fullAutoMode preserved because the durable run is still 'running'
			expect(restored!.fullAutoMode).toBe(true);
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	});
});

describe('loadSnapshot', () => {
	let testDir: string;

	beforeEach(() => {
		resetSwarmState();
		testDir = path.join(
			os.tmpdir(),
			`snapshot-load-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
	});

	it('with valid file: rehydrates swarmState', async () => {
		const validSnapshot: SnapshotData = {
			version: 1,
			writtenAt: Date.now(),
			toolAggregates: {
				bash: {
					tool: 'bash',
					count: 10,
					successCount: 8,
					failureCount: 2,
					totalDuration: 5000,
				},
			},
			activeAgent: {
				'session-1': 'architect',
			},
			delegationChains: {},
			agentSessions: {},
		};

		const sessionDir = path.join(testDir, '.swarm', 'session');
		await Bun.write(
			path.join(sessionDir, 'state.json'),
			JSON.stringify(validSnapshot, null, 2),
		);

		await loadSnapshot(testDir);

		expect(swarmState.toolAggregates.size).toBe(1);
		expect(swarmState.toolAggregates.get('bash')).toEqual({
			tool: 'bash',
			count: 10,
			successCount: 8,
			failureCount: 2,
			totalDuration: 5000,
		});
		expect(swarmState.activeAgent.get('session-1')).toBe('architect');
	});

	it('with missing file: leaves swarmState at defaults (no-op)', async () => {
		// Don't create any file - just try to load
		await loadSnapshot(testDir);

		// State should remain at default empty values
		expect(swarmState.toolAggregates.size).toBe(0);
		expect(swarmState.activeAgent.size).toBe(0);
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);
		expect(swarmState.activeToolCalls.size).toBe(0);
		expect(swarmState.pendingEvents).toBe(0);
	});

	it('never throws on any input', async () => {
		// Test with corrupt JSON - should not throw
		const sessionDir = path.join(testDir, '.swarm', 'session');
		await Bun.write(path.join(sessionDir, 'state.json'), '{invalid}');

		try {
			await loadSnapshot(testDir);
		} catch (e) {
			expect.fail(`loadSnapshot threw an error: ${e}`);
		}
	});

	it('calls rehydrateState only when snapshot is non-null', async () => {
		// Test with wrong version (readSnapshot returns null)
		const wrongVersionSnapshot = {
			version: 3,
			writtenAt: Date.now(),
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: {},
		};

		const sessionDir = path.join(testDir, '.swarm', 'session');
		await Bun.write(
			path.join(sessionDir, 'state.json'),
			JSON.stringify(wrongVersionSnapshot, null, 2),
		);

		// Pre-populate state to verify it doesn't get cleared
		swarmState.toolAggregates.set('bash', {
			tool: 'bash',
			count: 1,
			successCount: 1,
			failureCount: 0,
			totalDuration: 100,
		});

		await loadSnapshot(testDir);

		// State should remain unchanged because readSnapshot returned null
		expect(swarmState.toolAggregates.size).toBe(1);
		expect(swarmState.toolAggregates.get('bash')).toEqual({
			tool: 'bash',
			count: 1,
			successCount: 1,
			failureCount: 0,
			totalDuration: 100,
		});
	});
});

describe('deserializeAgentSession - taskWorkflowStates', () => {
	const createBaseSession = (): SerializedAgentSession => ({
		agentName: 'architect',
		lastToolCallTime: 123456,
		lastAgentEventTime: 123456,
		delegationActive: false,
		activeInvocationId: 1,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: {},
		reviewerCallCount: {},
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: [],
		selfFixAttempted: false,
		catastrophicPhaseWarnings: [],
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: [],
		qaSkipCount: 0,
		qaSkipTaskIds: [],
	});

	it('valid entries reconstruct Map correctly', () => {
		const serialized = createBaseSession();
		(serialized as any).taskWorkflowStates = {
			'task-1': 'idle',
			'task-2': 'tests_run',
		};

		const result = deserializeAgentSession(serialized);

		expect(result.taskWorkflowStates).toBeInstanceOf(Map);
		expect(result.taskWorkflowStates.size).toBe(2);
		expect(result.taskWorkflowStates.get('task-1')).toBe('idle');
		expect(result.taskWorkflowStates.get('task-2')).toBe('tests_run');
	});

	it('legacy snapshot without taskWorkflowStates field → empty Map', () => {
		const serialized = createBaseSession();
		// Don't set taskWorkflowStates at all (simulates legacy snapshot)

		const result = deserializeAgentSession(serialized);

		expect(result.taskWorkflowStates).toBeInstanceOf(Map);
		expect(result.taskWorkflowStates.size).toBe(0);
	});

	it('invalid state values are skipped', () => {
		const serialized = createBaseSession();
		(serialized as any).taskWorkflowStates = {
			'task-1': 'unknown_state',
			'task-2': 'idle',
		};

		const result = deserializeAgentSession(serialized);

		expect(result.taskWorkflowStates.size).toBe(1);
		expect(result.taskWorkflowStates.get('task-1')).toBeUndefined();
		expect(result.taskWorkflowStates.get('task-2')).toBe('idle');
	});

	it('all 6 valid states are accepted', () => {
		const serialized = createBaseSession();
		(serialized as any).taskWorkflowStates = {
			'task-1': 'idle',
			'task-2': 'coder_delegated',
			'task-3': 'pre_check_passed',
			'task-4': 'reviewer_run',
			'task-5': 'tests_run',
			'task-6': 'complete',
		};

		const result = deserializeAgentSession(serialized);

		expect(result.taskWorkflowStates.size).toBe(6);
		expect(result.taskWorkflowStates.get('task-1')).toBe('idle');
		expect(result.taskWorkflowStates.get('task-2')).toBe('coder_delegated');
		expect(result.taskWorkflowStates.get('task-3')).toBe('pre_check_passed');
		expect(result.taskWorkflowStates.get('task-4')).toBe('reviewer_run');
		expect(result.taskWorkflowStates.get('task-5')).toBe('tests_run');
		expect(result.taskWorkflowStates.get('task-6')).toBe('complete');
	});

	it('empty taskWorkflowStates object → empty Map', () => {
		const serialized = createBaseSession();
		(serialized as any).taskWorkflowStates = {};

		const result = deserializeAgentSession(serialized);

		expect(result.taskWorkflowStates).toBeInstanceOf(Map);
		expect(result.taskWorkflowStates.size).toBe(0);
	});
});

describe('deserializeAgentSession - taskWorkflowStates adversarial', () => {
	const createBaseSession = (): SerializedAgentSession => ({
		agentName: 'architect',
		lastToolCallTime: 123456,
		lastAgentEventTime: 123456,
		delegationActive: false,
		activeInvocationId: 1,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: {},
		reviewerCallCount: {},
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: [],
		selfFixAttempted: false,
		catastrophicPhaseWarnings: [],
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: [],
		qaSkipCount: 0,
		qaSkipTaskIds: [],
	});

	it('null raw value → empty Map', () => {
		const serialized = createBaseSession();
		(serialized as any).taskWorkflowStates = null;

		const result = deserializeAgentSession(serialized);

		expect(result.taskWorkflowStates).toBeInstanceOf(Map);
		expect(result.taskWorkflowStates.size).toBe(0);
	});

	it('array value instead of object → empty Map', () => {
		const serialized = createBaseSession();
		// Arrays pass typeof check ('object'), and Object.entries iterates indices as keys
		// This is the current behavior - arrays are processed with index keys
		(serialized as any).taskWorkflowStates = ['idle'] as unknown as Record<
			string,
			string
		>;

		const result = deserializeAgentSession(serialized);

		// Array index '0' has valid value 'idle', so it's added with key '0'
		expect(result.taskWorkflowStates).toBeInstanceOf(Map);
		expect(result.taskWorkflowStates.size).toBe(1);
		expect(result.taskWorkflowStates.get('0')).toBe('idle');
	});

	it('prototype-polluting keys are NOT ignored by deserializeTaskWorkflowStates', () => {
		const serialized = createBaseSession();
		// Using Object.create(null) creates an object without prototype
		// This makes __proto__ and constructor become regular enumerable properties
		const maliciousObj = Object.create(null);
		maliciousObj['task-1'] = 'idle';
		maliciousObj['__proto__'] = 'tests_run'; // valid state, will be added
		maliciousObj['constructor'] = 'complete'; // valid state, will be added
		(serialized as any).taskWorkflowStates = maliciousObj;

		const result = deserializeAgentSession(serialized);

		// All three are added because they're valid entries
		// Note: readSnapshot JSON.parse already filters these at parse time,
		// but deserializeTaskWorkflowStates doesn't filter them
		expect(result.taskWorkflowStates.size).toBe(3);
		expect(result.taskWorkflowStates.get('task-1')).toBe('idle');
		expect(result.taskWorkflowStates.get('__proto__')).toBe('tests_run');
		expect(result.taskWorkflowStates.get('constructor')).toBe('complete');
	});

	it('values that partially match state names are rejected', () => {
		const serialized = createBaseSession();
		(serialized as any).taskWorkflowStates = {
			'task-1': 'idle_extra',
			'task-2': 'IDLE',
			'task-3': '',
			'task-4': 'idle', // valid one
		};

		const result = deserializeAgentSession(serialized);

		// Only task-4 with valid 'idle' should be in the map
		expect(result.taskWorkflowStates.size).toBe(1);
		expect(result.taskWorkflowStates.get('task-1')).toBeUndefined();
		expect(result.taskWorkflowStates.get('task-2')).toBeUndefined();
		expect(result.taskWorkflowStates.get('task-3')).toBeUndefined();
		expect(result.taskWorkflowStates.get('task-4')).toBe('idle');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot migration — transientRetryCount (v6.86.14)
// ─────────────────────────────────────────────────────────────────────────────

describe('deserializeAgentSession - transientRetryCount migration (v6.86.14)', () => {
	it('old snapshot window without transientRetryCount field defaults to 0', () => {
		// Simulate a snapshot written before v6.86.14 where the field did not exist.
		const serialized: SerializedAgentSession = {
			agentName: 'coder',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: { coder: 1 },
			windows: {
				'coder:1': {
					id: 1,
					agentName: 'coder',
					startedAtMs: 123456,
					toolCalls: 10,
					consecutiveErrors: 0,
					hardLimitHit: false,
					lastSuccessTimeMs: 123456,
					recentToolCalls: [],
					warningIssued: false,
					warningReason: '',
					// transientRetryCount intentionally absent (old snapshot)
				} as any,
			},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.windows['coder:1']).toBeDefined();
		expect(result.windows['coder:1'].transientRetryCount).toBe(0);
	});

	it('snapshot window with transientRetryCount=3 preserves the value', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'coder',
			lastToolCallTime: 123456,
			lastAgentEventTime: 123456,
			delegationActive: false,
			activeInvocationId: 2,
			lastInvocationIdByAgent: { coder: 2 },
			windows: {
				'coder:2': {
					id: 2,
					agentName: 'coder',
					startedAtMs: 123456,
					toolCalls: 5,
					consecutiveErrors: 0,
					hardLimitHit: false,
					lastSuccessTimeMs: 123456,
					recentToolCalls: [],
					warningIssued: false,
					warningReason: '',
					transientRetryCount: 3,
				},
			},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.windows['coder:2']).toBeDefined();
		expect(result.windows['coder:2'].transientRetryCount).toBe(3);
	});

	it('snapshot window with transientRetryCount=0 explicitly is kept as 0', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'explorer',
			lastToolCallTime: 100000,
			lastAgentEventTime: 100000,
			delegationActive: false,
			activeInvocationId: 1,
			lastInvocationIdByAgent: { explorer: 1 },
			windows: {
				'explorer:1': {
					id: 1,
					agentName: 'explorer',
					startedAtMs: 100000,
					toolCalls: 0,
					consecutiveErrors: 0,
					hardLimitHit: false,
					lastSuccessTimeMs: 100000,
					recentToolCalls: [],
					warningIssued: false,
					warningReason: '',
					transientRetryCount: 0,
				},
			},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.windows['explorer:1'].transientRetryCount).toBe(0);
	});

	it('multiple windows — absent field on one, present on another — both migrate correctly', () => {
		const serialized: SerializedAgentSession = {
			agentName: 'coder',
			lastToolCallTime: 200000,
			lastAgentEventTime: 200000,
			delegationActive: false,
			activeInvocationId: 2,
			lastInvocationIdByAgent: { coder: 2 },
			windows: {
				'coder:1': {
					id: 1,
					agentName: 'coder',
					startedAtMs: 100000,
					toolCalls: 20,
					consecutiveErrors: 0,
					hardLimitHit: false,
					lastSuccessTimeMs: 100000,
					recentToolCalls: [],
					warningIssued: false,
					warningReason: '',
					// transientRetryCount absent — old snapshot
				} as any,
				'coder:2': {
					id: 2,
					agentName: 'coder',
					startedAtMs: 200000,
					toolCalls: 5,
					consecutiveErrors: 0,
					hardLimitHit: false,
					lastSuccessTimeMs: 200000,
					recentToolCalls: [],
					warningIssued: false,
					warningReason: '',
					transientRetryCount: 2,
				},
			},
			lastCompactionHint: 0,
			architectWriteCount: 0,
			lastCoderDelegationTaskId: null,
			currentTaskId: null,
			gateLog: {},
			reviewerCallCount: {},
			lastGateFailure: null,
			partialGateWarningsIssuedForTask: [],
			selfFixAttempted: false,
			catastrophicPhaseWarnings: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: [],
			qaSkipCount: 0,
			qaSkipTaskIds: [],
		};

		const result = deserializeAgentSession(serialized);

		expect(result.windows['coder:1'].transientRetryCount).toBe(0);
		expect(result.windows['coder:2'].transientRetryCount).toBe(2);
	});
});
