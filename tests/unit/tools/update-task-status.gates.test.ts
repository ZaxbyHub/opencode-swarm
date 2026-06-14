/**
 * Gate restart-recovery tests for update_task_status.
 *
 * Verifies that the evidence-first gate check (Layer 1) survives session
 * restarts by reading durable .swarm/evidence/<taskId>.json files, so that
 * tasks with all required gates recorded in a previous session can still be
 * marked completed after process restart.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	recordAgentDispatch,
	recordGateEvidence,
} from '../../../src/gate-evidence';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	checkReviewerGate,
	executeUpdateTaskStatus,
} from '../../../src/tools/update-task-status';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLAN_JSON = JSON.stringify({
	schema_version: '1.0.0',
	title: 'Gate Test Plan',
	swarm: 'gate-test',
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
				{
					id: '1.2',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'Another test task',
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Gate restart-recovery: evidence-file durability', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-restart-test-')),
		);
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), PLAN_JSON);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// Core restart-recovery scenario
	// -----------------------------------------------------------------------

	it('gate check passes after session restart when both reviewer and test_engineer gates are recorded', async () => {
		// Record both required gates to the evidence file (durable on disk)
		await recordGateEvidence(tmpDir, '1.1', 'reviewer', 'sess-reviewer');
		await recordGateEvidence(tmpDir, '1.1', 'test_engineer', 'sess-te');

		// Simulate session restart — clears all in-memory state
		resetSwarmState();

		// Gate check must pass via evidence-first path (no session state available)
		const result = checkReviewerGate('1.1', tmpDir);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('');
	});

	// -----------------------------------------------------------------------
	// Partial gates — evidence file is authoritative when it exists.
	// To have BOTH required gates, we must first create a seed evidence file
	// (via in_progress) which sets required_gates: ['reviewer', 'test_engineer'].
	// Then recording only one gate still leaves the other missing → BLOCKED.
	// -----------------------------------------------------------------------

	it('gate check blocks when seed evidence exists but only reviewer gate recorded (test_engineer missing)', async () => {
		// Seed evidence starts empty; coder dispatch establishes the code-task requirements.
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);
		await recordAgentDispatch(tmpDir, '1.1', 'coder');
		// Record only reviewer — test_engineer is still absent from gates
		await recordGateEvidence(tmpDir, '1.1', 'reviewer', 'sess-reviewer');
		resetSwarmState();
		// Establish minimal session so gate bypass doesn't trigger
		swarmState.agentSessions.set('test-session', {
			id: 'test-session',
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
		});

		const result = checkReviewerGate('1.1', tmpDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('test_engineer');
		expect(result.reason).toContain('1.1');
	});

	it('gate check blocks when seed evidence exists but only test_engineer gate recorded (reviewer missing)', async () => {
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);
		await recordAgentDispatch(tmpDir, '1.1', 'coder');
		// Record only test_engineer — reviewer is still absent from gates
		await recordGateEvidence(tmpDir, '1.1', 'test_engineer', 'sess-te');
		resetSwarmState();
		// Establish minimal session so gate bypass doesn't trigger
		swarmState.agentSessions.set('test-session', {
			id: 'test-session',
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
		});

		const result = checkReviewerGate('1.1', tmpDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('reviewer');
	});

	// -----------------------------------------------------------------------
	// No evidence file, no sessions — intentional allow-through for test contexts.
	// The gate code explicitly returns blocked:false when agentSessions is empty,
	// so that test suites don't need to spin up full session state for every test.
	// -----------------------------------------------------------------------

	it('gate check allows through when no evidence file exists and no sessions are active (test-context bypass)', () => {
		resetSwarmState();

		// No evidence file, no active sessions → allow-through (documented test-context behavior)
		const result = checkReviewerGate('1.1', tmpDir);
		expect(result.blocked).toBe(false);
	});

	it('gate check blocks when plan.json says completed but durable gate evidence is absent', () => {
		const completedPlan = JSON.parse(PLAN_JSON);
		completedPlan.phases[0].tasks[0].status = 'completed';
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(completedPlan),
		);
		resetSwarmState();
		swarmState.agentSessions.set('test-session', {
			id: 'test-session',
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
		});

		const result = checkReviewerGate('1.1', tmpDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('has not passed QA gates');
		expect(result.reason).toContain('1.1');
	});

	it('gate check blocks when evidence has no required gates', () => {
		fs.mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
		fs.writeFileSync(
			evidencePath(tmpDir, '1.1'),
			JSON.stringify({ taskId: '1.1', required_gates: [], gates: {} }),
		);
		resetSwarmState();

		const result = checkReviewerGate('1.1', tmpDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('no required gates');
	});

	it('executeUpdateTaskStatus does not recover completion from unscoped delegation chains', async () => {
		await recordAgentDispatch(tmpDir, '1.1', 'coder');
		resetSwarmState();
		swarmState.agentSessions.set('test-session', {
			id: 'test-session',
			taskWorkflowStates: new Map([['1.1', 'idle']]),
		});
		swarmState.delegationChains.set('test-session', [
			{ from: 'architect', to: 'reviewer', timestamp: Date.now() - 1000 },
			{
				from: 'reviewer',
				to: 'test_engineer',
				timestamp: Date.now() - 500,
			},
		]);

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			tmpDir,
		);
		expect(result.success).toBe(false);
		expect(result.errors?.join('\n')).toContain('has not passed QA gates');
	});

	// -----------------------------------------------------------------------
	// Seed evidence file created on in_progress transition
	// -----------------------------------------------------------------------

	it('executeUpdateTaskStatus creates seed evidence file on in_progress transition', async () => {
		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);
		expect(result.success).toBe(true);

		const evidenceExists = fs.existsSync(evidencePath(tmpDir, '1.1'));
		expect(evidenceExists).toBe(true);

		const evidence = JSON.parse(
			fs.readFileSync(evidencePath(tmpDir, '1.1'), 'utf-8'),
		);
		expect(evidence.taskId).toBe('1.1');
		expect(Array.isArray(evidence.required_gates)).toBe(true);
		expect(evidence.required_gates).toEqual([]);
	});

	it('seed evidence file has empty gates object (no gates recorded yet)', async () => {
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);

		const evidence = JSON.parse(
			fs.readFileSync(evidencePath(tmpDir, '1.1'), 'utf-8'),
		);
		// gates object exists but is empty — gates not yet recorded
		expect(typeof evidence.gates).toBe('object');
		expect(Object.keys(evidence.gates)).toHaveLength(0);
	});

	it('seed write is skipped when evidence file already exists', async () => {
		// Write a custom evidence file first
		const customEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					agent: 'reviewer',
					timestamp: '2024-01-01T00:00:00Z',
					sessionId: 'sess-r',
				},
			},
		};
		fs.mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
		fs.writeFileSync(
			evidencePath(tmpDir, '1.1'),
			JSON.stringify(customEvidence, null, 2),
		);

		// in_progress should NOT overwrite the existing file
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);

		const evidence = JSON.parse(
			fs.readFileSync(evidencePath(tmpDir, '1.1'), 'utf-8'),
		);
		// reviewer gate should still be present (not overwritten)
		expect(evidence.gates?.reviewer).toBeDefined();
	});

	// -----------------------------------------------------------------------
	// Full restart-recovery round-trip
	// -----------------------------------------------------------------------

	it('full round-trip: in_progress → gates recorded → restart → gate passes', async () => {
		// Step 1: Mark task in_progress (creates seed evidence file)
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);

		// Step 2: Record required gates (as reviewer and test_engineer agents would)
		await recordGateEvidence(tmpDir, '1.1', 'reviewer', 'sess-reviewer');
		await recordGateEvidence(tmpDir, '1.1', 'test_engineer', 'sess-te');

		// Step 3: Simulate session restart — all in-memory state is lost
		resetSwarmState();

		// Step 4: Gate check must pass via evidence file alone
		const result = checkReviewerGate('1.1', tmpDir);
		expect(result.blocked).toBe(false);
	});

	it('gate check remains blocked after restart when gates were never recorded', async () => {
		// Mark in_progress (seed file created, but gates empty)
		await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'in_progress' },
			tmpDir,
		);

		// Restart without recording any gates
		resetSwarmState();
		// Establish minimal session so gate bypass doesn't trigger
		swarmState.agentSessions.set('test-session', {
			id: 'test-session',
			taskWorkflowStates: new Map([['1.1', 'idle']]),
			currentTaskId: '1.1',
		});

		// Evidence file exists but gates are empty → blocked
		const result = checkReviewerGate('1.1', tmpDir);
		expect(result.blocked).toBe(true);
	});
});
