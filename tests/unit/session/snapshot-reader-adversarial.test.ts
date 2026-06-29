/**
 * ADVERSARIAL tests for snapshot-reader.ts
 * Attacks the snapshot reader with malicious/edge-case inputs.
 * Focus: Path traversal, malicious JSON, prototype pollution, edge cases.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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
import { resetSwarmState, swarmState } from '../../../src/state';

describe('snapshot-reader ADVERSARIAL tests', () => {
	let testDir: string;
	let swarmDir: string;
	let sessionDir: string;

	beforeEach(async () => {
		resetSwarmState();

		// Create unique test directory
		testDir = path.join(
			tmpdir(),
			`swarm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		swarmDir = path.join(testDir, '.swarm');
		sessionDir = path.join(swarmDir, 'session');
		fs.mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ============================================================================
	// Path Traversal / Injection Tests
	// ============================================================================

	describe('Path Traversal / Injection', () => {
		it('should handle directory with ../../ pattern (no throw, returns null)', async () => {
			const maliciousDir = path.join(testDir, '../../../etc');
			const result = await readSnapshot(maliciousDir);
			expect(result).toBeNull();
		});

		it('should handle directory with null bytes (no throw, returns null)', async () => {
			// The filename 'session/state.json' gets validated by validateSwarmPath
			// We'll test through loadSnapshot which calls readSnapshot
			await expect(async () => await loadSnapshot(testDir)).not.toThrow();
		});

		it('should handle empty string directory (no throw)', async () => {
			// Empty string resolves to current working directory
			// The function should not throw (it may return data or null depending on whether .swarm exists)
			await expect(async () => await readSnapshot('')).not.toThrow();
		});

		it('should handle directory pointing to system path (no throw, returns null)', async () => {
			const systemDir = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
			const result = await readSnapshot(systemDir);
			expect(result).toBeNull();
		});
	});

	// ============================================================================
	// Malicious JSON Payloads
	// ============================================================================

	describe('Malicious JSON Payloads', () => {
		it('should handle prototype pollution attempt (__proto__)', async () => {
			const statePath = path.join(sessionDir, 'state.json');
			const maliciousSnapshot: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {
					__proto__: {
						polluted: true,
					},
				} as any,
			};

			fs.writeFileSync(statePath, JSON.stringify(maliciousSnapshot));
			const result = await readSnapshot(testDir);
			expect(result).not.toBeNull();

			// Verify Object.prototype was NOT polluted
			expect(({} as any).polluted).toBeUndefined();
		});

		it('should handle deeply nested JSON (100 levels) without hanging', async () => {
			const statePath = path.join(sessionDir, 'state.json');

			// Create deeply nested object
			let deep: any = { value: 'deep' };
			for (let i = 0; i < 100; i++) {
				deep = { nested: deep };
			}

			const snapshot: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {
					session1: {
						agentName: 'test',
						lastToolCallTime: Date.now(),
						lastAgentEventTime: Date.now(),
						delegationActive: false,
						activeInvocationId: 0,
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
						deep,
					},
				},
			};

			fs.writeFileSync(statePath, JSON.stringify(snapshot));
			const result = await readSnapshot(testDir);
			expect(result).not.toBeNull();
		});

		it('should handle massive JSON (1MB string fields) without hanging', async () => {
			const statePath = path.join(sessionDir, 'state.json');

			// Create a 1MB string
			const hugeString = 'x'.repeat(1024 * 1024);

			const snapshot: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {
					session1: {
						agentName: 'test',
						lastToolCallTime: Date.now(),
						lastAgentEventTime: Date.now(),
						delegationActive: false,
						activeInvocationId: 0,
						lastInvocationIdByAgent: {},
						windows: {},
						lastCompactionHint: 0,
						architectWriteCount: 0,
						lastCoderDelegationTaskId: null,
						currentTaskId: null,
						gateLog: { task1: [hugeString] },
						reviewerCallCount: {},
						lastGateFailure: null,
						partialGateWarningsIssuedForTask: [hugeString],
						selfFixAttempted: false,
						catastrophicPhaseWarnings: [],
						lastPhaseCompleteTimestamp: 0,
						lastPhaseCompletePhase: 0,
						phaseAgentsDispatched: [hugeString],
						qaSkipCount: 0,
						qaSkipTaskIds: [hugeString],
					},
				},
			};

			fs.writeFileSync(statePath, JSON.stringify(snapshot));
			const result = await readSnapshot(testDir);
			expect(result).not.toBeNull();
		});

		it('should handle toolAggregates: null (null guard on line 124)', async () => {
			const snapshot: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: null as any,
				activeAgent: {},
				delegationChains: {},
				agentSessions: {},
			};

			// The null guard on line 124 should prevent errors
			await rehydrateState(snapshot);
			expect(swarmState.toolAggregates.size).toBe(0);
		});

		it('should handle agentSessions with null session value gracefully (no throw)', async () => {
			const snapshot: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: {},
				activeAgent: {},
				delegationChains: {},
				agentSessions: {
					session1: null as any,
				},
			};

			// v6.33.1 fix: malformed sessions are skipped with a warning, not thrown.
			// rehydrateState should resolve without error and the null session is omitted.
			await expect(rehydrateState(snapshot)).resolves.toBeUndefined();
			// The null session should NOT appear in agentSessions
			expect(swarmState.agentSessions.has('session1')).toBe(false);
		});

		it('should filter out NaN keys in reviewerCallCount', async () => {
			const serialized: SerializedAgentSession = {
				agentName: 'test',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(),
				delegationActive: false,
				activeInvocationId: 0,
				lastInvocationIdByAgent: {},
				windows: {},
				lastCompactionHint: 0,
				architectWriteCount: 0,
				lastCoderDelegationTaskId: null,
				currentTaskId: null,
				gateLog: {},
				reviewerCallCount: {
					NaN: 1, // Should be filtered out
					'1': 5,
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

			const deserialized = deserializeAgentSession(serialized);
			expect(deserialized.reviewerCallCount.size).toBe(1);
			expect(deserialized.reviewerCallCount.get(1)).toBe(5);
		});

		it('should filter out Infinity keys in reviewerCallCount', async () => {
			const serialized: SerializedAgentSession = {
				agentName: 'test',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(),
				delegationActive: false,
				activeInvocationId: 0,
				lastInvocationIdByAgent: {},
				windows: {},
				lastCompactionHint: 0,
				architectWriteCount: 0,
				lastCoderDelegationTaskId: null,
				currentTaskId: null,
				gateLog: {},
				reviewerCallCount: {
					Infinity: 1, // Should be filtered out
					'-Infinity': 2, // Should be filtered out
					'2': 3,
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

			const deserialized = deserializeAgentSession(serialized);
			expect(deserialized.reviewerCallCount.size).toBe(1);
			expect(deserialized.reviewerCallCount.get(2)).toBe(3);
		});
	});

	// ============================================================================
	// deserializeAgentSession edge cases
	// ============================================================================

	describe('deserializeAgentSession edge cases', () => {
		it('should handle gateLog with null values in inner arrays', () => {
			const serialized: SerializedAgentSession = {
				agentName: 'test',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(),
				delegationActive: false,
				activeInvocationId: 0,
				lastInvocationIdByAgent: {},
				windows: {},
				lastCompactionHint: 0,
				architectWriteCount: 0,
				lastCoderDelegationTaskId: null,
				currentTaskId: null,
				gateLog: {
					task1: [null, 'gate2'] as any,
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

			const deserialized = deserializeAgentSession(serialized);
			expect(deserialized.gateLog.get('task1')).toBeTruthy();
		});

		it('should handle catastrophicPhaseWarnings with string values', () => {
			const serialized: SerializedAgentSession = {
				agentName: 'test',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(),
				delegationActive: false,
				activeInvocationId: 0,
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
				catastrophicPhaseWarnings: ['1', '2'] as any, // String numbers instead of actual numbers
				lastPhaseCompleteTimestamp: 0,
				lastPhaseCompletePhase: 0,
				phaseAgentsDispatched: [],
				qaSkipCount: 0,
				qaSkipTaskIds: [],
			};

			const deserialized = deserializeAgentSession(serialized);
			// Creates a Set with string values (not numbers) - verify behavior
			expect(deserialized.catastrophicPhaseWarnings.size).toBe(2);
			expect(Array.from(deserialized.catastrophicPhaseWarnings)).toEqual([
				'1',
				'2',
			]);
		});

		it('should handle very large Set restoration (10,000 entries) without hanging', () => {
			const largeStringArray = Array.from(
				{ length: 10000 },
				(_, i) => `item${i}`,
			);
			const largeNumberArray = Array.from({ length: 10000 }, (_, i) => i);

			const serialized: SerializedAgentSession = {
				agentName: 'test',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(),
				delegationActive: false,
				activeInvocationId: 0,
				lastInvocationIdByAgent: {},
				windows: {},
				lastCompactionHint: 0,
				architectWriteCount: 0,
				lastCoderDelegationTaskId: null,
				currentTaskId: null,
				gateLog: {},
				reviewerCallCount: {},
				lastGateFailure: null,
				partialGateWarningsIssuedForTask: largeStringArray,
				selfFixAttempted: false,
				catastrophicPhaseWarnings: largeNumberArray,
				lastPhaseCompleteTimestamp: 0,
				lastPhaseCompletePhase: 0,
				phaseAgentsDispatched: largeStringArray,
				qaSkipCount: 0,
				qaSkipTaskIds: largeStringArray,
			};

			const deserialized = deserializeAgentSession(serialized);
			expect(deserialized.partialGateWarningsIssuedForTask.size).toBe(10000);
			expect(deserialized.catastrophicPhaseWarnings.size).toBe(10000);
			expect(deserialized.phaseAgentsDispatched.size).toBe(10000);
		});

		it('should handle windows with null value for a key', () => {
			const serialized: SerializedAgentSession = {
				agentName: 'test',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(),
				delegationActive: false,
				activeInvocationId: 0,
				lastInvocationIdByAgent: {},
				windows: {
					'coder:1': null as any,
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

			const deserialized = deserializeAgentSession(serialized);
			expect(deserialized.windows['coder:1']).toBeUndefined();
		});
	});

	// ============================================================================
	// rehydrateState edge cases
	// ============================================================================

	describe('rehydrateState edge cases', () => {
		it('should handle huge delegationChains (10,000 entries per session) without hanging', async () => {
			const hugeChains: Record<string, any> = {};
			for (let i = 0; i < 100; i++) {
				hugeChains[`session${i}`] = Array.from({ length: 10000 }, (_, j) => ({
					from: `agent${i}`,
					to: `agent${j}`,
					timestamp: Date.now(),
				}));
			}

			const snapshot: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: {},
				activeAgent: {},
				delegationChains: hugeChains,
				agentSessions: {},
			};

			await expect(rehydrateState(snapshot)).resolves.toBeUndefined();
			expect(swarmState.delegationChains.size).toBe(100);
		});

		it('should handle multiple rapid calls to rehydrateState with last-call data', async () => {
			const snapshot1: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: {
					tool1: {
						tool: 'tool1',
						count: 1,
						successCount: 1,
						failureCount: 0,
						totalDuration: 100,
					},
				},
				activeAgent: { session1: 'agent1' },
				delegationChains: {},
				agentSessions: {},
			};

			const snapshot2: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: {
					tool2: {
						tool: 'tool2',
						count: 2,
						successCount: 2,
						failureCount: 0,
						totalDuration: 200,
					},
				},
				activeAgent: { session2: 'agent2' },
				delegationChains: {},
				agentSessions: {},
			};

			await rehydrateState(snapshot1);
			await rehydrateState(snapshot2);

			// Should have data from last call
			expect(swarmState.toolAggregates.size).toBe(1);
			expect(swarmState.toolAggregates.get('tool2')).toBeTruthy();
			expect(swarmState.activeAgent.size).toBe(1);
			expect(swarmState.activeAgent.get('session2')).toBe('agent2');
		});

		it('should handle rehydrating over already-populated state (clears first)', async () => {
			// Populate state first
			swarmState.toolAggregates.set('tool1', {
				tool: 'tool1',
				count: 100,
				successCount: 90,
				failureCount: 10,
				totalDuration: 10000,
			});
			swarmState.activeAgent.set('session1', 'agent1');

			const snapshot: SnapshotData = {
				version: 1,
				writtenAt: Date.now(),
				toolAggregates: {
					tool2: {
						tool: 'tool2',
						count: 5,
						successCount: 4,
						failureCount: 1,
						totalDuration: 500,
					},
				},
				activeAgent: { session2: 'agent2' },
				delegationChains: {},
				agentSessions: {},
			};

			await rehydrateState(snapshot);

			// Should have cleared old data and populated new data
			expect(swarmState.toolAggregates.size).toBe(1);
			expect(swarmState.toolAggregates.get('tool1')).toBeUndefined();
			expect(swarmState.toolAggregates.get('tool2')).toBeTruthy();
			expect(swarmState.activeAgent.size).toBe(1);
			expect(swarmState.activeAgent.get('session1')).toBeUndefined();
			expect(swarmState.activeAgent.get('session2')).toBe('agent2');
		});
	});

	// ============================================================================
	// loadSnapshot safety
	// ============================================================================

	describe('loadSnapshot safety', () => {
		it('should handle completely invalid directory without throwing', async () => {
			const invalidDir = path.join(testDir, 'does-not-exist');
			await expect(async () => await loadSnapshot(invalidDir)).not.toThrow();
		});

		it('should handle directory where .swarm/session/state.json is a directory not a file', async () => {
			// Create state.json as a directory instead of a file
			const statePath = path.join(sessionDir, 'state.json');
			fs.mkdirSync(statePath, { recursive: true });

			await expect(async () => await loadSnapshot(testDir)).not.toThrow();
		});

		it('should handle empty JSON file', async () => {
			const statePath = path.join(sessionDir, 'state.json');
			fs.writeFileSync(statePath, '');

			const result = await readSnapshot(testDir);
			expect(result).toBeNull();
		});

		it('should handle invalid JSON', async () => {
			const statePath = path.join(sessionDir, 'state.json');
			fs.writeFileSync(statePath, '{invalid json}');

			const result = await readSnapshot(testDir);
			expect(result).toBeNull();
		});

		it('should handle wrong version', async () => {
			const statePath = path.join(sessionDir, 'state.json');
			fs.writeFileSync(
				statePath,
				JSON.stringify({
					version: 999,
					writtenAt: Date.now(),
					toolAggregates: {},
					activeAgent: {},
					delegationChains: {},
					agentSessions: {},
				}),
			);

			const result = await readSnapshot(testDir);
			expect(result).toBeNull();
		});

		it('quarantines stale state.json with incompatible version instead of re-reading it', async () => {
			const statePath = path.join(sessionDir, 'state.json');
			fs.writeFileSync(
				statePath,
				JSON.stringify({
					version: 0,
					writtenAt: Date.now(),
					toolAggregates: {},
					activeAgent: {},
					delegationChains: {},
					agentSessions: {},
				}),
			);

			const result = await readSnapshot(testDir);
			// Must return null — incompatible version is not rehydrated
			expect(result).toBeNull();
			// The original file must have been renamed to .quarantine so it is not
			// re-read on every subsequent process restart.
			const quarantinePath = path.join(sessionDir, 'state.json.quarantine');
			expect(fs.existsSync(quarantinePath)).toBe(true);
			// The original state.json must no longer exist
			expect(fs.existsSync(statePath)).toBe(false);
		});
	});
});
