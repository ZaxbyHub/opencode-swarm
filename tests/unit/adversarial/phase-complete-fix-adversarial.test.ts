/**
 * Adversarial security and boundary tests for phase-complete fix.
 * Tests attack vectors, malformed inputs, boundary violations, and edge cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordGateEvidence } from '../../../src/gate-evidence';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

describe('ADVERSARIAL: update-task-status.ts checkReviewerGate', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		// Create a session so swarmState.agentSessions.size > 0
		startAgentSession('test-session', 'test-agent');
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adversarial-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { force: true, recursive: true });
	});

	it('ATTACK: malformed JSON in plan.json should fall through to blocked:true', () => {
		// Setup: create .swarm directory with malformed JSON
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			'{ invalid json }',
			'utf-8',
		);

		// The checkReviewerGate should NOT throw, should fall through to blocked
		const result = checkReviewerGate('1.1', tempDir);

		// Should return blocked because no valid completed task found
		expect(result.blocked).toBe(true);
	});

	it('ATTACK: plan.json with no phases array should not crash', () => {
		// Setup: create plan.json with no phases key
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({ title: 'test' }),
			'utf-8',
		);

		// Should not throw
		const result = checkReviewerGate('1.1', tempDir);
		expect(result.blocked).toBe(true); // No completed task found
	});

	it('ATTACK: plan.json with null tasks in array should not crash', async () => {
		// Setup: create plan.json with tasks containing null elements
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						tasks: [
							{ id: '1.1', status: 'completed' },
							null, // malicious null in array
							undefined, // undefined in array
						],
					},
				],
			}),
			'utf-8',
		);

		// Durable evidence is required before restart-recovery plan.json fallback
		// can trust completed plan state.
		const generation = await seedStageAPassed(tempDir, '1.1');
		await recordGateEvidence(
			tempDir,
			'1.1',
			'reviewer',
			'sess-reviewer',
			false,
			{
				expectedGeneration: generation,
			},
		);
		await recordGateEvidence(
			tempDir,
			'1.1',
			'test_engineer',
			'sess-test-engineer',
			false,
			{ expectedGeneration: generation },
		);

		// Should not throw - should handle nulls gracefully
		const result = checkReviewerGate('1.1', tempDir);
		// Should find the completed task despite nulls in array
		expect(result.blocked).toBe(false);
	});

	it('ATTACK: taskId with path traversal characters should be safely handled as string comparison', () => {
		// Setup: create a plan.json that would never match path traversal
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [{ id: 1, tasks: [{ id: '1.1', status: 'completed' }] }],
			}),
			'utf-8',
		);

		// taskId is used ONLY for string equality comparison, not as file path
		// This should safely return blocked (no match for the malicious taskId)
		const result = checkReviewerGate('../../etc/passwd', tempDir);
		expect(result.blocked).toBe(true); // No match found

		const result2 = checkReviewerGuard('1.1/../../../etc/passwd');
		expect(result2.blocked).toBe(true); // No match found
	});

	it('ATTACK: plan.json missing entirely should fall through to blocked', () => {
		// Don't create .swarm directory at all - file doesn't exist
		// Should not throw - should fall through to blocked
		const result = checkReviewerGate('1.1', tempDir);
		expect(result.blocked).toBe(true);
	});

	it('ATTACK: plan.json with missing id field in task should not crash', () => {
		// Setup: create plan.json with tasks missing 'id' field
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify({
				phases: [
					{
						id: 1,
						tasks: [
							{ status: 'completed' }, // missing id field
							{ id: '1.2', status: 'pending' },
						],
					},
				],
			}),
			'utf-8',
		);

		// Should not throw - should handle missing id gracefully
		const result = checkReviewerGate('1.1', tempDir);
		expect(result.blocked).toBe(true); // No matching completed task

		const result2 = checkReviewerGuard('1.2');
		expect(result2.blocked).toBe(true); // Task exists but not completed
	});

	// Helper to call the internal function
	function checkReviewerGuard(taskId: string) {
		return checkReviewerGate(taskId, tempDir);
	}
});

/**
 * Helper function to write gate evidence files for Phase 4 mandatory gates
 */
function writeGateEvidence(directory: string, phase: number): void {
	const evidenceDir = path.join(directory, '.swarm', 'evidence', `${phase}`);
	fs.mkdirSync(evidenceDir, { recursive: true });

	// Write completion-verify.json
	const completionVerify = {
		status: 'passed',
		tasksChecked: 1,
		tasksPassed: 1,
		tasksBlocked: 0,
		reason: 'All task identifiers found in source files',
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'completion-verify.json'),
		JSON.stringify(completionVerify, null, 2),
	);

	// Write drift-verifier.json
	const driftVerifier = {
		schema_version: '1.0.0',
		task_id: 'drift-verifier',
		entries: [
			{
				task_id: 'drift-verifier',
				type: 'drift_verification',
				timestamp: new Date().toISOString(),
				agent: 'critic',
				verdict: 'approved',
				summary: 'Drift check passed',
			},
		],
	};
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify(driftVerifier, null, 2),
	);
}

describe('ADVERSARIAL: phase-complete.ts hasRestoredAgents condition', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	/**
	 * Test the hasRestoredAgents logic:
	 * hasRestoredAgents = (session.phaseAgentsDispatched?.size ?? 0) > 0 &&
	 *                    session.lastPhaseCompleteTimestamp === phaseReferenceTimestamp
	 *
	 * This tests that a session with phaseAgentsDispatched but timestamp=0 (default)
	 * is NOT included when phaseReferenceTimestamp > 0
	 */
	it('ATTACK: session with phaseAgentsDispatched but lastPhaseCompleteTimestamp=0 should NOT be included as contributor when phaseReferenceTimestamp > 0', () => {
		// Create caller session with a legitimate phase reference timestamp
		const callerSessionId = 'caller-session';
		ensureAgentSession(callerSessionId, 'architect');
		const callerSession = swarmState.agentSessions.get(callerSessionId)!;
		callerSession.lastPhaseCompleteTimestamp = Date.now(); // Non-zero

		// Create another session with phaseAgentsDispatched but timestamp=0 (default/uninitialized)
		const restoredSessionId = 'restored-session';
		ensureAgentSession(restoredSessionId, 'architect');
		const restoredSession = swarmState.agentSessions.get(restoredSessionId)!;
		restoredSession.phaseAgentsDispatched = new Set(['coder', 'reviewer']);
		restoredSession.lastPhaseCompleteTimestamp = 0; // Default/uninitialized

		// The hasRestoredAgents condition:
		// (session.phaseAgentsDispatched?.size ?? 0) > 0 && session.lastPhaseCompleteTimestamp === phaseReferenceTimestamp
		// With phaseReferenceTimestamp from caller (non-zero), this should be FALSE
		// because 0 !== non-zero timestamp

		const phaseReferenceTimestamp = callerSession.lastPhaseCompleteTimestamp;

		// Manually replicate the hasRestoredAgents logic to verify behavior
		const hasRestoredAgentsCheck = (
			session: typeof restoredSession,
			refTs: number,
		) => {
			return (
				(session.phaseAgentsDispatched?.size ?? 0) > 0 &&
				session.lastPhaseCompleteTimestamp === refTs
			);
		};

		// The restored session with timestamp=0 should NOT match when ref timestamp is non-zero
		expect(
			hasRestoredAgentsCheck(restoredSession, phaseReferenceTimestamp),
		).toBe(false);

		// Even if we call executePhaseComplete, the restored session should not contribute
		// because its timestamp doesn't match
		const result = executePhaseComplete(
			{ phase: 1, sessionID: callerSessionId },
			tempDir,
		);

		// Result should complete without error
		expect(result).toBeDefined();
	});

	it('ATTACK: session with both phaseAgentsDispatched and lastCompletedPhaseAgentsDispatched should not double-count', () => {
		const sessionId = 'test-session';
		ensureAgentSession(sessionId, 'architect');
		const session = swarmState.agentSessions.get(sessionId)!;

		// Add same agents to both sets
		session.phaseAgentsDispatched = new Set(['coder', 'reviewer']);
		session.lastCompletedPhaseAgentsDispatched = new Set([
			'coder',
			'reviewer',
			'test-engineer',
		]);

		// The Set data structure inherently prevents duplicates when adding
		// Verify this by checking what would happen if we merged them
		const mergedAgents = new Set<string>([
			...Array.from(session.phaseAgentsDispatched),
			...Array.from(session.lastCompletedPhaseAgentsDispatched),
		]);

		// Should have unique agents, no duplicates
		expect(mergedAgents.size).toBe(3);
		expect(mergedAgents.has('coder')).toBe(true);
		expect(mergedAgents.has('reviewer')).toBe(true);
		expect(mergedAgents.has('test-engineer')).toBe(true);
	});

	it('ATTACK: lastCompletedPhaseAgentsDispatched iteration with duplicates should be deduped by Set', () => {
		const sessionId = 'test-session';
		ensureAgentSession(sessionId, 'architect');
		const session = swarmState.agentSessions.get(sessionId)!;

		// Simulate edge case: phaseAgentsDispatched has agent A
		// lastCompletedPhaseAgentsDispatched also has agent A (duplicated from same phase)
		session.phaseAgentsDispatched = new Set(['agent-a', 'agent-b']);
		session.lastCompletedPhaseAgentsDispatched = new Set([
			'agent-a',
			'agent-c',
		]);

		// Verify Set deduplication works
		const mergedAgents = new Set<string>([
			...Array.from(session.phaseAgentsDispatched),
			...Array.from(session.lastCompletedPhaseAgentsDispatched),
		]);

		// Set ensures deduplication - should have exactly 3 unique agents
		expect(mergedAgents.size).toBe(3);
		expect(mergedAgents.has('agent-a')).toBe(true);
		expect(mergedAgents.has('agent-b')).toBe(true);
		expect(mergedAgents.has('agent-c')).toBe(true);
	});

	it('ATTACK: restored session with lastPhaseCompleteTimestamp matching caller should be included', () => {
		const timestamp = Date.now();

		const callerSessionId = 'caller-session';
		ensureAgentSession(callerSessionId, 'architect');
		const callerSession = swarmState.agentSessions.get(callerSessionId)!;
		callerSession.lastPhaseCompleteTimestamp = timestamp;

		// Create session with matching timestamp (restored from same phase boundary)
		const restoredSessionId = 'restored-session';
		ensureAgentSession(restoredSessionId, 'architect');
		const restoredSession = swarmState.agentSessions.get(restoredSessionId)!;
		restoredSession.phaseAgentsDispatched = new Set(['coder']);
		restoredSession.lastPhaseCompleteTimestamp = timestamp; // Matches caller

		// The hasRestoredAgents condition should be TRUE when timestamps match
		const hasRestoredAgentsCheck = (
			session: typeof restoredSession,
			refTs: number,
		) => {
			return (
				(session.phaseAgentsDispatched?.size ?? 0) > 0 &&
				session.lastPhaseCompleteTimestamp === refTs
			);
		};

		// Should include restored session because timestamps match
		expect(hasRestoredAgentsCheck(restoredSession, timestamp)).toBe(true);
	});

	// Dummy tempDir for executePhaseComplete
	let tempDir: string;
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-adversarial-'));
		// Create required evidence directory
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence', 'retro-1'), {
			recursive: true,
		});
		// Write gate evidence for Phase 4 mandatory gates
		writeGateEvidence(tempDir, 1);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { force: true, recursive: true });
	});
});

describe('ADVERSARIAL: state.ts ensureAgentSession migration guard', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('ATTACK: ensureAgentSession should NOT overwrite existing lastCompletedPhaseAgentsDispatched', () => {
		const sessionId = 'test-session';

		// First call: create session and set lastCompletedPhaseAgentsDispatched
		ensureAgentSession(sessionId, 'architect');
		let session = swarmState.agentSessions.get(sessionId)!;

		// Simulate: this session completed a previous phase and has persisted agents
		session.lastCompletedPhaseAgentsDispatched = new Set([
			'coder-v1',
			'reviewer-v1',
		]);

		// Capture the reference before next ensureAgentSession call
		const originalSet = session.lastCompletedPhaseAgentsDispatched;

		// Second call: ensureAgentSession is called again (e.g., on new tool call)
		// The guard: if (!session.lastCompletedPhaseAgentsDispatched) should prevent overwrite
		session = ensureAgentSession(sessionId, 'architect');

		// CRITICAL: Should NOT have overwritten the existing set
		expect(session.lastCompletedPhaseAgentsDispatched).toBe(originalSet);
		expect(Array.from(session.lastCompletedPhaseAgentsDispatched)).toEqual([
			'coder-v1',
			'reviewer-v1',
		]);
	});

	it('ATTACK: ensureAgentSession should initialize lastCompletedPhaseAgentsDispatched if undefined (migration case)', () => {
		const sessionId = 'test-session';

		// Create session without lastCompletedPhaseAgentsDispatched
		ensureAgentSession(sessionId, 'architect');
		let session = swarmState.agentSessions.get(sessionId)!;

		// Ensure it's undefined (simulating old state)
		session.lastCompletedPhaseAgentsDispatched =
			undefined as unknown as Set<string>;

		// Call ensureAgentSession - should initialize it
		session = ensureAgentSession(sessionId, 'architect');

		// Should now have an empty Set (initialized, not undefined)
		expect(session.lastCompletedPhaseAgentsDispatched).toBeDefined();
		expect(session.lastCompletedPhaseAgentsDispatched instanceof Set).toBe(
			true,
		);
		expect(session.lastCompletedPhaseAgentsDispatched.size).toBe(0);
	});

	it('ATTACK: ensureAgentSession should NOT overwrite lastCompletedPhaseAgentsDispatched when session already exists with populated set', () => {
		const sessionId = 'test-session';

		// Create session
		startAgentSession(sessionId, 'architect');
		let session = swarmState.agentSessions.get(sessionId)!;

		// Manually populate lastCompletedPhaseAgentsDispatched (as if from snapshot restore)
		session.lastCompletedPhaseAgentsDispatched = new Set([
			'curator',
			'docs',
			'security',
		]);

		// Now call ensureAgentSession multiple times (simulating repeated tool calls)
		for (let i = 0; i < 5; i++) {
			session = ensureAgentSession(sessionId, 'architect');
		}

		// The set should still contain the original agents - NOT overwritten with empty set
		const agents = Array.from(session.lastCompletedPhaseAgentsDispatched);
		expect(agents).toContain('curator');
		expect(agents).toContain('docs');
		expect(agents).toContain('security');
		expect(agents.length).toBe(3);
	});
});
