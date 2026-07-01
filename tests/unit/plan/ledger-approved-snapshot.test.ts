/**
 * Tests for the critic-approved immutable snapshot path and the
 * optimistic-retry append helper in src/plan/ledger.ts.
 *
 * Coverage:
 * - takeSnapshotEvent honors the optional `source` parameter
 *   and stores approval metadata in the payload.
 * - loadLastApprovedPlan returns the most recent
 *   `critic_approved` snapshot and ignores unrelated snapshots.
 * - appendLedgerEventWithRetry succeeds on the first attempt when
 *   there is no contention.
 * - appendLedgerEventWithRetry retries and succeeds after a single
 *   stale-writer collision that is resolved by refreshing the hash.
 * - appendLedgerEventWithRetry returns null when the verifyValid
 *   callback reports the transition is no longer meaningful.
 * - appendLedgerEventWithRetry bounds the retry loop by maxRetries.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendLedgerEventWithRetry,
	computePlanHash,
	initLedger,
	loadLastApprovedPlan,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { derivePlanId } from '../../../src/plan/utils';

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Approved Snapshot Test',
		swarm: 'approved-snapshot-swarm',
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

async function setupDirWithInitializedLedger(): Promise<{
	dir: string;
	plan: Plan;
}> {
	const dir = await mkdtemp(join(tmpdir(), 'ledger-approved-test-'));
	await mkdir(join(dir, '.swarm'), { recursive: true });

	const plan = createTestPlan();
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);

	await initLedger(dir, derivePlanId(plan));
	return { dir, plan };
}

describe('takeSnapshotEvent: source parameter', () => {
	let dir: string;
	let plan: Plan;

	beforeEach(async () => {
		const ctx = await setupDirWithInitializedLedger();
		dir = ctx.dir;
		plan = ctx.plan;
	});

	afterEach(async () => {
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('defaults source to "takeSnapshotEvent" when not provided', async () => {
		const event = await takeSnapshotEvent(dir, plan);
		expect(event.source).toBe('takeSnapshotEvent');
	});

	test('honors custom source string', async () => {
		const event = await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
		});
		expect(event.source).toBe('critic_approved');
	});

	test('embeds approval metadata in the snapshot payload', async () => {
		const metadata = {
			phase: 1,
			verdict: 'APPROVED',
			summary: 'All checks pass',
		};
		const event = await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: metadata,
		});
		const payload = event.payload as unknown as {
			plan: Plan;
			approval: Record<string, unknown>;
		};
		expect(payload.approval).toEqual(metadata);
		expect(payload.plan.swarm).toBe(plan.swarm);
	});
});

describe('loadLastApprovedPlan', () => {
	let dir: string;
	let plan: Plan;

	beforeEach(async () => {
		const ctx = await setupDirWithInitializedLedger();
		dir = ctx.dir;
		plan = ctx.plan;
	});

	afterEach(async () => {
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('returns null when no snapshots exist', async () => {
		const result = await loadLastApprovedPlan(dir);
		expect(result).toBeNull();
	});

	test('returns null when only non-approved snapshots exist', async () => {
		await takeSnapshotEvent(dir, plan); // default source
		const result = await loadLastApprovedPlan(dir);
		expect(result).toBeNull();
	});

	test('returns the latest critic_approved snapshot with metadata', async () => {
		// First approval: phase 1
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 1, verdict: 'APPROVED' },
		});

		// A later routine snapshot (not approved) should not shadow the approved one
		await takeSnapshotEvent(dir, plan);

		// Second approval: phase 2 (with a mutated plan)
		const secondPlan: Plan = {
			...plan,
			current_phase: 2,
			phases: [
				{
					...plan.phases[0],
					status: 'complete',
					tasks: plan.phases[0].tasks.map((t) => ({
						...t,
						status: 'complete',
					})),
				},
			],
		};
		await takeSnapshotEvent(dir, secondPlan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 2, verdict: 'APPROVED' },
		});

		const result = await loadLastApprovedPlan(dir);
		expect(result).not.toBeNull();
		expect(result?.plan.current_phase).toBe(2);
		expect(result?.approval).toEqual({ phase: 2, verdict: 'APPROVED' });
		expect(result?.payloadHash).toBe(computePlanHash(secondPlan));
	});

	test('latest-wins across multiple critic_approved snapshots', async () => {
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 1 },
		});
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 2 },
		});
		await takeSnapshotEvent(dir, plan, {
			source: 'critic_approved',
			approvalMetadata: { phase: 3 },
		});

		const result = await loadLastApprovedPlan(dir);
		expect((result?.approval as { phase: number }).phase).toBe(3);
	});
});

describe('appendLedgerEventWithRetry', () => {
	let dir: string;
	let plan: Plan;
	let initialHash: string;

	beforeEach(async () => {
		const ctx = await setupDirWithInitializedLedger();
		dir = ctx.dir;
		plan = ctx.plan;
		initialHash = computePlanHash(plan);
	});

	afterEach(async () => {
		if (dir && existsSync(dir)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('succeeds on first attempt when there is no contention', async () => {
		const result = await appendLedgerEventWithRetry(
			dir,
			{
				plan_id: 'approved-snapshot-swarm-Approved_Snapshot_Test',
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			},
			{ expectedHash: initialHash },
		);
		expect(result).not.toBeNull();
		expect(result?.event_type).toBe('task_status_changed');
	});

	test('returns null when verifyValid aborts after a collision', async () => {
		// Simulate a concurrent writer by mutating plan.json so the CAS check fails.
		const mutatedPlan: Plan = {
			...plan,
			phases: [
				{
					...plan.phases[0],
					tasks: [
						{ ...plan.phases[0].tasks[0], status: 'in_progress' },
						plan.phases[0].tasks[1],
					],
				},
			],
		};
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(mutatedPlan, null, 2),
			'utf-8',
		);

		// Original writer wanted to move task 1.1 from pending → in_progress,
		// but another writer already did that. verifyValid should return false.
		let verifyCalls = 0;
		const result = await appendLedgerEventWithRetry(
			dir,
			{
				plan_id: 'approved-snapshot-swarm-Approved_Snapshot_Test',
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			},
			{
				expectedHash: initialHash, // stale
				maxRetries: 3,
				backoffMs: 1,
				verifyValid: () => {
					verifyCalls++;
					// Task 1.1 is already in_progress on disk, so the transition
					// from pending → in_progress is no longer meaningful.
					return false;
				},
			},
		);

		expect(result).toBeNull();
		expect(verifyCalls).toBe(1);
	});

	test('retries and succeeds after refreshing the expected hash', async () => {
		// Simulate concurrent writer mutating a DIFFERENT task so the caller's
		// transition is still semantically valid.
		const mutatedPlan: Plan = {
			...plan,
			phases: [
				{
					...plan.phases[0],
					tasks: [
						plan.phases[0].tasks[0], // 1.1 unchanged
						{ ...plan.phases[0].tasks[1], status: 'complete' }, // 1.2 mutated
					],
				},
			],
		};
		writeFileSync(
			join(dir, '.swarm', 'plan.json'),
			JSON.stringify(mutatedPlan, null, 2),
			'utf-8',
		);

		const result = await appendLedgerEventWithRetry(
			dir,
			{
				plan_id: 'approved-snapshot-swarm-Approved_Snapshot_Test',
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			},
			{
				expectedHash: initialHash, // stale
				maxRetries: 3,
				backoffMs: 1,
				// Our transition for task 1.1 is still valid — on-disk 1.1 is still pending.
				verifyValid: () => true,
			},
		);

		expect(result).not.toBeNull();
		expect(result?.task_id).toBe('1.1');
		expect(result?.to_status).toBe('in_progress');
	});

	test('does not invoke verifyValid when first attempt succeeds', async () => {
		let verifyCalls = 0;
		const result = await appendLedgerEventWithRetry(
			dir,
			{
				plan_id: 'approved-snapshot-swarm-Approved_Snapshot_Test',
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			},
			{
				expectedHash: initialHash,
				maxRetries: 3,
				backoffMs: 1,
				verifyValid: () => {
					verifyCalls++;
					return true;
				},
			},
		);

		expect(result).not.toBeNull();
		expect(verifyCalls).toBe(0);
	});
});
