/**
 * Issue #2523 — get_approved_plan baseline drift semantics.
 *
 * The approval baseline hash is the status-EXCLUDED structure hash
 * (`computePlanStructureHash`). Every `critic_approved` snapshot stores it
 * (enforced at the takeSnapshotEvent choke point) and get_approved_plan
 * compares against a fresh derivation of the same function. Therefore:
 *
 *   - a status-only change (execution progress) must NEVER report drift
 *   - any structural change (acceptance, tasks added, scope) MUST report drift
 *
 * Parameterized table over the issue's adversarial cases, each driving a
 * PRODUCTION approval writer (delegation-gate hook recorder,
 * forceRecordPlanCriticApproval, or the write_drift_evidence tool) — not a
 * hand-forged snapshot.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import { getOrCreateProfileForIdentity } from '../../../src/db/qa-gate-profile';
import { _internals as delegationGateInternals } from '../../../src/hooks/delegation-gate';
import { initLedger } from '../../../src/plan/ledger';
import { updateTaskStatus } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { executeGetApprovedPlan } from '../../../src/tools/get-approved-plan';
import { executeWriteDriftEvidence } from '../../../src/tools/write-drift-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import {
	createDelegationGateHook,
	makeConfig,
} from '../hooks/_delegation-gate-helpers';

function makeBaselinePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Baseline Drift Table',
		swarm: 'baseline-drift-swarm',
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
						status: 'pending',
						size: 'small',
						description: 'Implement the feature',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
}

async function setupProject(plan: Plan): Promise<string> {
	const dir = canonicalMkdtemp('baseline-drift-');
	// Explicit project-root marker so assertProjectRoot accepts the temp dir
	// even when a parent already contains .swarm state (host-dependent).
	mkdirSync(join(dir, '.git'), { recursive: true });
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);
	await initLedger(dir, derivePlanId(plan));
	return dir;
}

/** Mechanical plan-critic approval through the real delegation-gate hook. */
async function approveViaPlanCriticHook(dir: string): Promise<void> {
	ensureAgentSession('session-baseline-drift', 'architect');
	const hook = createDelegationGateHook(makeConfig(), dir);
	await hook.toolAfter(
		{
			tool: 'Task',
			sessionID: 'session-baseline-drift',
			callID: 'critic-baseline-drift',
			args: {
				subagent_type: 'critic',
				prompt:
					'MODE: CRITIC-GATE\nEvaluate this plan for soundness before implementation.',
			},
		},
		{ output: 'VERDICT: APPROVED\nThe plan is ready for execution.' },
	);
}

function writePlanJson(dir: string, plan: Plan): void {
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);
}

describe('get_approved_plan baseline drift — single structure-hash definition (#2523)', () => {
	let dir: string;
	let plan: Plan;

	beforeEach(async () => {
		resetSwarmState();
		plan = makeBaselinePlan();
		dir = await setupProject(plan);
	});

	afterEach(async () => {
		resetSwarmState();
		if (dir && existsSync(dir)) {
			closeProjectDb(dir);
			await rm(dir, { recursive: true, force: true, maxRetries: 5 });
		}
	});

	test('plan-critic approval → task completed (production updateTaskStatus) → no drift', async () => {
		await approveViaPlanCriticHook(dir);

		// Execution progress through the production status writer.
		await updateTaskStatus(dir, '1.1', 'completed');

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(false);
	});

	test('plan-critic approval → acceptance-criteria edit → drift', async () => {
		await approveViaPlanCriticHook(dir);

		const edited: Plan = {
			...plan,
			phases: plan.phases.map((phase) => ({
				...phase,
				tasks: phase.tasks.map((task) =>
					task.id === '1.1'
						? { ...task, acceptance: 'Tightened criteria edited post-approval' }
						: task,
				),
			})),
		};
		writePlanJson(dir, edited);

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(true);
	});

	test('plan-critic approval → task added → drift', async () => {
		await approveViaPlanCriticHook(dir);

		const extended: Plan = {
			...plan,
			phases: plan.phases.map((phase) => ({
				...phase,
				tasks: [
					...phase.tasks,
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Scope creep task added post-approval',
						depends: [],
						files_touched: [],
					},
				],
			})),
		};
		writePlanJson(dir, extended);

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(true);
	});

	test('approve_plan_critic override immediately after approval → no drift', async () => {
		// Sequential, as the issue states it: a mechanical plan-critic approval
		// exists, then the override records a fresh approval right after it.
		await approveViaPlanCriticHook(dir);
		ensureAgentSession('session-override-drift', 'architect');
		await delegationGateInternals.forceRecordPlanCriticApproval(
			dir,
			'session-override-drift',
			{ reason: 'critic approved but snapshot was missed (#2012)' },
		);

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(false);
	});

	test('fresh approval → no drift; after the first status transition → still no drift', async () => {
		await approveViaPlanCriticHook(dir);

		const fresh = await executeGetApprovedPlan({}, dir);
		expect(fresh.success).toBe(true);
		expect(fresh.drift_detected).toBe(false);

		await updateTaskStatus(dir, '1.1', 'in_progress');

		const afterTransition = await executeGetApprovedPlan({}, dir);
		expect(afterTransition.success).toBe(true);
		expect(afterTransition.drift_detected).toBe(false);
	});

	test('write_drift_evidence APPROVED → status-only change → no drift', async () => {
		getOrCreateProfileForIdentity(dir, {
			swarm: plan.swarm,
			title: plan.title,
		});
		const writeResult = await executeWriteDriftEvidence(
			{
				phase: 1,
				verdict: 'APPROVED',
				summary: 'Phase 1 verified against the approved baseline',
			},
			dir,
		);
		expect(JSON.parse(writeResult).success).toBe(true);

		await updateTaskStatus(dir, '1.1', 'completed');

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(false);
	});

	test('write_drift_evidence APPROVED → structural edit → drift', async () => {
		getOrCreateProfileForIdentity(dir, {
			swarm: plan.swarm,
			title: plan.title,
		});
		const writeResult = await executeWriteDriftEvidence(
			{
				phase: 1,
				verdict: 'APPROVED',
				summary: 'Phase 1 verified against the approved baseline',
			},
			dir,
		);
		expect(JSON.parse(writeResult).success).toBe(true);

		const edited: Plan = {
			...plan,
			phases: plan.phases.map((phase) => ({
				...phase,
				tasks: phase.tasks.map((task) =>
					task.id === '1.1'
						? { ...task, description: 'Description rewritten post-approval' }
						: task,
				),
			})),
		};
		writePlanJson(dir, edited);

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(true);
	});
});
