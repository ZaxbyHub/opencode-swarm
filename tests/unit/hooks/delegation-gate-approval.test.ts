import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { isPlanCriticApproved } from '../../../src/hooks/delegation-gate';
import {
	computePlanStructureHash,
	initLedger,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { derivePlanId } from '../../../src/plan/utils';
import { resetSwarmState } from '../../../src/state';

function makePlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Approval Test Plan',
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
						description: 'Implement feature',
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

/** Record a valid plan-critic approval snapshot (same shape as production). */
async function recordPlanCriticSnapshot(
	dir: string,
	plan: Plan,
): Promise<void> {
	await takeSnapshotEvent(dir, plan, {
		source: 'critic_approved',
		approvalMetadata: {
			verdict: 'APPROVED',
			source: 'plan_critic_gate',
		},
		payloadHashOverride: computePlanStructureHash(plan),
	});
}

describe('isPlanCriticApproved', () => {
	let dir: string;

	beforeEach(async () => {
		resetSwarmState();
		dir = await mkdtemp(join(tmpdir(), 'dg-approval-'));
	});

	afterEach(async () => {
		resetSwarmState();
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('returns false when no plan exists (no .swarm/plan.json)', async () => {
		await expect(isPlanCriticApproved(dir)).resolves.toBe(false);
	});

	test('returns false when plan exists but no approval snapshot', async () => {
		await writePlan(dir, makePlan());
		await expect(isPlanCriticApproved(dir)).resolves.toBe(false);
	});

	test('returns false when approval verdict is not APPROVED', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);

		// Write a non-APPROVED snapshot
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: {
				verdict: 'CONCERNS',
				source: 'plan_critic_gate',
			},
			payloadHashOverride: computePlanStructureHash(plan),
		});

		await expect(isPlanCriticApproved(dir)).resolves.toBe(false);
	});

	test('returns false when approval source is not plan_critic_gate', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);

		// Write a snapshot from an unrelated critic source
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: {
				verdict: 'APPROVED',
				source: 'drift_verifier',
			},
			payloadHashOverride: computePlanStructureHash(plan),
		});

		await expect(isPlanCriticApproved(dir)).resolves.toBe(false);
	});

	test('returns false when payloadHash does not match current plan structure', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);

		// Write a snapshot with a different (stale) payload hash
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: {
				verdict: 'APPROVED',
				source: 'plan_critic_gate',
			},
			payloadHashOverride: 'stale-hash-mismatch',
		});

		await expect(isPlanCriticApproved(dir)).resolves.toBe(false);
	});

	test('returns true when all checks pass', async () => {
		const plan = makePlan();
		await writePlan(dir, plan);
		await recordPlanCriticSnapshot(dir, plan);

		await expect(isPlanCriticApproved(dir)).resolves.toBe(true);
	});

	test('returns false (fail-closed) when an exception occurs', async () => {
		// Pass a nonexistent directory to trigger filesystem errors
		await expect(
			isPlanCriticApproved(join(dir, 'nonexistent-path')),
		).resolves.toBe(false);
	});
});
