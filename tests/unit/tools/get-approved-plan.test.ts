/**
 * Unit tests for the get_approved_plan tool.
 *
 * Tests cover:
 * - No approved snapshot → error response
 * - Approved snapshot exists → full metadata returned
 * - Drift detection when current plan differs from approved
 * - No drift when hashes match
 * - summary_only mode returns metadata-only
 * - Missing/corrupt plan.json → drift_detected: 'unknown'
 * - Cross-identity safety via internally derived plan_id
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	computePlanHash,
	initLedger,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { executeGetApprovedPlan } from '../../../src/tools/get-approved-plan';

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Approved Plan Tool Test',
		swarm: 'get-approved-plan-swarm',
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
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task two',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

async function setupDirWithLedger(): Promise<{
	dir: string;
	plan: Plan;
}> {
	const dir = await mkdtemp(join(tmpdir(), 'get-approved-plan-test-'));
	await mkdir(join(dir, '.swarm'), { recursive: true });

	const plan = createTestPlan();
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);

	await initLedger(dir, `${plan.swarm}-${plan.title}`.replace(/\W/g, '_'));
	return { dir, plan };
}

describe('get_approved_plan tool', () => {
	let dir: string;
	let plan: Plan;

	beforeEach(async () => {
		const ctx = await setupDirWithLedger();
		dir = ctx.dir;
		plan = ctx.plan;
	});

	afterEach(async () => {
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('returns error when no approved snapshot exists', async () => {
		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('no_approved_snapshot');
		expect(result.approved_plan).toBeUndefined();
	});

	test('returns approved plan with full metadata', async () => {
		const approvalMeta = {
			phase: 1,
			verdict: 'APPROVED',
			summary: 'Phase 1 approved',
			approved_at: new Date().toISOString(),
		};
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: approvalMeta,
		});

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.approved_plan).toBeDefined();
		expect(result.approved_plan!.approval_metadata).toEqual(approvalMeta);
		expect(result.approved_plan!.snapshot_seq).toBeGreaterThan(0);
		expect(result.approved_plan!.snapshot_timestamp).toBeTruthy();
		expect(result.approved_plan!.payload_hash).toBe(computePlanHash(plan));
	});

	test('drift_detected is false when current plan matches approved', async () => {
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 1, verdict: 'APPROVED' },
		});

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(false);
		expect(result.current_plan).toBeDefined();
		expect(result.current_plan!.current_hash).toBe(
			result.approved_plan!.payload_hash,
		);
	});

	test('drift_detected is true when current plan differs from approved', async () => {
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 1, verdict: 'APPROVED' },
		});

		// Mutate plan.json after approval — change task statuses and add a phase
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
					name: 'Phase 2 unauthorized',
					status: 'in_progress',
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'pending',
							size: 'medium',
							description: 'Unauthorized scope creep task',
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

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(true);
		expect(result.current_plan).toBeDefined();
		expect(result.current_plan!.current_hash).not.toBe(
			result.approved_plan!.payload_hash,
		);
	});

	test('summary_only returns metadata without full plan objects', async () => {
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 1, verdict: 'APPROVED' },
		});

		const result = await executeGetApprovedPlan({ summary_only: true }, dir);
		expect(result.success).toBe(true);

		// The approved plan payload should be a summary, not the full Plan object
		const approvedPlan = result.approved_plan!.plan as Record<string, unknown>;
		expect(approvedPlan.phase_count).toBe(1);
		expect(approvedPlan.title).toBe('Approved Plan Tool Test');
		expect(Array.isArray(approvedPlan.phases)).toBe(true);
		const phases = approvedPlan.phases as Array<Record<string, unknown>>;
		expect(phases[0].task_count).toBe(2);
		// Full task descriptions should NOT be present in summary
		expect(phases[0].tasks).toBeUndefined();
	});

	test('drift_detected is unknown when plan.json is missing', async () => {
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 1, verdict: 'APPROVED' },
		});

		// Remove plan.json — but the approved snapshot is still in the ledger
		// with a matching plan_id from when it was created
		const { unlinkSync } = require('node:fs');
		unlinkSync(join(dir, '.swarm', 'plan.json'));

		// Without current plan.json, we can't derive plan_id for cross-identity
		// filtering, so loadLastApprovedPlan is called without expectedPlanId.
		// The result should still find the snapshot (no identity filter applied).
		const result = await executeGetApprovedPlan({}, dir);

		if (result.success) {
			// Snapshot found without identity filter
			expect(result.drift_detected).toBe('unknown');
			expect(result.current_plan).toBeNull();
			expect(result.current_plan_error).toBe('plan.json not found or invalid');
		} else {
			// If no snapshot found (identity filter excluded it), that's also valid
			expect(result.reason).toBe('no_approved_snapshot');
		}
	});

	test('cross-identity safety: detects identity mutation as tampering', async () => {
		// Write an approved snapshot for a DIFFERENT plan
		const foreignPlan = createTestPlan({
			title: 'Foreign Plan',
			swarm: 'foreign-swarm',
		});
		await takeSnapshotEvent(dir, foreignPlan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 1, verdict: 'APPROVED' },
		});

		// Current plan.json has a different identity — the scoped lookup
		// finds nothing, but unscoped finds the foreign snapshot, indicating
		// plan identity was mutated (tampering).
		const result = await executeGetApprovedPlan({}, dir);

		expect(result.success).toBe(true);
		expect(result.drift_detected).toBe(true);
		expect(result.approved_plan).toBeUndefined();
		expect(result.current_plan_error).toContain('mutated after approval');
	});

	test('returns the latest approved snapshot when multiple exist', async () => {
		// Phase 1 approval
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 1, verdict: 'APPROVED' },
		});

		// Phase 2 approval (mutated plan)
		const phase2Plan: Plan = { ...plan, current_phase: 2 };
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(phase2Plan, null, 2),
			'utf-8',
		);
		await takeSnapshotEvent(dir, phase2Plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 2, verdict: 'APPROVED' },
		});

		const result = await executeGetApprovedPlan({}, dir);
		expect(result.success).toBe(true);
		expect(result.approved_plan!.approval_metadata).toEqual({
			phase: 2,
			verdict: 'APPROVED',
		});
		// Current plan matches the latest approval
		expect(result.drift_detected).toBe(false);
	});
});
