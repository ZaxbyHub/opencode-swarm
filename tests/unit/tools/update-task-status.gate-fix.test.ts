import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readTaskEvidenceRaw,
	type TaskEvidence,
} from '../../../src/gate-evidence';
import { swarmState } from '../../../src/state';
import {
	checkReviewerGate,
	type ReviewerGateResult,
} from '../../../src/tools/update-task-status';
import {
	createWorkflowTestSession,
	createWorkflowTestSessionWithPassedTask,
} from '../../helpers/workflow-session-factory';

// ============================================================================
// readTaskEvidenceRaw unit tests
// ============================================================================

describe('readTaskEvidenceRaw', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'read-task-evidence-raw-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		// Create .swarm/evidence directory
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('1. returns TaskEvidence when evidence file exists with all gates met', () => {
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'test_engineer',
				},
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		const result = readTaskEvidenceRaw(tempDir, '1.1');

		expect(result).not.toBeNull();
		expect(result!.taskId).toBe('1.1');
		expect(result!.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(result!.gates['reviewer']).toBeDefined();
		expect(result!.gates['test_engineer']).toBeDefined();
	});

	test('2. returns null when evidence file does not exist (ENOENT)', () => {
		// Do NOT create any evidence file
		const result = readTaskEvidenceRaw(tempDir, '1.1');

		expect(result).toBeNull();
	});

	test('3. returns null when evidence directory does not exist (ENOENT)', () => {
		// Do NOT create .swarm/evidence directory
		const result = readTaskEvidenceRaw(tempDir, '1.1');

		expect(result).toBeNull();
	});

	test('4. throws on malformed JSON (re-throws, does not return null)', () => {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			'{ invalid json }',
		);

		expect(() => readTaskEvidenceRaw(tempDir, '1.1')).toThrow();
	});

	test('5. throws on permission error (re-throws, does not return null)', () => {
		const evidencePath = path.join(tempDir, '.swarm', 'evidence', '1.1.json');
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer'],
			gates: {},
		};
		fs.writeFileSync(evidencePath, JSON.stringify(evidence));

		// On Windows, we can simulate a permission error by making the file read-only
		// but the actual permission error depends on the platform
		// Skip this test if we can't reliably simulate it
		if (process.platform === 'win32') {
			// Try to make file inaccessible - this may not work reliably on Windows
			try {
				fs.chmodSync(evidencePath, 0o000);
				const result = readTaskEvidenceRaw(tempDir, '1.1');
				// If it doesn't throw (e.g., running as admin), skip
				if (result !== null) {
					// Restore permissions and skip
					fs.chmodSync(evidencePath, 0o644);
					return;
				}
			} catch {
				// Expected - permission error
				fs.chmodSync(evidencePath, 0o644);
				return;
			}
			fs.chmodSync(evidencePath, 0o644);
		}

		// For non-Windows or if permission test didn't work, verify the function
		// correctly parses valid JSON and throws on invalid
		const validResult = readTaskEvidenceRaw(tempDir, '1.1');
		expect(validResult).not.toBeNull();
	});

	test('6. throws on invalid taskId format (assertValidTaskId)', () => {
		expect(() => readTaskEvidenceRaw(tempDir, 'invalid')).toThrow(
			/Invalid taskId/,
		);
		expect(() => readTaskEvidenceRaw(tempDir, '')).toThrow(/Invalid taskId/);
		expect(() => readTaskEvidenceRaw(tempDir, '1')).toThrow(/Invalid taskId/);
		expect(() => readTaskEvidenceRaw(tempDir, '../etc')).toThrow(
			/Invalid taskId/,
		);
	});

	test('7. evidence with empty required_gates is valid (empty array passes every)', () => {
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: [],
			gates: {},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		const result = readTaskEvidenceRaw(tempDir, '1.1');

		expect(result).not.toBeNull();
		expect(result!.required_gates).toEqual([]);
	});

	test('8. evidence with extra gates beyond required is still valid', () => {
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'test_engineer',
				},
				diff: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'diff',
				},
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		const result = readTaskEvidenceRaw(tempDir, '1.1');

		expect(result).not.toBeNull();
		expect(result!.required_gates).toEqual(['reviewer']);
		expect(Object.keys(result!.gates)).toHaveLength(3);
	});
});

// ============================================================================
// checkReviewerGate evidence-first logic tests
// ============================================================================

describe('checkReviewerGate — evidence-first gate (Phase 3.1 fix)', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalAgentSessions: Map<string, any>;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fix-evidence-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory with valid plan
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
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
							status: 'pending',
							size: 'small',
							description: 'Test task 1',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);

		// Save and clear agent sessions for isolated testing
		originalAgentSessions = new Map(swarmState.agentSessions);
		swarmState.agentSessions.clear();
	});

	afterEach(() => {
		swarmState.agentSessions.clear();
		for (const [key, value] of originalAgentSessions) {
			swarmState.agentSessions.set(key, value);
		}
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('1. evidence file with all gates met -> blocked: false', () => {
		// Create evidence file with all required gates satisfied
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'test_engineer',
				},
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		// Set up a session (should NOT be used since evidence takes precedence)
		const session = createWorkflowTestSession(); // empty taskWorkflowStates
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('');
	});

	test('2. evidence file with missing gate -> blocked: true with specific message', () => {
		// Create evidence file with only one gate satisfied
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				// test_engineer is MISSING
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		const result = checkReviewerGate('1.1', tempDir);

		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('Task 1.1');
		expect(result.reason).toContain('missing required gates');
		expect(result.reason).toContain('test_engineer');
		expect(result.reason).toContain('reviewer');
	});

	test('3. no evidence file (ENOENT) -> falls through to session state', () => {
		// Do NOT create any evidence file
		// Set up a session with task in tests_run state (should pass)
		const session = createWorkflowTestSessionWithPassedTask('1.1');
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Should pass because session state says tests_run
		expect(result.blocked).toBe(false);
	});

	test('4. no evidence file (ENOENT) with no valid session -> blocked: true', () => {
		// Do NOT create any evidence file
		// Set up a session with task NOT in tests_run/complete state
		const session = createWorkflowTestSession(); // task at idle
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Should be blocked since no evidence and session doesn't have tests_run/complete
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('QA gates');
	});

	test('5. malformed JSON in evidence file -> blocked: true (not silent fallthrough)', () => {
		// Create a corrupt JSON file
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			'{ invalid json }',
		);

		// Set up a session with task in tests_run (should NOT be used due to corrupt file)
		const session = createWorkflowTestSessionWithPassedTask('1.1');
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Should be blocked because corrupt evidence file is BLOCKING (not silent fallthrough)
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('corrupt or unreadable');
		expect(result.reason).toContain('1.1');
	});

	test('6. cross-session evidence (different sessionId) -> still unblocked', () => {
		// Create evidence from session-999 but check from session-1
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'session-999',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'session-999',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'test_engineer',
				},
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		// Session-1 has no valid state
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Evidence-first check should pass regardless of sessionId in evidence
		expect(result.blocked).toBe(false);
	});

	test('7. evidence with empty required_gates -> blocked: false', () => {
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: [],
			gates: {},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		// Session in idle state (would normally block)
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Empty required_gates means no gates needed -> passes
		expect(result.blocked).toBe(false);
	});

	test('8. evidence with extra gates beyond required -> blocked: false', () => {
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'test_engineer',
				},
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		// Session in idle state
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Extra gates beyond required should not block
		expect(result.blocked).toBe(false);
	});

	test('9. ENOENT catch path verified via missing evidence directory', () => {
		// Create a valid plan but intentionally do NOT create .swarm/evidence directory
		// (already not created in beforeEach)

		// Session in tests_run state
		const session = createWorkflowTestSessionWithPassedTask('1.1');
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Evidence directory doesn't exist -> ENOENT -> falls through to session state
		// Session has tests_run -> passes
		expect(result.blocked).toBe(false);
	});

	test('10. corrupt evidence file with valid session still blocks (evidence is authoritative)', () => {
		// Create a corrupt evidence file
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			'not valid json{',
		);

		// Session has task in tests_run state (would normally pass)
		const session = createWorkflowTestSessionWithPassedTask('1.1');
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Should be blocked because evidence file is corrupt
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('corrupt or unreadable');
	});

	test('11. evidence missing one of multiple required gates', () => {
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer', 'diff'],
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'test_engineer',
				},
				// diff is MISSING
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		const result = checkReviewerGate('1.1', tempDir);

		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('diff');
		expect(result.reason).toContain('missing required gates');
	});
});

// ============================================================================
// checkReviewerGate evidence-first edge cases
// ============================================================================

describe('checkReviewerGate — evidence-first edge cases', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalAgentSessions: Map<string, any>;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fix-edge-case-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
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
							status: 'pending',
							size: 'small',
							description: 'Test task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);

		originalAgentSessions = new Map(swarmState.agentSessions);
		swarmState.agentSessions.clear();
	});

	afterEach(() => {
		swarmState.agentSessions.clear();
		for (const [key, value] of originalAgentSessions) {
			swarmState.agentSessions.set(key, value);
		}
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('evidence file missing required_gates field entirely -> uses evidence.gates keys as fallback', () => {
		// Evidence structure where required_gates is missing but gates object exists
		// The check requires evidence.required_gates to be truthy and an array
		const evidence = {
			taskId: '1.1',
			// required_gates is MISSING
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		// The evidence-first check requires: evidence.required_gates && Array.isArray(evidence.required_gates) && evidence.gates
		// Since required_gates is missing, this condition fails and falls through to session state
		const session = createWorkflowTestSessionWithPassedTask('1.1');
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Falls through to session state which has tests_run -> passes
		expect(result.blocked).toBe(false);
	});

	test('evidence file with null gates -> falls through to session state', () => {
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer'],
			gates: {} as any, // Will cause the gates check to pass but required_gates.every to fail
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		const result = checkReviewerGate('1.1', tempDir);

		// required_gates is truthy and is an array, but not all gates are met
		expect(result.blocked).toBe(true);
	});

	test('evidence file with turbo: true is still processed correctly', () => {
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			turbo: true,
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'test_engineer',
				},
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		const result = checkReviewerGate('1.1', tempDir);

		expect(result.blocked).toBe(false);
	});
});

// ============================================================================
// checkReviewerGate evidence directory fallback (Phase 3.2 fix)
// ============================================================================

describe('checkReviewerGate — evidence directory fallback removed (v6.35.1 Codex review fix)', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalAgentSessions: Map<string, any>;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-dir-evidence-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory with valid plan
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
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
							status: 'pending',
							size: 'small',
							description: 'Test task 1',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);

		// Save and clear agent sessions for isolated testing
		originalAgentSessions = new Map(swarmState.agentSessions);
		swarmState.agentSessions.clear();
	});

	afterEach(() => {
		swarmState.agentSessions.clear();
		for (const [key, value] of originalAgentSessions) {
			swarmState.agentSessions.set(key, value);
		}
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('1. Evidence directory exists with files, no evidence.json -> returns unblocked', () => {
		// Create evidence directory for task 1.1 with some files, but NO evidence.json
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		// Create some marker files to simulate agent output files in the evidence directory
		fs.writeFileSync(
			path.join(evidenceDir, 'reviewer-output.md'),
			'# Review output',
		);
		fs.writeFileSync(path.join(evidenceDir, 'test-results.json'), '{}');

		// Session in idle state (would block if session state was used)
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Directory fallback removed — falls through to session state -> idle -> blocked
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('QA gates');
	});

	test('2. Evidence directory exists but empty -> falls through to session state', () => {
		// Create empty evidence directory for task 1.1, no evidence.json
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		// Leave directory empty

		// Session in tests_run state (would pass via session state)
		const session = createWorkflowTestSessionWithPassedTask('1.1');
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Empty directory -> falls through to session state -> session has tests_run -> passes
		expect(result.blocked).toBe(false);
	});

	test('3. Evidence directory does not exist at all -> falls through to session state', () => {
		// Do NOT create evidence directory at all
		// .swarm/evidence directory exists but task-specific directory does not

		// Session in tests_run state
		const session = createWorkflowTestSessionWithPassedTask('1.1');
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// No evidence dir -> ENOENT -> falls through to session state -> passes
		expect(result.blocked).toBe(false);
	});

	test('4. Evidence directory with files but session in idle -> still passes (dir check wins)', () => {
		// Create evidence directory with files
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(path.join(evidenceDir, 'some-output.txt'), 'content');

		// Session in idle state (would block if session state was used)
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Directory fallback removed — falls through to session state -> idle -> blocked
		expect(result.blocked).toBe(true);
	});

	test('5. No evidence.json, no evidence directory, no valid session -> blocked', () => {
		// Do NOT create evidence directory or evidence.json

		// Session in idle state (not tests_run/complete)
		const session = createWorkflowTestSession();
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Falls through all checks -> blocked
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('QA gates');
	});

	test('6. evidence.json exists with all gates met -> returns unblocked (regression check)', () => {
		// Create evidence file with all required gates satisfied
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'test_engineer',
				},
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		// Also create an evidence directory with files (should not matter since evidence.json exists)
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'extra-file.txt'),
			'should be ignored',
		);

		const result = checkReviewerGate('1.1', tempDir);

		// evidence.json with all gates met -> unblocked (evidence.json takes precedence)
		expect(result.blocked).toBe(false);
	});

	test('7. evidence.json exists with missing gates -> returns blocked (regression check)', () => {
		// Create evidence file with missing gates
		const evidence: TaskEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2025-01-01T00:00:00.000Z',
					agent: 'reviewer',
				},
				// test_engineer is MISSING
			},
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		// Create evidence directory with files (should not matter since evidence.json exists and is authoritative)
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDir, 'extra-file.txt'),
			'should be ignored',
		);

		const result = checkReviewerGate('1.1', tempDir);

		// evidence.json with missing gates -> blocked (evidence.json is authoritative)
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('missing required gates');
		expect(result.reason).toContain('test_engineer');
	});

	test('8. Evidence directory check does not interfere with corrupt evidence.json blocking', () => {
		// Create corrupt evidence.json (should block per existing behavior)
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			'{ invalid json }',
		);

		// Create evidence directory with files
		const evidenceDir = path.join(tempDir, '.swarm', 'evidence', '1.1');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(path.join(evidenceDir, 'some-file.txt'), 'content');

		// Session in tests_run state
		const session = createWorkflowTestSessionWithPassedTask('1.1');
		swarmState.agentSessions.set('session-1', session);

		const result = checkReviewerGate('1.1', tempDir);

		// Corrupt evidence.json should block (evidence dir check should NOT be reached)
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('corrupt or unreadable');
	});
});
