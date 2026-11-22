/**
 * r14 audit repair (P1-5): the context map only becomes 'approved' after the
 * FULL business release of the task — the authoritative task status AND all
 * required QA gates. A single successful child ingestion (reviewer or
 * test-engineer completion, coder settlement) writes the NON-FINAL 'pending'
 * summary; the authoritative promotion happens at update_task_status
 * (promoteContextMapTaskRelease). A positive reviewer can never overwrite an
 * already-negative result, and no intermediate ordering ever yields
 * 'approved'.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import type { Plan } from '../../../src/config/plan-schema';
import {
	loadContextMap,
	saveContextMap,
} from '../../../src/context-map/persistence';
import {
	promoteContextMapTaskRelease,
	resolveContextMapTaskReleaseStatus,
	updateContextMapAfterAgent,
} from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

const PARENT = 'ses_r14p5_parent';

function writePlan(directory: string, taskStatus = 'pending'): void {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'P5 Context Map Release Plan',
		swarm: 'p5-release',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: taskStatus as Plan['phases'][0]['tasks'][0]['status'],
						size: 'small',
						description: 'Do the work',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	} as Plan;
	fs.mkdirSync(join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	fs.writeFileSync(
		join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ context_map: { enabled: true } }),
	);
}

function completionEvent(childSessionId: string, body: string) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: PARENT,
					text: `<task id="${childSessionId}" state="completed">\n${body}\n</task>`,
				},
			},
		},
	};
}

async function seedTaskGates(
	directory: string,
	taskId: string,
	gates: Array<{
		agent: 'reviewer' | 'test_engineer';
		childSessionId: string;
	}>,
): Promise<void> {
	const parent = ensureAgentSession(PARENT, 'architect', directory);
	parent.taskWorkflowStates.set(taskId, 'coder_delegated');
	// Seed Stage A ONCE: a second accepted-mutation dispatch would advance the
	// workflow generation and stale the first delegation's binding.
	const generation = await seedStageAPassed(directory, taskId);
	for (const gate of gates) {
		await recordPendingDelegation(directory, {
			correlationId: gate.childSessionId,
			jobId: `job-${gate.childSessionId}`,
			subagentSessionId: gate.childSessionId,
			parentSessionId: PARENT,
			callID: `call-${gate.childSessionId}`,
			normalizedAgent: gate.agent,
			swarmPrefixedAgent: gate.agent,
			planTaskId: taskId,
			evidenceTaskId: taskId,
			workflowGeneration: generation,
			workspace: captureWorkspaceSnapshot(directory),
		});
	}
}

function observer(directory: string) {
	return createBackgroundCompletionObserver({
		config: { enabled: true },
		directory,
		contextMap: { enabled: true },
	});
}

function status(directory: string, taskId: string) {
	return loadContextMap(directory)?.task_history[taskId]?.final_status;
}

describe('background completion observer — context-map status follows the full task release (r14 P1-5)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('bg-ctxmap-release-'));
		writePlan(directory);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('coder → reviewer → test_engineer: pending at every intermediate stage, approved only at the release', async () => {
		await seedTaskGates(directory, '1.1', [
			{ agent: 'reviewer', childSessionId: 'ses_p5_rev' },
			{ agent: 'test_engineer', childSessionId: 'ses_p5_te' },
		]);
		const obs = observer(directory);

		// Reviewer first: child-level success only.
		await obs.event(
			completionEvent(
				'ses_p5_rev',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');
		expect(
			getTaskState(ensureAgentSession(PARENT, 'architect', directory), '1.1'),
		).toBe('reviewer_run');

		// Test engineer second: both gates satisfied, task state 'tests_run',
		// but the task is NOT released — still non-final.
		await obs.event(
			completionEvent(
				'ses_p5_te',
				'<task_result>[TESTED] | 1.1 | PASS | green</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');
		expect(
			getTaskState(ensureAgentSession(PARENT, 'architect', directory), '1.1'),
		).toBe('tests_run');

		// The authoritative release promotes the summary to 'approved'.
		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
		);
		expect(result.success).toBe(true);
		expect(result.new_status).toBe('completed');
		expect(status(directory, '1.1')).toBe('approved');
	});

	test('coder → test_engineer → reviewer (reverse gate order): identical non-final progression', async () => {
		await seedTaskGates(directory, '1.1', [
			{ agent: 'reviewer', childSessionId: 'ses_p5_rev2' },
			{ agent: 'test_engineer', childSessionId: 'ses_p5_te2' },
		]);
		const obs = observer(directory);

		await obs.event(
			completionEvent(
				'ses_p5_te2',
				'<task_result>[TESTED] | 1.1 | PASS | green</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');

		await obs.event(
			completionEvent(
				'ses_p5_rev2',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');
		expect(
			getTaskState(ensureAgentSession(PARENT, 'architect', directory), '1.1'),
		).toBe('tests_run');

		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
		);
		expect(result.success).toBe(true);
		expect(status(directory, '1.1')).toBe('approved');
	});

	test('reviewer APPROVED followed by test_engineer FAIL: never approved, no positive overwrite of the negative outcome', async () => {
		await seedTaskGates(directory, '1.1', [
			{ agent: 'reviewer', childSessionId: 'ses_p5_rev3' },
			{ agent: 'test_engineer', childSessionId: 'ses_p5_te3' },
		]);
		const obs = observer(directory);

		await obs.event(
			completionEvent(
				'ses_p5_rev3',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');

		// The test engineer FAILS: the task goes to rework and the negative
		// outcome is durably consumed — no approval is possible.
		await obs.event(
			completionEvent(
				'ses_p5_te3',
				'<task_result>[TESTED] | 1.1 | FAIL | red</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');
		expect(
			getTaskState(ensureAgentSession(PARENT, 'architect', directory), '1.1'),
		).toBe('rework_required');
		expect(
			findByCorrelationId(directory, 'ses_p5_te3')?.ingestion?.outcome,
		).toBe('rejected');

		// A late REPEATED positive reviewer replay changes nothing.
		await obs.event(
			completionEvent(
				'ses_p5_rev3',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');
	});

	test('reviewer REJECTED followed by test_engineer PASS: no approval', async () => {
		await seedTaskGates(directory, '1.1', [
			{ agent: 'reviewer', childSessionId: 'ses_p5_rev4' },
			{ agent: 'test_engineer', childSessionId: 'ses_p5_te4' },
		]);
		const obs = observer(directory);

		await obs.event(
			completionEvent(
				'ses_p5_rev4',
				'<task_result>[REVIEWED] | 1.1 | REJECTED | broken</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBeUndefined();

		await obs.event(
			completionEvent(
				'ses_p5_te4',
				'<task_result>[TESTED] | 1.1 | PASS | green</task_result>',
			),
		);
		// Even with a passing test engineer, a rejected reviewer means no
		// release: the summary (if any) is never 'approved'.
		expect(status(directory, '1.1') ?? 'absent').not.toBe('approved');
	});

	test('recovery replay after each intermediate stage keeps the summary non-final', async () => {
		await seedTaskGates(directory, '1.1', [
			{ agent: 'reviewer', childSessionId: 'ses_p5_rev5' },
			{ agent: 'test_engineer', childSessionId: 'ses_p5_te5' },
		]);
		const first = observer(directory);
		await first.event(
			completionEvent(
				'ses_p5_rev5',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>',
			),
		);
		await first.event(
			completionEvent(
				'ses_p5_te5',
				'<task_result>[TESTED] | 1.1 | PASS | green</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');

		// "Restart" replays after every intermediate stage: still non-final.
		const replay = observer(directory);
		await replay.event(
			completionEvent(
				'ses_p5_rev5',
				'<task_result>[REVIEWED] | 1.1 | APPROVED | fine</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');
		await replay.event(
			completionEvent(
				'ses_p5_te5',
				'<task_result>[TESTED] | 1.1 | PASS | green</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('pending');

		// After the release, a further replay keeps it 'approved'.
		const released = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'completed' },
			directory,
		);
		expect(released.success).toBe(true);
		expect(status(directory, '1.1')).toBe('approved');
		await replay.event(
			completionEvent(
				'ses_p5_te5',
				'<task_result>[TESTED] | 1.1 | PASS | green</task_result>',
			),
		);
		expect(status(directory, '1.1')).toBe('approved');
	});
});

describe('context-map release resolution and promotion (r14 P1-5 units)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('ctxmap-release-unit-'));
		writePlan(directory);
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		cleanup();
	});

	test('resolveContextMapTaskReleaseStatus is fail-closed until gates AND plan status prove the release', async () => {
		// No evidence at all: not released.
		expect(await resolveContextMapTaskReleaseStatus(directory, '1.1')).toBe(
			'in_progress',
		);

		// Stage A + both gates, plan task still pending: not released.
		const { seedStageBGates } = await import(
			'../../helpers/task-workflow-evidence'
		);
		await seedStageBGates(directory, '1.1');
		expect(await resolveContextMapTaskReleaseStatus(directory, '1.1')).toBe(
			'in_progress',
		);

		// Plan task completed: released.
		writePlan(directory, 'completed');
		expect(await resolveContextMapTaskReleaseStatus(directory, '1.1')).toBe(
			'completed',
		);
	});

	test('updateContextMapAfterAgent: a non-final update never overwrites a terminal verdict', () => {
		updateContextMapAfterAgent({
			task_id: '1.1',
			agent_role: 'test_engineer',
			files_touched: [],
			implementation_summary: 'gate ran',
			task_goal: '',
			final_status: 'in_progress',
			directory,
		});
		expect(status(directory, '1.1')).toBe('pending');

		// A terminal negative verdict lands (rejection reasons path).
		updateContextMapAfterAgent({
			task_id: '1.1',
			agent_role: 'reviewer',
			files_touched: [],
			implementation_summary: 'gate ran',
			task_goal: '',
			final_status: 'in_progress',
			rejection_reasons: ['tests failed'],
			directory,
		});
		expect(status(directory, '1.1')).toBe('rejected');

		// A later positive child-level update must NOT erase the rejection.
		updateContextMapAfterAgent({
			task_id: '1.1',
			agent_role: 'reviewer',
			files_touched: [],
			implementation_summary: 'looks fine now',
			task_goal: '',
			final_status: 'in_progress',
			directory,
		});
		expect(status(directory, '1.1')).toBe('rejected');
	});

	test('promoteContextMapTaskRelease: idempotent, preserves rejected, creates a minimal entry when absent', () => {
		// No entry yet: a minimal approved summary is created.
		promoteContextMapTaskRelease(directory, '1.1');
		expect(status(directory, '1.1')).toBe('approved');
		// Idempotent.
		promoteContextMapTaskRelease(directory, '1.1');
		expect(status(directory, '1.1')).toBe('approved');

		// A terminal rejected entry is never promoted.
		updateContextMapAfterAgent({
			task_id: '1.2',
			agent_role: 'test_engineer',
			files_touched: [],
			implementation_summary: 'gate ran',
			task_goal: '',
			final_status: 'in_progress',
			rejection_reasons: ['still failing'],
			directory,
		});
		expect(status(directory, '1.2')).toBe('rejected');
		promoteContextMapTaskRelease(directory, '1.2');
		expect(status(directory, '1.2')).toBe('rejected');

		// A pending entry is promoted.
		updateContextMapAfterAgent({
			task_id: '1.3',
			agent_role: 'reviewer',
			files_touched: [],
			implementation_summary: 'gate ran',
			task_goal: '',
			final_status: 'in_progress',
			directory,
		});
		promoteContextMapTaskRelease(directory, '1.3');
		expect(status(directory, '1.3')).toBe('approved');
	});

	test('promoteContextMapTaskRelease tolerates a missing map (no-op)', () => {
		fs.rmSync(join(directory, '.swarm', 'context-map.json'), {
			force: true,
		});
		expect(() => promoteContextMapTaskRelease(directory, '9.9')).not.toThrow();
	});

	test('saveContextMap roundtrip keeps the guard observable', () => {
		// Direct persistence-level check that the terminal statuses survive a
		// save/load cycle (the guard reads the persisted state).
		updateContextMapAfterAgent({
			task_id: '1.8',
			agent_role: 'reviewer',
			files_touched: [],
			implementation_summary: 'seed entry',
			task_goal: '',
			final_status: 'in_progress',
			directory,
		});
		const map = loadContextMap(directory);
		expect(map).not.toBeNull();
		if (!map) return;
		map.task_history['1.9'] = {
			task_id: '1.9',
			goal: '',
			files_touched: [],
			implementation_summary: '',
			final_status: 'rejected',
		};
		saveContextMap(map, directory);
		expect(status(directory, '1.9')).toBe('rejected');
	});
});
