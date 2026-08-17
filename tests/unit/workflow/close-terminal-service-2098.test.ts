import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	readTaskEvidenceRaw,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { loadPlanJsonOnly, savePlan } from '../../../src/plan/manager';
import { reconcileCloseTerminalState } from '../../../src/workflow/close-terminal';
import { _internals as terminalInternals } from '../../../src/workflow/task-terminal';
import { seedStageBGates } from '../../helpers/task-workflow-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function plan(status: 'closed' | 'completed' | 'in_progress'): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Close terminal service',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: status === 'in_progress' ? 'in_progress' : 'closed',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status,
						size: 'small',
						description: 'Reconcile terminal state',
						depends: [],
						files_touched: ['src/close.ts'],
					},
				],
			},
		],
	};
}

function multiPhasePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Close terminal service',
		swarm: 'test-swarm',
		current_phase: 2,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'complete',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						size: 'small',
						description: 'Already done',
						depends: [],
						files_touched: ['src/one.ts'],
					},
				],
			},
			{
				id: 2,
				name: 'Phase 2',
				status: 'in_progress',
				tasks: [
					{
						id: '2.1',
						phase: 2,
						status: 'in_progress',
						size: 'small',
						description: 'Current close target',
						depends: [],
						files_touched: ['src/two.ts'],
					},
				],
			},
		],
	};
}

describe('issue #2098 close terminal service', () => {
	let directory: string;

	beforeEach(async () => {
		directory = canonicalMkdtemp('close-terminal-service-2098-');
		fs.mkdirSync(path.join(directory, '.git'));
		await savePlan(directory, plan('in_progress'));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('closes unfinished exact workflow with one plan-bound v2 transition', async () => {
		await seedStageBGates(directory, '1.1');
		const result = await reconcileCloseTerminalState(
			directory,
			plan('closed'),
			{
				actor: 'close-test',
				requestedClosedTaskIds: ['1.1'],
				closedPhaseIds: [1],
				originalStatuses: new Map([['1.1', 'in_progress']]),
			},
		);

		expect(result.closedTaskIds).toEqual(['1.1']);
		expect(result.preservedCompletedTaskIds).toEqual([]);
		expect(readTaskEvidenceRaw(directory, '1.1')?.workflow?.state).toBe(
			'closed',
		);
		expect(
			(await loadPlanJsonOnly(directory))?.phases[0]?.tasks[0]?.status,
		).toBe('closed');
		const wal = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
				'utf-8',
			),
		);
		expect(wal).toMatchObject({
			version: 2,
			state: 'COMMITTED',
			newPlanStatus: 'closed',
			newWorkflowState: 'closed',
		});
	});

	test('preserves authoritative success and reconciles stale plan projection', async () => {
		const generation = await seedStageBGates(directory, '1.1');
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'task_completed',
			expectedGeneration: generation,
			transitionId: 'already-successful',
		});

		const result = await reconcileCloseTerminalState(
			directory,
			plan('closed'),
			{
				actor: 'close-test',
				requestedClosedTaskIds: ['1.1'],
				closedPhaseIds: [1],
			},
		);

		expect(result.closedTaskIds).toEqual([]);
		expect(result.preservedCompletedTaskIds).toEqual(['1.1']);
		expect(readTaskEvidenceRaw(directory, '1.1')?.workflow).toMatchObject({
			state: 'complete',
			lastTransitionId: 'already-successful',
		});
		expect(
			(await loadPlanJsonOnly(directory))?.phases[0]?.tasks[0]?.status,
		).toBe('completed');
	});

	test('fails closed when completed plan intent contradicts exact workflow', async () => {
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'task_blocked',
			expectedGeneration: 0,
			transitionId: 'blocked-before-close',
		});
		await expect(
			reconcileCloseTerminalState(directory, plan('completed'), {
				actor: 'close-test',
				requestedClosedTaskIds: [],
				closedPhaseIds: [1],
			}),
		).rejects.toThrow('CLOSE_TERMINAL_EVIDENCE_CONTRADICTION');
		expect(
			(await loadPlanJsonOnly(directory))?.phases[0]?.tasks[0]?.status,
		).toBe('in_progress');
	});

	test('converts authoritative blocked evidence only to truthful closed, never success', async () => {
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'task_blocked',
			expectedGeneration: 0,
			transitionId: 'blocked-before-session-close',
		});

		const result = await reconcileCloseTerminalState(
			directory,
			plan('closed'),
			{
				actor: 'close-test',
				requestedClosedTaskIds: ['1.1'],
				closedPhaseIds: [1],
			},
		);

		expect(result.closedTaskIds).toEqual(['1.1']);
		expect(readTaskEvidenceRaw(directory, '1.1')?.workflow).toMatchObject({
			state: 'closed',
			lastOutcome: 'task_closed',
		});
	});

	test('between-task failure leaves prior task consistent, current recoverable, and later untouched', async () => {
		const multiPlan = plan('in_progress');
		multiPlan.phases[0]!.tasks = ['1.1', '1.2', '1.3'].map((id) => ({
			id,
			phase: 1,
			status: 'in_progress' as const,
			size: 'small' as const,
			description: `Reconcile ${id}`,
			depends: [],
			files_touched: [`src/${id}.ts`],
		}));
		await savePlan(directory, multiPlan);
		for (const task of multiPlan.phases[0]!.tasks) {
			await seedStageBGates(directory, task.id);
		}
		const targetPlan = structuredClone(multiPlan);
		targetPlan.phases[0]!.status = 'closed';
		for (const task of targetPlan.phases[0]!.tasks) task.status = 'closed';

		const realApplyTerminalEvidence = terminalInternals.applyTerminalEvidence;
		let injected = false;
		terminalInternals.applyTerminalEvidence = async (transaction, wal) => {
			if (wal.taskId === '1.2' && !injected) {
				injected = true;
				throw new Error('injected evidence crash');
			}
			return realApplyTerminalEvidence(transaction, wal);
		};
		try {
			await expect(
				reconcileCloseTerminalState(directory, targetPlan, {
					actor: 'close-test',
					requestedClosedTaskIds: ['1.1', '1.2', '1.3'],
					closedPhaseIds: [1],
				}),
			).rejects.toThrow('injected evidence crash');
		} finally {
			terminalInternals.applyTerminalEvidence = realApplyTerminalEvidence;
		}

		const afterFailure = await loadPlanJsonOnly(directory);
		expect(afterFailure?.phases[0]?.tasks.map((task) => task.status)).toEqual([
			'closed',
			'closed',
			'in_progress',
		]);
		expect(readTaskEvidenceRaw(directory, '1.1')?.workflow?.state).toBe(
			'closed',
		);
		expect(readTaskEvidenceRaw(directory, '1.2')?.workflow?.state).toBe(
			'tests_run',
		);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-terminals', '1.2.json'),
					'utf8',
				),
			).state,
		).toBe('PREPARED');
		expect(
			fs.existsSync(
				path.join(directory, '.swarm', 'task-terminals', '1.3.json'),
			),
		).toBe(false);

		const recovered = await reconcileCloseTerminalState(directory, targetPlan, {
			actor: 'close-test',
			requestedClosedTaskIds: ['1.1', '1.2', '1.3'],
			closedPhaseIds: [1],
		});
		expect(recovered.closedTaskIds).toEqual(['1.1', '1.2', '1.3']);
		expect(recovered.plan.phases[0]?.tasks.map((task) => task.status)).toEqual([
			'closed',
			'closed',
			'closed',
		]);
		expect(readTaskEvidenceRaw(directory, '1.2')?.workflow?.state).toBe(
			'closed',
		);
	});

	test('rejects authoritative topology drift before any terminal mutation', async () => {
		await seedStageBGates(directory, '1.1');
		const staleTarget = plan('closed');
		const authoritative = plan('in_progress');
		authoritative.phases[0]!.tasks.push({
			id: '1.2',
			phase: 1,
			status: 'in_progress',
			size: 'small',
			description: 'Concurrent task added',
			depends: [],
			files_touched: ['src/concurrent.ts'],
		});
		authoritative.phases.push({
			id: 2,
			name: 'Phase 2',
			status: 'pending',
			tasks: [
				{
					id: '2.1',
					phase: 2,
					status: 'pending',
					size: 'small',
					description: 'Concurrent phase added',
					depends: [],
					files_touched: ['src/phase-two.ts'],
				},
			],
		});
		authoritative.current_phase = 2;
		await savePlan(directory, authoritative);
		const tracked = [
			path.join(directory, '.swarm', 'plan.json'),
			path.join(directory, '.swarm', 'plan-ledger.jsonl'),
			path.join(directory, '.swarm', 'evidence', '1.1.json'),
		];
		const before = tracked.map((file) => fs.readFileSync(file));

		await expect(
			reconcileCloseTerminalState(directory, staleTarget, {
				actor: 'close-test',
				requestedClosedTaskIds: ['1.1'],
				closedPhaseIds: [1],
			}),
		).rejects.toThrow('CLOSE_TERMINAL_PLAN_TOPOLOGY_MISMATCH');

		tracked.forEach((file, index) => {
			expect(fs.readFileSync(file)).toEqual(before[index]);
		});
		expect(await loadPlanJsonOnly(directory)).toEqual(authoritative);
		expect(readTaskEvidenceRaw(directory, '1.1')?.workflow?.state).toBe(
			'tests_run',
		);
		expect(
			fs.existsSync(
				path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
			),
		).toBe(false);
	});

	test('rejects plan identity drift before any terminal mutation', async () => {
		await seedStageBGates(directory, '1.1');
		const staleTarget = {
			...plan('closed'),
			title: 'Stale close title',
		};
		const tracked = [
			path.join(directory, '.swarm', 'plan.json'),
			path.join(directory, '.swarm', 'plan-ledger.jsonl'),
			path.join(directory, '.swarm', 'evidence', '1.1.json'),
		];
		const before = tracked.map((file) => fs.readFileSync(file));

		await expect(
			reconcileCloseTerminalState(directory, staleTarget, {
				actor: 'close-test',
				requestedClosedTaskIds: ['1.1'],
				closedPhaseIds: [1],
			}),
		).rejects.toThrow('CLOSE_TERMINAL_PLAN_IDENTITY_MISMATCH');

		tracked.forEach((file, index) => {
			expect(fs.readFileSync(file)).toEqual(before[index]);
		});
		expect(readTaskEvidenceRaw(directory, '1.1')?.workflow?.state).toBe(
			'tests_run',
		);
		expect(
			fs.existsSync(
				path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
			),
		).toBe(false);
	});

	test('rebuilds final projection from the authoritative locked plan instead of stale caller phase data', async () => {
		const authoritative = multiPhasePlan();
		await savePlan(directory, authoritative);
		await seedStageBGates(directory, '2.1');
		const staleTarget = structuredClone(authoritative);
		staleTarget.current_phase = 1;
		staleTarget.phases[0]!.status = 'closed';
		staleTarget.phases[1]!.status = 'closed';
		staleTarget.phases[1]!.tasks[0]!.status = 'closed';

		const result = await reconcileCloseTerminalState(directory, staleTarget, {
			actor: 'close-test',
			requestedClosedTaskIds: ['2.1'],
			closedPhaseIds: [2],
			originalStatuses: new Map([['2.1', 'in_progress']]),
		});

		expect(result.plan.current_phase).toBe(2);
		expect(result.plan.phases.map((phase) => phase.status)).toEqual([
			'complete',
			'closed',
		]);
		expect(result.plan.phases[0]?.tasks[0]?.status).toBe('completed');
		expect(result.plan.phases[1]?.tasks[0]?.status).toBe('closed');
		expect((await loadPlanJsonOnly(directory))?.current_phase).toBe(2);
		expect(
			(await loadPlanJsonOnly(directory))?.phases.map((phase) => phase.status),
		).toEqual(['complete', 'closed']);
	});

	test('reports a QA-exempt forced completion and records it in durable evidence', async () => {
		// No seedStageBGates: the task is `completed` in the plan projection but has no
		// authoritative workflow evidence, which is the forced-completion path.
		const result = await reconcileCloseTerminalState(
			directory,
			plan('completed'),
			{
				actor: 'close-test',
				requestedClosedTaskIds: [],
				closedPhaseIds: [1],
				originalStatuses: new Map([['1.1', 'completed']]),
			},
		);

		expect(result.forcedCompletionTaskIds).toEqual(['1.1']);
		const workflow = readTaskEvidenceRaw(directory, '1.1')?.workflow;
		expect(workflow?.state).toBe('complete');
		expect(workflow?.forcedCompletion).toBe(true);
	});

	// Drives the real reconcileCloseTerminalState so both of its re-report branches
	// (desired='closed' and desired='completed') are exercised against evidence an
	// EARLIER forced completion already wrote — the half of the forcedCompletionTaskIds
	// contract that reads the persisted flag rather than setting it.
	for (const desired of ['closed', 'completed'] as const) {
		test(`re-reports an existing forcedCompletion when reconciling desired=${desired}`, async () => {
			await reconcileCloseTerminalState(directory, plan('completed'), {
				actor: 'close-test',
				requestedClosedTaskIds: [],
				closedPhaseIds: [1],
				originalStatuses: new Map([['1.1', 'completed']]),
			});
			expect(
				readTaskEvidenceRaw(directory, '1.1')?.workflow?.forcedCompletion,
			).toBe(true);

			const again = await reconcileCloseTerminalState(
				directory,
				plan(desired),
				{
					actor: 'close-test',
					requestedClosedTaskIds: desired === 'closed' ? ['1.1'] : [],
					closedPhaseIds: [1],
					originalStatuses: new Map([['1.1', 'completed']]),
				},
			);

			expect(again.forcedCompletionTaskIds).toEqual(['1.1']);
		});
	}

	test('does not report a forced completion for a genuinely gated success', async () => {
		const generation = await seedStageBGates(directory, '1.1');
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'task_completed',
			expectedGeneration: generation,
			transitionId: 'gated-success',
		});

		const result = await reconcileCloseTerminalState(
			directory,
			plan('completed'),
			{
				actor: 'close-test',
				requestedClosedTaskIds: [],
				closedPhaseIds: [1],
				originalStatuses: new Map([['1.1', 'completed']]),
			},
		);

		expect(result.forcedCompletionTaskIds).toEqual([]);
		expect(
			readTaskEvidenceRaw(directory, '1.1')?.workflow?.forcedCompletion,
		).toBeUndefined();
	});
});
