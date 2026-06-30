/**
 * Integration test: get_approved_plan tool end-to-end flow.
 *
 * Exercises the full lifecycle:
 * 1. Create plan.json and initialize ledger
 * 2. Write drift evidence with APPROVED verdict (triggers snapshot)
 * 3. Verify get_approved_plan retrieves the snapshot
 * 4. Mutate plan.json
 * 5. Verify get_approved_plan detects drift
 *
 * Uses real files on disk — no mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import {
	computePlanHash,
	initLedger,
	takeSnapshotEvent,
} from '../../src/plan/ledger';
import { derivePlanId } from '../../src/plan/utils';
import { get_approved_plan } from '../../src/tools/get-approved-plan';

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Integration Drift Test',
		swarm: 'drift-integration-swarm',
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
						description: 'Implement feature A',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
		...overrides,
	};
}

describe('get_approved_plan integration: full drift detection flow', () => {
	let dir: string;
	let plan: Plan;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'drift-integration-test-'));
		await mkdir(join(dir, '.swarm', 'evidence'), { recursive: true });

		plan = createTestPlan();
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf-8',
		);

		const planId = derivePlanId(plan);
		await initLedger(dir, planId);
	});

	afterEach(async () => {
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('full lifecycle: approve → retrieve → mutate → detect drift', async () => {
		// Step 1: No approved snapshot yet
		const beforeApproval = JSON.parse(
			await get_approved_plan.execute({}, { directory: dir } as never),
		);
		expect(beforeApproval.success).toBe(false);
		expect(beforeApproval.reason).toBe('no_approved_snapshot');

		// Step 2: Simulate critic approval by writing snapshot
		// (In production, write_drift_evidence calls takeSnapshotEvent on APPROVED)
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: {
				phase: 1,
				verdict: 'APPROVED',
				summary: 'All tasks verified',
				approved_at: new Date().toISOString(),
			},
		});

		// Step 3: Retrieve — should find snapshot, no drift
		const afterApproval = JSON.parse(
			await get_approved_plan.execute({}, { directory: dir } as never),
		);
		expect(afterApproval.success).toBe(true);
		expect(afterApproval.drift_detected).toBe(false);
		expect(afterApproval.approved_plan.payload_hash).toBe(
			computePlanHash(plan),
		);
		expect(afterApproval.approved_plan.approval_metadata.verdict).toBe(
			'APPROVED',
		);
		expect(afterApproval.current_plan.current_hash).toBe(
			afterApproval.approved_plan.payload_hash,
		);

		// Step 4: Mutate plan.json after approval (simulating unauthorized change)
		const mutatedPlan: Plan = {
			...plan,
			current_phase: 2,
			phases: [
				{
					...plan.phases[0],
					status: 'completed',
					tasks: plan.phases[0].tasks.map((t) => ({
						...t,
						status: 'completed',
					})),
				},
				{
					id: 2,
					name: 'Unauthorized Phase',
					status: 'in_progress',
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'pending',
							size: 'large',
							description: 'Scope creep task added post-approval',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(mutatedPlan, null, 2),
			'utf-8',
		);

		// Step 5: Retrieve again — should detect drift
		const afterMutation = JSON.parse(
			await get_approved_plan.execute({}, { directory: dir } as never),
		);
		expect(afterMutation.success).toBe(true);
		expect(afterMutation.drift_detected).toBe(true);
		expect(afterMutation.approved_plan.payload_hash).toBe(
			computePlanHash(plan),
		);
		expect(afterMutation.current_plan.current_hash).toBe(
			computePlanHash(mutatedPlan),
		);
		expect(afterMutation.current_plan.current_hash).not.toBe(
			afterMutation.approved_plan.payload_hash,
		);
	});

	test('summary_only mode through tool execute wrapper', async () => {
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 1, verdict: 'APPROVED' },
		});

		const result = JSON.parse(
			await get_approved_plan.execute({ summary_only: true }, {
				directory: dir,
			} as never),
		);
		expect(result.success).toBe(true);
		expect(result.approved_plan.plan.phase_count).toBe(1);
		expect(result.approved_plan.plan.phases[0].task_count).toBe(1);
		// Full plan object fields should NOT be present in summary
		expect(result.approved_plan.plan.phases[0].tasks).toBeUndefined();
	});
});
