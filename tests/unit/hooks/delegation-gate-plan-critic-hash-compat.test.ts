import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	computePlanLedgerHash,
	computePlanStructureHash,
	initLedger,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import {
	createDelegationGateHook,
	makeConfig,
} from './_delegation-gate-helpers';

function makeLegacyPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Legacy Critic Approval',
		swarm: 'hash-compat',
		current_phase: 1,
		execution_profile: {
			parallelization_enabled: true,
			max_concurrent_tasks: 3,
			council_parallel: false,
			locked: true,
			auto_proceed: true,
		},
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
						description: 'Preserve the existing approval',
						depends: [],
						files_touched: ['src/plan/ledger.ts'],
					},
				],
			},
		],
	} as Plan;
}

describe('plan critic hash compatibility — regression: default-false field (critic F1)', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir, cleanup } = createSafeTestDir('critic-hash-compat-'));
	});

	afterEach(() => {
		resetSwarmState();
		resetStartupLedgerCheck();
		cleanup();
	});

	test('keeps a pre-upgrade critic approval valid after false is materialized', async () => {
		// Previous computePlanStructureHash serialized the schema-injected false
		// value, so an approval recorded before the field existed became stale on
		// the next load even though the user had not opted into checkpoint commits.
		const legacyPlan = makeLegacyPlan();
		const swarmDir = join(dir, '.swarm');
		const planPath = join(swarmDir, 'plan.json');
		mkdirSync(swarmDir, { recursive: true });
		writeFileSync(planPath, JSON.stringify(legacyPlan, null, 2), 'utf8');
		await initLedger(
			dir,
			derivePlanId(legacyPlan),
			computePlanLedgerHash(legacyPlan),
			legacyPlan,
		);
		await takeSnapshotEvent(dir, legacyPlan, {
			source: 'critic_approved',
			approvalMetadata: {
				verdict: 'APPROVED',
				source: 'plan_critic_gate',
			},
			payloadHashOverride: computePlanStructureHash(legacyPlan),
		});

		writeFileSync(
			planPath,
			JSON.stringify(
				{
					...legacyPlan,
					execution_profile: {
						...legacyPlan.execution_profile!,
						commit_after_each_completed_task: false,
					},
				},
				null,
				2,
			),
			'utf8',
		);

		const hook = createDelegationGateHook(makeConfig(), dir);
		await expect(
			hook.toolBefore(
				{
					tool: 'Task',
					sessionID: 'session-plan-critic-legacy',
					callID: 'session-plan-critic-legacy-coder',
				},
				{
					args: {
						subagent_type: 'coder',
						prompt:
							'TASK: 1.1\nImplement the approved plan.\nACCEPTANCE: compatibility is preserved',
					},
				},
			),
		).resolves.toBeUndefined();
	});
});
