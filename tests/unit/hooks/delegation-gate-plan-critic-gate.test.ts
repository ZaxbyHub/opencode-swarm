import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	computePlanHash,
	initLedger,
	loadLastApprovedPlan,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { derivePlanId } from '../../../src/plan/utils';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	createDelegationGateHook,
	makeConfig,
} from './_delegation-gate-helpers';

function makePlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Plan Critic Gate Test',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Implement issue fix',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

async function writePlan(dir: string, plan: Plan): Promise<void> {
	await mkdir(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await initLedger(dir, derivePlanId(plan));
}

function coderDispatch(sessionID = 'session-plan-critic-gate') {
	return {
		input: {
			tool: 'Task',
			sessionID,
			callID: `${sessionID}-coder`,
		},
		output: {
			args: {
				subagent_type: 'coder',
				prompt: 'TASK: 1.1\nImplement the approved plan.',
			},
		},
	};
}

describe('delegation gate plan critic approval', () => {
	let dir: string;

	beforeEach(async () => {
		resetSwarmState();
		dir = await mkdtemp(join(tmpdir(), 'plan-critic-gate-'));
	});

	afterEach(async () => {
		resetSwarmState();
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('blocks coder dispatch when no approved plan critic snapshot exists', async () => {
		await writePlan(dir, makePlan());
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = coderDispatch();

		await expect(hook.toolBefore(input, output)).rejects.toThrow(
			'PLAN_CRITIC_GATE_VIOLATION',
		);
	});

	test('allows coder dispatch when current plan has an approved critic snapshot', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { verdict: 'APPROVED', source: 'plan_critic_gate' },
		});
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = coderDispatch();

		await hook.toolBefore(input, output);
	});

	test('blocks coder dispatch when approved snapshot is not plan-critic evidence', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: {
				phase: 1,
				verdict: 'APPROVED',
				summary: 'Phase drift verification approved',
			},
		});
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = coderDispatch();

		await expect(hook.toolBefore(input, output)).rejects.toThrow(
			'PLAN_CRITIC_GATE_VIOLATION',
		);
	});

	test('blocks coder dispatch when the approved snapshot is stale', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { verdict: 'APPROVED', source: 'plan_critic_gate' },
		});

		const changedPlan = makePlan({
			phases: [
				{
					...plan.phases[0],
					tasks: [
						{
							...plan.phases[0].tasks[0],
							description: 'Changed after approval',
						},
					],
				},
			],
		});
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(changedPlan, null, 2),
		);
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = coderDispatch();

		await expect(hook.toolBefore(input, output)).rejects.toThrow(
			'PLAN_CRITIC_GATE_VIOLATION',
		);
		expect(computePlanHash(changedPlan)).not.toBe(computePlanHash(plan));
	});

	test('records an approved snapshot after approved plan critic output', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		ensureAgentSession('session-plan-critic-record', 'architect');
		const hook = createDelegationGateHook(makeConfig(), dir);

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'session-plan-critic-record',
				callID: 'critic-call',
				args: {
					subagent_type: 'critic',
					prompt: 'MODE: CRITIC-GATE\nTASK: Review plan before EXECUTE',
				},
			},
			{
				output:
					'VERDICT: APPROVED\nThe plan is mechanically covered and ready.',
			},
		);

		const approved = await loadLastApprovedPlan(dir, derivePlanId(plan));
		expect(approved).not.toBeNull();
		expect(approved?.payloadHash).toBe(computePlanHash(plan));
		expect(approved?.approval?.verdict).toBe('APPROVED');
	});
});
