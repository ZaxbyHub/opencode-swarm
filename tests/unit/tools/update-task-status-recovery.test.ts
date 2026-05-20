/**
 * Recovery fallback and diagnostic message tests for update_task_status.
 *
 * Tests Task 1.1: Evidence-file fallback in recoverTaskStateFromDelegations
 * Tests Task 1.2: Structured diagnostic messages in checkReviewerGate
 *
 * Approach: Use real evidence files on disk and direct swarmState manipulation.
 * mock.module is NOT used because the functions under test import swarmState and
 * readTaskEvidenceRaw from modules that are already resolved before any mock
 * could apply. Instead, we test the actual integration by writing real evidence
 * files and manipulating the in-memory swarmState singleton directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	advanceTaskState,
	getTaskState,
	resetSwarmState,
	type startAgentSession,
	swarmState,
} from '../../../src/state';
import type { UpdateTaskStatusArgs } from '../../../src/tools/update-task-status';
import {
	checkReviewerGate,
	executeUpdateTaskStatus,
	recoverTaskStateFromDelegations,
} from '../../../src/tools/update-task-status';

const PLAN_JSON = JSON.stringify({
	schema_version: '1.0.0',
	title: 'Recovery Test Plan',
	swarm: 'recovery-test',
	current_phase: 1,
	migration_status: 'migrated',
	phases: [
		{
			id: 1,
			name: 'Phase 1',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'in_progress',
					size: 'small',
					description: 'Test task',
					depends: [],
					files_touched: [],
				},
			],
		},
	],
});

function evidencePath(tmpDir: string, taskId: string): string {
	return path.join(tmpDir, '.swarm', 'evidence', `${taskId}.json`);
}

function writeEvidence(tmpDir: string, taskId: string, evidence: object): void {
	fs.mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(evidencePath(tmpDir, taskId), JSON.stringify(evidence));
}

// ---------------------------------------------------------------------------
// Task 1.1: recoverTaskStateFromDelegations evidence-file fallback
// ---------------------------------------------------------------------------

describe('recoverTaskStateFromDelegations evidence-file fallback (Task 1.1)', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-')),
		);
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), PLAN_JSON);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// 1. Evidence fallback activates when no delegation chains exist
	// -------------------------------------------------------------------------
	it('evidence fallback activates when delegation chains are empty and session is seeded', () => {
		// Pre-condition: delegation chains empty, agentSessions empty
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);

		// Write evidence file showing both gates passed
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				test_engineer: {
					sessionId: 'sess-2',
					agent: 'test_engineer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
			},
		});

		recoverTaskStateFromDelegations('1.1', tmpDir);

		// Session should have been seeded (agentSessions was empty)
		expect(swarmState.agentSessions.size).toBeGreaterThan(0);

		// State should have been advanced to tests_run in the seeded session
		const seededSession = [...swarmState.agentSessions.values()][0];
		const state = seededSession.taskWorkflowStates.get('1.1');
		expect(state).toBe('tests_run');
	});

	// -------------------------------------------------------------------------
	// 2. Evidence fallback skipped when delegation chains have data
	// -------------------------------------------------------------------------
	it('evidence fallback is skipped when delegation chains already contain reviewer+test_engineer', () => {
		// Pre-populate agentSessions with a session
		const existingSessionId = 'existing-session';
		swarmState.agentSessions.set(existingSessionId, {
			id: existingSessionId,
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);

		// Set up delegation chain with reviewer AND test_engineer
		swarmState.delegationChains.set(existingSessionId, [
			{ from: 'architect', to: 'reviewer', timestamp: Date.now() },
			{ from: 'reviewer', to: 'test_engineer', timestamp: Date.now() },
		]);

		// Write evidence file (should NOT be read because delegation chains already have both gates)
		// We verify this by checking that evidence file's presence doesn't affect outcome
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
			}, // test_engineer missing in evidence
		});

		recoverTaskStateFromDelegations('1.1', tmpDir);

		// State should advance to tests_run via delegation chain (not evidence fallback)
		const session = swarmState.agentSessions.get(existingSessionId)!;
		expect(session.taskWorkflowStates.get('1.1')).toBe('tests_run');
	});

	// -------------------------------------------------------------------------
	// 3. Evidence file missing/corrupt is non-fatal
	// -------------------------------------------------------------------------
	it('evidence file missing or corrupt does not throw — delegation chain result stands', () => {
		const sessionId = 'recovery-session';
		swarmState.agentSessions.set(sessionId, {
			id: sessionId,
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);
		swarmState.delegationChains.set(sessionId, []);

		// Deliberately write corrupt JSON to the evidence file
		fs.mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
		fs.writeFileSync(evidencePath(tmpDir, '1.1'), '{ CORRUPT JSON }');

		expect(() => recoverTaskStateFromDelegations('1.1', tmpDir)).not.toThrow();

		// State should remain idle (delegation chain was empty, evidence was corrupt but non-fatal)
		const session = swarmState.agentSessions.get(sessionId)!;
		expect(session.taskWorkflowStates.get('1.1')).toBe('idle');
	});

	// -------------------------------------------------------------------------
	// 4. No directory provided skips evidence fallback
	// -------------------------------------------------------------------------
	it('calling without directory argument skips evidence file read entirely', () => {
		const sessionId = 'recovery-session';
		swarmState.agentSessions.set(sessionId, {
			id: sessionId,
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);
		swarmState.delegationChains.set(sessionId, []);

		// Write evidence file that would throw if read
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {},
		});

		// Should not throw even though evidence file exists (no directory = no fallback)
		expect(() => recoverTaskStateFromDelegations('1.1')).not.toThrow();

		// State should remain idle (no delegation chain, no evidence fallback)
		const session = swarmState.agentSessions.get(sessionId)!;
		expect(session.taskWorkflowStates.get('1.1')).toBe('idle');
	});

	// -------------------------------------------------------------------------
	// 5. Session seeding skipped when agentSessions already has entries
	// -------------------------------------------------------------------------
	it('session is NOT seeded when agentSessions already contains at least one session', () => {
		// Pre-populate agentSessions
		const preExistingId = 'pre-existing-session';
		swarmState.agentSessions.set(preExistingId, {
			id: preExistingId,
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);
		swarmState.delegationChains.set(preExistingId, []);

		// Write evidence showing both gates passed
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				test_engineer: {
					sessionId: 'sess-2',
					agent: 'test_engineer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
			},
		});

		const sessionsBefore = swarmState.agentSessions.size;

		recoverTaskStateFromDelegations('1.1', tmpDir);

		// No new session should have been created
		expect(swarmState.agentSessions.size).toBe(sessionsBefore);
		expect(swarmState.agentSessions.has('recovery-session')).toBe(false);

		// State should still advance in the pre-existing session
		const session = swarmState.agentSessions.get(preExistingId)!;
		expect(session.taskWorkflowStates.get('1.1')).toBe('tests_run');
	});
});

// ---------------------------------------------------------------------------
// Task 1.2: checkReviewerGate structured diagnostic messages
// ---------------------------------------------------------------------------

describe('recoverTaskStateFromDelegations adversarial edge cases (Task 1.1+)', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'adversarial-recovery-')),
		);
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), PLAN_JSON);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// 1. Evidence file injection: arbitrary keys in gates object
	// -------------------------------------------------------------------------
	it('evidence with arbitrary gates keys (e.g., hacker, root) does not corrupt state', () => {
		// Pre-condition: no sessions, no delegation chains
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);

		// Write evidence with unexpected gate keys — should be ignored
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				test_engineer: {
					sessionId: 'sess-2',
					agent: 'test_engineer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				hacker: {
					sessionId: 'evil',
					agent: 'hacker',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				root: {
					sessionId: 'root',
					agent: 'root',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
			},
		});

		recoverTaskStateFromDelegations('1.1', tmpDir);

		// Session should be seeded and state advanced
		expect(swarmState.agentSessions.size).toBeGreaterThan(0);
		const seededSession = [...swarmState.agentSessions.values()][0];
		const state = seededSession.taskWorkflowStates.get('1.1');
		expect(state).toBe('tests_run');
	});

	// -------------------------------------------------------------------------
	// 2. Evidence file injection: gates.reviewer is "rejected" string
	// The GateEvidenceSchema requires an object with sessionId, timestamp, agent.
	// A string like 'REJECTED' fails Zod validation, so evidence is REJECTED.
	// This is CORRECT behavior — rejected gates should not be accepted.
	// -------------------------------------------------------------------------
	it('evidence with gates.reviewer="REJECTED" (string) fails Zod validation — no session created', () => {
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);

		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: 'REJECTED', // string fails GateEvidenceSchema validation
				test_engineer: {
					sessionId: 'sess-2',
					agent: 'test_engineer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
			},
		});

		recoverTaskStateFromDelegations('1.1', tmpDir);

		// Zod validation fails for gates.reviewer='REJECTED' (string, not object)
		// The error is caught and evidence block is skipped
		// Both hasReviewer and hasTestEngineer remain false
		// Function returns early at line 542 — no session seeded
		expect(swarmState.agentSessions.size).toBe(0);
	});

	// -------------------------------------------------------------------------
	// 3. Evidence file injection: gates is an array instead of object
	// The TaskEvidenceSchema expects gates to be z.record(z.string(), GateEvidenceSchema),
	// which requires an object. An array fails Zod validation.
	// This is CORRECT behavior — malformed evidence should be rejected.
	// -------------------------------------------------------------------------
	it('evidence with gates as array instead of object fails Zod validation — no session created', () => {
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);

		// Write evidence with gates as an array (wrong type)
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: ['reviewer', 'test_engineer'], // array instead of object — fails Zod
		});

		// Should not throw (error is caught inside recoverTaskStateFromDelegations)
		expect(() => recoverTaskStateFromDelegations('1.1', tmpDir)).not.toThrow();

		// Zod validation fails for gates as array (expects object)
		// Error is caught, evidence block skipped
		// No session created — this is CORRECT
		expect(swarmState.agentSessions.size).toBe(0);
	});

	// -------------------------------------------------------------------------
	// 4. Evidence file injection: gates is null
	// -------------------------------------------------------------------------
	it('evidence with gates=null does not crash and returns early', () => {
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);

		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: null, // null instead of object
		});

		expect(() => recoverTaskStateFromDelegations('1.1', tmpDir)).not.toThrow();

		// No session seeded since gates check fails (null.gates is falsy)
		expect(swarmState.agentSessions.size).toBe(0);
	});

	// -------------------------------------------------------------------------
	// 5. Evidence file injection: required_gates is missing (not an array)
	// Bug: when required_gates is missing/undefined, the evidence block at line 531
	// is supposed to be skipped. But evidence.gates[key] != null still triggers
	// hasReviewer/hasTestEngineer to be set (since any truthy value != null).
	// -------------------------------------------------------------------------
	it('evidence without required_gates incorrectly triggers gate detection (bug)', () => {
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);

		// Write evidence with missing required_gates
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			// required_gates intentionally missing
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				test_engineer: {
					sessionId: 'sess-2',
					agent: 'test_engineer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
			},
		});

		recoverTaskStateFromDelegations('1.1', tmpDir);

		// BUG: even though Array.isArray(evidence.required_gates) fails,
		// the evidence.gates['reviewer'] != null check still triggers hasReviewer=true
		// because the gates object is valid and has reviewer entry.
		// This means evidence without required_gates still triggers session seeding.
		//
		// TODO: When the required_gates check is fixed (see F-004), invert this
		// assertion to: expect(swarmState.agentSessions.size).toBe(0)
		// and rename this test from "bug" to "prevents recovery without required_gates".
		expect(swarmState.agentSessions.size).toBeGreaterThan(0);
	});

	// -------------------------------------------------------------------------
	// 6. Session seeding abuse: calling recoverTaskStateFromDelegations 5 times
	// should NOT create 5 recovery sessions
	// -------------------------------------------------------------------------
	it('calling recoverTaskStateFromDelegations 5 times creates only one recovery session (idempotent)', () => {
		// Pre-condition: delegation chains empty
		expect(swarmState.delegationChains.size).toBe(0);

		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				test_engineer: {
					sessionId: 'sess-2',
					agent: 'test_engineer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
			},
		});

		// Call 5 times in a row
		recoverTaskStateFromDelegations('1.1', tmpDir);
		recoverTaskStateFromDelegations('1.1', tmpDir);
		recoverTaskStateFromDelegations('1.1', tmpDir);
		recoverTaskStateFromDelegations('1.1', tmpDir);
		recoverTaskStateFromDelegations('1.1', tmpDir);

		// Only ONE recovery session should exist
		expect(swarmState.agentSessions.size).toBe(1);
		const sessionIds = [...swarmState.agentSessions.keys()];
		expect(sessionIds).toEqual(['recovery-session']);

		// State should be tests_run (advanced on first call, already at tests_run on subsequent)
		const session = swarmState.agentSessions.get('recovery-session')!;
		expect(session.taskWorkflowStates.get('1.1')).toBe('tests_run');
	});

	// -------------------------------------------------------------------------
	// 7. Diagnostic message injection: very long taskId in session data
	// -------------------------------------------------------------------------
	it('checkReviewerGate with very long taskId produces readable diagnostic message', () => {
		// Create a task ID that is very long (1000 chars) but still valid format
		const longTaskId = '1.' + '1'.repeat(997); // still matches N.M or N.M.P format

		swarmState.agentSessions.set('session-1', {
			id: 'session-1',
			taskWorkflowStates: new Map([[longTaskId, 'idle']]),
			currentTaskId: longTaskId,
			sessionRehydratedAt: 0,
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);
		swarmState.delegationChains.set('session-1', []);

		// No evidence file — should block with diagnostic message
		const result = checkReviewerGate(longTaskId, tmpDir);

		expect(result.blocked).toBe(true);
		// The message should be present but not contain the full long taskId repeated
		// The implementation should truncate or handle long taskIds gracefully
		expect(result.reason).toContain('Task ');
		expect(result.reason).toContain('has not passed QA gates');
	});

	// -------------------------------------------------------------------------
	// 8. Diagnostic: empty delegation chain entries
	// -------------------------------------------------------------------------
	it('checkReviewerGate with empty delegation chain entries produces stable diagnostic', () => {
		swarmState.agentSessions.set('session-1', {
			id: 'session-1',
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
			sessionRehydratedAt: 0,
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);

		// Set delegation chain with empty entries
		swarmState.delegationChains.set('session-1', [
			{ from: '', to: '', timestamp: 0 }, // empty entries
		]);

		const result = checkReviewerGate('1.1', tmpDir);

		expect(result.blocked).toBe(true);
		// Should not crash or produce garbled output
		expect(result.reason).toContain('Session states:');
		expect(result.reason).toContain('Delegation chains:');
		// Empty to/from: stripKnownSwarmPrefix('') returns '', so targets = ['']
		// and [''].join(', ') = '' → chainSummary shows [session-1: []]
		expect(result.reason).toContain('[session-1: []]');
	});

	// -------------------------------------------------------------------------
	// 9. Diagnostic: sessionRehydratedAt set to MAX_SAFE_INTEGER
	// -------------------------------------------------------------------------
	it('checkReviewerGate with sessionRehydratedAt=MAX_SAFE_INTEGER does not cause integer overflow', () => {
		swarmState.agentSessions.set('session-1', {
			id: 'session-1',
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
			sessionRehydratedAt: Number.MAX_SAFE_INTEGER, // 9007199254740991
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);
		swarmState.delegationChains.set('session-1', []);

		const result = checkReviewerGate('1.1', tmpDir);

		expect(result.blocked).toBe(true);
		// The rehydrated count should be 1 (sessionRehydratedAt > 0 is true for MAX_SAFE_INTEGER)
		expect(result.reason).toContain('Rehydrated sessions: 1');
	});

	// -------------------------------------------------------------------------
	// 10. Path traversal: directory with ../ sequences in recoverTaskStateFromDelegations
	// -------------------------------------------------------------------------
	it('recoverTaskStateFromDelegations path traversal — documents current behavior', () => {
		// Create adversarial sibling directory with evidence file
		const parentDir = path.dirname(tmpDir);
		const adversarialDir = path.join(parentDir, '.swarm-parent-adversary');
		fs.mkdirSync(path.join(adversarialDir, '.swarm', 'evidence'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(adversarialDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						agent: 'evil',
						sessionId: 'evil',
						timestamp: '2025-01-01T00:00:00.000Z',
					},
				},
			}),
		);

		// Attempt path traversal: tmpDir + '/../.swarm-parent-adversary'
		const traversalPath = path.join(tmpDir, '..', '.swarm-parent-adversary');

		// KNOWN ISSUE: path traversal in directory parameter allows reading evidence from
		// unexpected paths. Caller must validate directory before passing to this function.
		// This test documents the current behavior — a future fix should reject traversal.
		recoverTaskStateFromDelegations('1.1', traversalPath);

		// Document current behavior: the function does NOT reject traversal paths.
		// It reads evidence from the traversed directory and seeds a session.
		// A future fix should reject traversal and make this assertion:
		//   expect(swarmState.agentSessions.size).toBe(0);
		expect(swarmState.agentSessions.size).toBeGreaterThan(0);

		// Cleanup
		fs.rmSync(adversarialDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// 12. Multiple tasks with mixed state in same session
	// -------------------------------------------------------------------------
	it('checkReviewerGate correctly reports state for task with mixed session data', () => {
		swarmState.agentSessions.set('session-1', {
			id: 'session-1',
			taskWorkflowStates: new Map([
				['1.1', 'tests_run'],
				['1.2', 'idle'],
				['1.3', 'complete'],
			]),
			currentTaskId: '1.1',
			sessionRehydratedAt: 0,
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);
		swarmState.delegationChains.set('session-1', []);

		// Task 1.1 is tests_run — should be allowed through
		const result1 = checkReviewerGate('1.1', tmpDir);
		expect(result1.blocked).toBe(false);

		// Task 1.2 is idle — should be blocked
		const result2 = checkReviewerGate('1.2', tmpDir);
		expect(result2.blocked).toBe(true);
		expect(result2.reason).toContain('Session states:');
	});
});

describe('checkReviewerGate structured diagnostic messages (Task 1.2)', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-diag-test-')),
		);
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), PLAN_JSON);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// 6. Blocked message includes all diagnostic fields
	// -------------------------------------------------------------------------
	it('blocked message contains Session states, Delegation chains, Evidence, and Rehydrated sessions', () => {
		// Set up a session with state not in tests_run/complete
		// Use evidence file with reviewer gate but MISSING test_engineer.
		// This sets evidenceIncompleteReason (so we don't early-return) but does NOT
		// set hasTestEngineer from evidence (so bypass doesn't trigger).
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				// test_engineer MISSING — creates evidenceIncompleteReason
			},
		});

		swarmState.agentSessions.set('session-1', {
			id: 'session-1',
			taskWorkflowStates: new Map([['1.1', 'reviewer_run']]),
			currentTaskId: '1.1',
			sessionRehydratedAt: 1000, // rehydrated
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);

		// Delegation chain for session-1: contains reviewer but NOT test_engineer
		// This sets hasReviewer=true from delegation chains but hasTestEngineer=false
		// so the bypass doesn't trigger (hasReviewer && hasTestEngineer = false)
		swarmState.delegationChains.set('session-1', [
			{ from: 'architect', to: 'reviewer', timestamp: Date.now() },
			// NO test_engineer in this chain
		]);

		const result = checkReviewerGate('1.1', tmpDir);

		expect(result.blocked).toBe(true);
		// All four diagnostic fields must be present
		expect(result.reason).toContain('Session states:');
		expect(result.reason).toContain('Delegation chains:');
		expect(result.reason).toContain('Evidence:');
		expect(result.reason).toContain('Rehydrated sessions:');
		// Should mention the missing test_engineer in evidence
		expect(result.reason).toContain('test_engineer');
		// Rehydrated count should be 1 (only session-1 has sessionRehydratedAt > 0)
		expect(result.reason).toContain('Rehydrated sessions: 1');
	});

	// -------------------------------------------------------------------------
	// 7. Blocked message with evidenceIncompleteReason present includes all fields
	// -------------------------------------------------------------------------
	it('blocked message with evidenceIncompleteReason still includes full structured diagnostics', () => {
		// Set up a session with incomplete gate state
		swarmState.agentSessions.set('session-1', {
			id: 'session-1',
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
			sessionRehydratedAt: 0,
		} as ReturnType<typeof startAgentSession> extends infer T ? T : never);
		swarmState.delegationChains.set('session-1', []);

		// Create an evidence file that shows incomplete gates (test_engineer missing)
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				// test_engineer is missing — this creates evidenceIncompleteReason
			},
		});

		const result = checkReviewerGate('1.1', tmpDir);

		expect(result.blocked).toBe(true);
		// Even with evidenceIncompleteReason, all structured fields must be present
		expect(result.reason).toContain('Session states:');
		expect(result.reason).toContain('Delegation chains:');
		expect(result.reason).toContain('Evidence:');
		expect(result.reason).toContain('Rehydrated sessions:');
		// The evidenceIncompleteReason should be embedded in the Evidence: field
		expect(result.reason).toContain('Evidence: [');
		// Should mention the missing gate
		expect(result.reason).toContain('test_engineer');
	});
});

// ---------------------------------------------------------------------------
// Task 1.4: Evidence-only crash recovery (SC-001)
// Verifies full end-to-end crash recovery when swarmState is completely empty
// but evidence files on disk prove QA completion.
// ---------------------------------------------------------------------------

describe('evidence-only crash recovery (Task 1.4, SC-001)', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'crash-recovery-1-4-')),
		);
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), PLAN_JSON);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// 1. Evidence-only gate pass: complete evidence → gate passes WITHOUT sessions
	// -------------------------------------------------------------------------
	it('evidence-only recovery: gate passes from evidence files without calling recoverTaskStateFromDelegations', () => {
		// Pre-condition: completely empty swarmState — no sessions, no chains
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);

		// Write a complete evidence file with both reviewer-APPROVED and
		// test_engineer-PASS entries using the full evidence schema
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'reviewer-sess-crash',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				test_engineer: {
					sessionId: 'te-sess-crash',
					agent: 'test_engineer',
					timestamp: '2025-01-01T00:01:00.000Z',
				},
			},
		});

		// CRITICAL: do NOT call recoverTaskStateFromDelegations first.
		// This test proves the evidence-only gate path works when swarmState
		// has no sessions at all (simulating a crash between delegations).
		expect(swarmState.agentSessions.size).toBe(0);

		// The gate must pass purely from reading evidence files on disk
		const gateResult = checkReviewerGate('1.1', tmpDir);
		expect(gateResult.blocked).toBe(false);

		// Sessions must still be empty — gate passed from evidence alone
		expect(swarmState.agentSessions.size).toBe(0);

		// Now verify recoverTaskStateFromDelegations also works: it should
		// seed sessions from the same evidence file
		recoverTaskStateFromDelegations('1.1', tmpDir);
		expect(swarmState.agentSessions.size).toBeGreaterThan(0);

		const seededSession = [...swarmState.agentSessions.values()][0];
		const state = seededSession.taskWorkflowStates.get('1.1');
		expect(state).toBe('tests_run');
	});

	// -------------------------------------------------------------------------
	// 2. Crash recovery with incomplete evidence → gate blocks with diagnostic
	// -------------------------------------------------------------------------
	it('task state partially advances but reviewer gate blocks when evidence is incomplete', () => {
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);

		// Write evidence with only reviewer (missing test_engineer)
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'reviewer-sess-crash',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				// test_engineer missing — incomplete QA
			},
		});

		recoverTaskStateFromDelegations('1.1', tmpDir);

		// Session should be seeded (hasReviewer is set)
		expect(swarmState.agentSessions.size).toBeGreaterThan(0);

		// State should be advanced but NOT to tests_run (test_engineer missing)
		const seededSession = [...swarmState.agentSessions.values()][0];
		const state = seededSession.taskWorkflowStates.get('1.1');
		expect(state).not.toBe('idle');
		expect(state).not.toBe('tests_run');

		// Gate should block because QA is incomplete
		const gateResult = checkReviewerGate('1.1', tmpDir);
		expect(gateResult.blocked).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// SC-001: Full crash-recovery integration test
// After a simulated crash (empty in-memory state), write evidence files proving
// reviewer and test_engineer both ran, then call update_task_status('completed')
// — it should succeed by recovering state from evidence files.
// ---------------------------------------------------------------------------

describe('SC-001: crash-recovery integration', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'sc001-crash-recovery-')),
		);
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), PLAN_JSON);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('advances task to completed after crash with only evidence files', async () => {
		// Step 1: Pre-condition — simulate a crash: no sessions, no delegation chains
		expect(swarmState.delegationChains.size).toBe(0);
		expect(swarmState.agentSessions.size).toBe(0);

		// Step 2: Write evidence files proving both reviewer and test_engineer ran
		writeEvidence(tmpDir, '1.1', {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'reviewer-sess-crash',
					agent: 'reviewer',
					timestamp: '2025-01-01T00:00:00.000Z',
				},
				test_engineer: {
					sessionId: 'te-sess-crash',
					agent: 'test_engineer',
					timestamp: '2025-01-01T00:01:00.000Z',
				},
			},
		});

		// Step 3: Call update_task_status('completed') — should recover from evidence
		const args: UpdateTaskStatusArgs = {
			task_id: '1.1',
			status: 'completed',
			working_directory: tmpDir,
		};

		const result = await executeUpdateTaskStatus(args, tmpDir);

		// Step 4: Assert result.success === true
		expect(result.success).toBe(true);

		// Step 5: Assert recovery actually occurred from evidence files — sessions were rehydrated
		expect(swarmState.agentSessions.size).toBeGreaterThan(0);

		// Step 6: Assert task status in plan is 'completed'
		const planPath = path.join(tmpDir, '.swarm', 'plan.json');
		const planContent = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
		const task = planContent.phases[0].tasks.find(
			(t: { id: string }) => t.id === '1.1',
		);
		expect(task.status).toBe('completed');
	});
});
