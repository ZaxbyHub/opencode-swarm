/**
 * Run-memory recording is centralized in `plan/manager.updateTaskStatus`.
 *
 * WHY HERE AND NOT IN THE TOOL: the exact-task `update_task_status` terminal
 * transaction/WAL delegates its plan projection to manager.updateTaskStatus.
 * Keeping run-memory recording at that shared lower layer means a recovered WAL
 * commit records the same outcome as the initial attempt. The legacy
 * advanceTaskStateAndPersist wrapper cannot write coder or terminal boundaries.
 *
 * Uses real temp dirs and the real run-memory store; only the git/Epic seams
 * are stubbed so Rule 2 auto-commit stays out of the way.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { _internals, updateTaskStatus } from '../../../src/plan/manager';
import {
	getRunMemorySummary,
	getTaskHistory,
	recordTaskAttempt,
} from '../../../src/services/run-memory';
import {
	advanceTaskStateAndPersist,
	resetSwarmState,
} from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
const realInternals = { ..._internals };

function plan(overrides?: { status?: string; blockedReason?: string }): Plan {
	return {
		schema_version: '1.0.0',
		title: 'rm-plan',
		swarm: 'rm-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: overrides?.status ?? 'in_progress',
						size: 'small',
						description: 'a task',
						depends: [],
						files_touched: ['src/a.ts'],
						blocked_reason: overrides?.blockedReason,
					},
				],
			},
		],
	} as unknown as Plan;
}

function writePlan(p: Plan): void {
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(join(dir, '.swarm', 'plan.json'), JSON.stringify(p, null, 2));
}

beforeEach(() => {
	dir = canonicalMkdtemp('plan-run-memory-');
	writePlan(plan());
	resetSwarmState();
	// Keep Rule 2 auto-commit inert: no git side effects in these tests.
	_internals.isGitRepo = () => false;
	_internals.isEpicModeActiveForProject = () => false;
});

afterEach(async () => {
	Object.assign(_internals, realInternals);
	resetSwarmState();
	await rm(dir, { recursive: true, force: true });
});

describe('updateTaskStatus records terminal outcomes', () => {
	it('records a pass when a task completes', async () => {
		await updateTaskStatus(dir, '1.1', 'completed');

		const history = await getTaskHistory(dir, '1.1');
		expect(history).toHaveLength(1);
		expect(history[0].outcome).toBe('pass');
		expect(history[0].attemptNumber).toBe(1);
		expect(history[0].filesModified).toEqual(['src/a.ts']);
	});

	it('records a fail carrying blocked_reason when a task is blocked', async () => {
		writePlan(plan({ blockedReason: 'upstream contract unresolved' }));

		await updateTaskStatus(dir, '1.1', 'blocked');

		const history = await getTaskHistory(dir, '1.1');
		expect(history).toHaveLength(1);
		expect(history[0].outcome).toBe('fail');
		expect(history[0].failureReason).toBe('upstream contract unresolved');
	});

	it('records a real reason when a task is blocked without blocked_reason', async () => {
		await updateTaskStatus(dir, '1.1', 'blocked');

		const history = await getTaskHistory(dir, '1.1');
		// Never the bare "unknown" that summarizeTask falls back to.
		expect(history[0].failureReason).toContain('marked blocked');
	});

	it('records nothing for non-terminal transitions', async () => {
		await updateTaskStatus(dir, '1.1', 'in_progress');
		await updateTaskStatus(dir, '1.1', 'pending');

		expect(await getTaskHistory(dir, '1.1')).toHaveLength(0);
	});

	it('never fails the status update when run-memory recording throws', async () => {
		_internals.recordTaskAttempt = async () => {
			throw new Error('run memory exploded');
		};

		const updated = await updateTaskStatus(dir, '1.1', 'completed');

		// The durable plan write is authoritative (AGENTS.md #5) and must survive
		// an advisory-bookkeeping failure.
		expect(updated.phases[0].tasks[0].status).toBe('completed');
	});
});

describe('regression: the central terminal projection records its PASS (H1)', () => {
	it('a gate FAIL followed by the terminal projection renders as passed, not "Still failing"', async () => {
		// 1. A gate blocked an earlier completion attempt — recorded by the tool.
		await recordTaskAttempt(dir, {
			taskId: '1.1',
			agent: 'architect',
			outcome: 'fail',
			failureReason: 'council gate: council gate required for task 1.1',
		});

		// 2. The exact-task central transaction reaches its manager projection.
		//    The transaction/WAL integration itself is covered in
		//    update-task-status-terminal-wal-2098.test.ts.
		await updateTaskStatus(dir, '1.1', 'completed');

		const summary = await getRunMemorySummary(dir);
		expect(summary).toContain('Task 1.1: FAILED attempt 1');
		expect(summary).toContain('Passed on attempt 2');
		// The bug this guards: a completed task advertised as still failing.
		expect(summary).not.toContain('Still failing');
	});

	it('legacy advanceTaskStateAndPersist cannot create a terminal pass', async () => {
		const session = {
			id: 'sess-council',
			taskWorkflowStates: new Map([['1.1', 'tests_run']]),
			currentTaskId: '1.1',
		} as unknown as Parameters<typeof advanceTaskStateAndPersist>[0];

		await expect(
			advanceTaskStateAndPersist(session, '1.1', 'complete', dir),
		).rejects.toThrow('TASK_WORKFLOW_CENTRAL_TRANSACTION_REQUIRED');

		const history = await getTaskHistory(dir, '1.1');
		expect(history).toHaveLength(0);
	});
});
