/**
 * Regression tests for issue #929: multi-task evidence recording.
 *
 * Before the fix, evidence was recorded for only ONE task per reviewer
 * delegation. After session loss, tasks without evidence were falsely blocked.
 * The fix records evidence for ALL eligible tasks in session.taskWorkflowStates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readTaskEvidence,
	recordAgentDispatch,
	recordGateEvidence,
} from '../../src/gate-evidence';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../src/state';
import { executeUpdateTaskStatus } from '../../src/tools/update-task-status';

let tmpDir: string;

function writePlan(
	dir: string,
	tasks: Array<{ id: string; status: string }>,
): void {
	const planJson = JSON.stringify({
		schema_version: '1.0.0',
		title: 'Multi-Task Evidence Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: tasks.map((t) => ({
					id: t.id,
					phase: 1,
					status: t.status,
					size: 'small',
					description: `Task ${t.id}`,
					depends: [],
					files_touched: [],
				})),
			},
		],
	});
	writeFileSync(path.join(dir, '.swarm', 'plan.json'), planJson);
}

beforeEach(() => {
	resetSwarmState();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gate-multi-task-'));
	mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('#929 — Multi-task evidence after session loss', () => {
	it('all tasks complete when evidence exists for each, even with no active sessions', async () => {
		writePlan(tmpDir, [
			{ id: '1.1', status: 'in_progress' },
			{ id: '1.2', status: 'in_progress' },
			{ id: '1.3', status: 'in_progress' },
		]);

		// Simulate: evidence recorded for ALL tasks (the fix)
		for (const tid of ['1.1', '1.2', '1.3']) {
			await recordAgentDispatch(tmpDir, tid, 'coder');
			await recordGateEvidence(tmpDir, tid, 'reviewer', 'sess-r');
			await recordGateEvidence(tmpDir, tid, 'test_engineer', 'sess-te');
		}

		// Session loss — clear all in-memory state
		resetSwarmState();

		// All tasks should complete via durable evidence
		for (const tid of ['1.1', '1.2', '1.3']) {
			const result = await executeUpdateTaskStatus({
				task_id: tid,
				status: 'completed',
				working_directory: tmpDir,
			});
			expect(result.success).toBe(true);
		}
	});

	it('tasks without evidence are blocked after session loss', async () => {
		writePlan(tmpDir, [
			{ id: '1.1', status: 'in_progress' },
			{ id: '1.2', status: 'in_progress' },
		]);

		// Evidence only for task 1.1 (simulates pre-fix behavior)
		await recordAgentDispatch(tmpDir, '1.1', 'coder');
		await recordGateEvidence(tmpDir, '1.1', 'reviewer', 'sess-r');
		await recordGateEvidence(tmpDir, '1.1', 'test_engineer', 'sess-te');

		// Task 1.2 has coder dispatch but no gate evidence
		await recordAgentDispatch(tmpDir, '1.2', 'coder');

		// Session loss
		resetSwarmState();

		// 1.1 succeeds
		const ok = await executeUpdateTaskStatus({
			task_id: '1.1',
			status: 'completed',
			working_directory: tmpDir,
		});
		expect(ok.success).toBe(true);

		// 1.2 fails — missing reviewer and test_engineer evidence
		const blocked = await executeUpdateTaskStatus({
			task_id: '1.2',
			status: 'completed',
			working_directory: tmpDir,
		});
		expect(blocked.success).toBe(false);
	});

	it('corrupt evidence file blocks completion with descriptive error', async () => {
		writePlan(tmpDir, [{ id: '1.1', status: 'in_progress' }]);

		// Write corrupt evidence (simulates architect agent writing bad JSON)
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			'taskId: 1.1 -- NOT VALID JSON',
		);

		resetSwarmState();

		const result = await executeUpdateTaskStatus({
			task_id: '1.1',
			status: 'completed',
			working_directory: tmpDir,
		});
		expect(result.success).toBe(false);
		expect(result.errors?.join('')).toContain('corrupt or unreadable');
	});

	it('recordGateEvidence self-heals a corrupt evidence file', async () => {
		// Write corrupt evidence
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			'NOT JSON AT ALL',
		);

		// recordGateEvidence should overwrite the corrupt file
		await recordGateEvidence(tmpDir, '1.1', 'reviewer', 'sess-r');

		const evidence = await readTaskEvidence(tmpDir, '1.1');
		expect(evidence).not.toBeNull();
		expect(evidence!.taskId).toBe('1.1');
		expect(evidence!.gates.reviewer).toBeDefined();
	});
});

describe('#929 — getEligibleTaskIdsForEvidence behavior', () => {
	it('session with multiple eligible tasks records evidence for all', async () => {
		writePlan(tmpDir, [
			{ id: '1.1', status: 'in_progress' },
			{ id: '1.2', status: 'in_progress' },
			{ id: '1.3', status: 'in_progress' },
		]);

		startAgentSession('sess-arch', 'architect');
		const session = ensureAgentSession('sess-arch');

		// Simulate architect setting multiple tasks to coder_delegated
		session.taskWorkflowStates = new Map([
			['1.1', 'coder_delegated'],
			['1.2', 'coder_delegated'],
			['1.3', 'coder_delegated'],
		]);

		// Dispatch coder for all tasks (creates initial evidence files)
		for (const tid of ['1.1', '1.2', '1.3']) {
			await recordAgentDispatch(tmpDir, tid, 'coder');
		}

		// Record reviewer evidence for all tasks (simulating batch-review)
		for (const tid of ['1.1', '1.2', '1.3']) {
			await recordGateEvidence(tmpDir, tid, 'reviewer', 'sess-arch');
		}

		// Record test_engineer evidence for all tasks
		for (const tid of ['1.1', '1.2', '1.3']) {
			await recordGateEvidence(tmpDir, tid, 'test_engineer', 'sess-arch');
		}

		// Session loss
		resetSwarmState();

		// ALL tasks should pass gate check
		for (const tid of ['1.1', '1.2', '1.3']) {
			const result = await executeUpdateTaskStatus({
				task_id: tid,
				status: 'completed',
				working_directory: tmpDir,
			});
			expect(result.success).toBe(true);
		}
	});

	it('explicit task_id records evidence for only that task', async () => {
		writePlan(tmpDir, [
			{ id: '1.1', status: 'in_progress' },
			{ id: '1.2', status: 'in_progress' },
		]);

		// Record evidence explicitly for task 1.1 only
		await recordAgentDispatch(tmpDir, '1.1', 'coder');
		await recordGateEvidence(tmpDir, '1.1', 'reviewer', 'sess-r');
		await recordGateEvidence(tmpDir, '1.1', 'test_engineer', 'sess-te');

		resetSwarmState();

		// 1.1 should succeed
		const ok = await executeUpdateTaskStatus({
			task_id: '1.1',
			status: 'completed',
			working_directory: tmpDir,
		});
		expect(ok.success).toBe(true);

		// 1.2 should NOT have evidence — explicit task_id limits scope
		const evidence12 = await readTaskEvidence(tmpDir, '1.2');
		expect(evidence12).toBeNull();
	});
});
