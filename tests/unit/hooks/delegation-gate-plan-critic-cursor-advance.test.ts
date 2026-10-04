/**
 * The plan-critic approval survives a phase-boundary cursor advance.
 *
 * The approval snapshot's payload hash is the structural plan hash, which
 * includes the `current_phase` cursor (#2532). Completing a phase's last task
 * advances the cursor, so the first coder dispatch of the next phase was
 * refused with PLAN_CRITIC_GATE_VIOLATION although the plan was never edited.
 * A plan that differs from the approved snapshot ONLY in the cursor is still
 * covered; any structural edit still invalidates the approval.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { isPlanCriticApproved } from '../../../src/hooks/delegation-gate';
import {
	computePlanStructureHash,
	initLedger,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { updateTaskStatus } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { resetSwarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
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
						files_touched: ['src/index.ts'],
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
// Record a plan-critic-approval snapshot the SAME way production does
// (`recordPlanCriticApprovalSnapshotIfApplicable`): tagged `plan_critic_gate`
// and storing the STATUS-EXCLUDED structural hash as payload_hash.
async function recordPlanCriticSnapshot(
	dir: string,
	plan: Plan,
): Promise<void> {
	await takeSnapshotEvent(dir, plan, {
		source: 'critic_approved',
		approvalMetadata: { verdict: 'APPROVED', source: 'plan_critic_gate' },
		payloadHashOverride: computePlanStructureHash(plan),
	});
}

describe('delegation gate plan critic approval — phase-boundary cursor advance', () => {
	let dir: string;

	beforeEach(async () => {
		resetSwarmState();
		dir = canonicalMkdtemp('plan-critic-cursor-');
	});

	afterEach(async () => {
		resetSwarmState();
		closeAllProjectDbs();
		if (dir && existsSync(dir)) {
			(await import('../../helpers/safe-test-dir.js')).safeRmRecursive(dir);
		}
	});

	function twoPhasePlan(): Plan {
		const base = makePlan();
		return makePlan({
			phases: [
				base.phases[0],
				{
					id: 2,
					name: 'Follow-up',
					status: 'pending',
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'pending',
							size: 'small',
							description: 'Follow-up task',
							depends: [],
							files_touched: ['src/follow-up.ts'],
						},
					],
				},
			],
		});
	}

	function phase2CoderDispatch() {
		return {
			input: {
				tool: 'Task',
				sessionID: 'session-phase-2',
				callID: 'session-phase-2-coder',
			},
			output: {
				args: {
					subagent_type: 'coder',
					prompt:
						'TASK: 2.1\nImplement the follow-up.\nACCEPTANCE: task complete and covered by tests',
				},
			},
		};
	}

	test('completing phase 1 (cursor 1 → 2) keeps the plan-critic approval', async () => {
		// Live run: the plan was approved at cursor 1; phase 1's last task
		// advanced the cursor to 2, which rotated the cursor-inclusive
		// structure hash, and the first phase-2 coder dispatch was refused
		// with PLAN_CRITIC_GATE_VIOLATION although nothing was edited.
		const plan = twoPhasePlan();
		await writePlan(dir, plan);
		await updateTaskStatus(dir, '1.1', 'pending');
		const approvedPlan = JSON.parse(
			readFileSync(join(dir, '.swarm', 'plan.json'), 'utf8'),
		) as Plan;
		await recordPlanCriticSnapshot(dir, approvedPlan);

		await updateTaskStatus(dir, '1.1', 'completed');
		const advanced = JSON.parse(
			readFileSync(join(dir, '.swarm', 'plan.json'), 'utf8'),
		) as Plan;
		expect(advanced.current_phase).toBe(2);
		expect(computePlanStructureHash(advanced)).not.toBe(
			computePlanStructureHash(approvedPlan),
		);

		expect(await isPlanCriticApproved(dir)).toBe(true);
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = phase2CoderDispatch();
		await hook.toolBefore(input, output);
	});

	test('a structural edit after the cursor advance still invalidates the approval', async () => {
		const plan = twoPhasePlan();
		await writePlan(dir, plan);
		await updateTaskStatus(dir, '1.1', 'pending');
		await recordPlanCriticSnapshot(
			dir,
			JSON.parse(
				readFileSync(join(dir, '.swarm', 'plan.json'), 'utf8'),
			) as Plan,
		);
		await updateTaskStatus(dir, '1.1', 'completed');
		const advanced = JSON.parse(
			readFileSync(join(dir, '.swarm', 'plan.json'), 'utf8'),
		) as Plan;
		advanced.phases[1].tasks[0].description = 'Edited after approval';
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(advanced, null, 2),
		);

		expect(await isPlanCriticApproved(dir)).toBe(false);
		const hook = createDelegationGateHook(makeConfig(), dir);
		const { input, output } = phase2CoderDispatch();
		await expect(hook.toolBefore(input, output)).rejects.toThrow(
			'PLAN_CRITIC_GATE_VIOLATION',
		);
	});
});
