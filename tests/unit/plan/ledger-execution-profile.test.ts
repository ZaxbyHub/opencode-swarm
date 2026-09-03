/**
 * Tests for execution_profile ledger events:
 * - execution_profile_set replay applies profile to plan
 * - execution_profile_locked replay locks the profile
 * - computePlanLedgerHash covers execution_profile
 * - full ledger replay round-trip with profile events
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendLedgerEvent,
	computePlanLedgerHash,
	initLedger,
	readLedgerEvents,
	replayFromLedger,
} from '../../../src/plan/ledger';

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Execution Profile Test',
		swarm: 'ep-swarm',
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
				],
			},
		],
		...overrides,
	};
}

async function setupDir(): Promise<{ dir: string; plan: Plan }> {
	const dir = await mkdtemp(join(tmpdir(), 'ledger-ep-test-'));
	await mkdir(join(dir, '.swarm'), { recursive: true });
	const plan = createTestPlan();
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await initLedger(
		dir,
		'ep-swarm-Execution_Profile_Test',
		computePlanLedgerHash(plan),
		plan,
	);
	return { dir, plan };
}

let dir: string;

beforeEach(async () => {
	({ dir } = await setupDir());
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('computePlanLedgerHash covers execution_profile', () => {
	test('hash changes when execution_profile is added', () => {
		const plan = createTestPlan();
		const hashWithout = computePlanLedgerHash(plan);
		const planWithProfile = createTestPlan({
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 4,
				council_parallel: false,
				locked: false,
			},
		});
		const hashWith = computePlanLedgerHash(planWithProfile);
		expect(hashWith).not.toBe(hashWithout);
	});

	test('hash changes when locked field changes', () => {
		const plan = createTestPlan({
			execution_profile: {
				parallelization_enabled: false,
				max_concurrent_tasks: 1,
				council_parallel: false,
				locked: false,
			},
		});
		const hashUnlocked = computePlanLedgerHash(plan);
		const planLocked = createTestPlan({
			execution_profile: {
				parallelization_enabled: false,
				max_concurrent_tasks: 1,
				council_parallel: false,
				locked: true,
			},
		});
		const hashLocked = computePlanLedgerHash(planLocked);
		expect(hashLocked).not.toBe(hashUnlocked);
	});

	test('identical plans produce identical hashes', () => {
		const plan = createTestPlan({
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				council_parallel: true,
				locked: false,
			},
		});
		expect(computePlanLedgerHash(plan)).toBe(computePlanLedgerHash(plan));
	});
});

describe('execution_profile_set event replay', () => {
	test('applying execution_profile_set sets the profile on the replayed plan', async () => {
		const plan = createTestPlan();
		const planId = 'ep-swarm-Execution_Profile_Test';
		const profile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 4,
			council_parallel: false,
			locked: false,
		};

		await appendLedgerEvent(
			dir,
			{
				event_type: 'execution_profile_set',
				source: 'save_plan',
				plan_id: planId,
				payload: { execution_profile: profile },
			},
			{
				planHashAfter: computePlanLedgerHash({
					...plan,
					execution_profile: profile,
				}),
			},
		);

		const events = await readLedgerEvents(dir);
		const profileSetEvents = events.filter(
			(e) => e.event_type === 'execution_profile_set',
		);
		expect(profileSetEvents).toHaveLength(1);
		expect(profileSetEvents[0].payload?.execution_profile).toEqual(profile);
	});

	test('replayFromLedger applies execution_profile_set', async () => {
		const plan = createTestPlan();
		const planId = 'ep-swarm-Execution_Profile_Test';
		const profile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 3,
			council_parallel: false,
			locked: false,
			auto_proceed: true,
			commit_after_each_completed_task: true,
		};

		await appendLedgerEvent(
			dir,
			{
				event_type: 'execution_profile_set',
				source: 'save_plan',
				plan_id: planId,
				payload: { execution_profile: profile },
			},
			{
				planHashAfter: computePlanLedgerHash({
					...plan,
					execution_profile: profile,
				}),
			},
		);

		const replayed = await replayFromLedger(dir);
		expect(replayed).not.toBeNull();
		expect(replayed?.execution_profile?.parallelization_enabled).toBe(true);
		expect(replayed?.execution_profile?.max_concurrent_tasks).toBe(3);
		expect(replayed?.execution_profile?.auto_proceed).toBe(true);
		expect(replayed?.execution_profile?.commit_after_each_completed_task).toBe(
			true,
		);
	});

	test('execution_profile_set with malformed payload is ignored (no crash)', async () => {
		const plan = createTestPlan();
		const planId = 'ep-swarm-Execution_Profile_Test';

		await appendLedgerEvent(
			dir,
			{
				event_type: 'execution_profile_set',
				source: 'save_plan',
				plan_id: planId,
				payload: {
					execution_profile: {
						parallelization_enabled: 'INVALID',
						max_concurrent_tasks: -999,
					},
				},
			},
			{ planHashAfter: computePlanLedgerHash(plan) },
		);

		// Replay should not crash and should return plan unchanged (no profile set)
		const replayed = await replayFromLedger(dir);
		expect(replayed).not.toBeNull();
		expect(replayed?.execution_profile).toBeUndefined();
	});
});

describe('execution_profile_locked event replay', () => {
	test('execution_profile_locked locks an existing profile', async () => {
		const plan = createTestPlan();
		const planId = 'ep-swarm-Execution_Profile_Test';
		const profile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			council_parallel: false,
			locked: false,
		};
		const profileLocked = { ...profile, locked: true };

		// Set profile first
		await appendLedgerEvent(
			dir,
			{
				event_type: 'execution_profile_set',
				source: 'save_plan',
				plan_id: planId,
				payload: { execution_profile: profile },
			},
			{
				planHashAfter: computePlanLedgerHash({
					...plan,
					execution_profile: profile,
				}),
			},
		);

		// Then lock it
		await appendLedgerEvent(
			dir,
			{
				event_type: 'execution_profile_locked',
				source: 'save_plan',
				plan_id: planId,
			},
			{
				planHashAfter: computePlanLedgerHash({
					...plan,
					execution_profile: profileLocked,
				}),
			},
		);

		const replayed = await replayFromLedger(dir);
		expect(replayed).not.toBeNull();
		expect(replayed?.execution_profile?.locked).toBe(true);
		expect(replayed?.execution_profile?.parallelization_enabled).toBe(true);
	});

	test('execution_profile_locked with no existing profile is a no-op', async () => {
		const plan = createTestPlan();
		const planId = 'ep-swarm-Execution_Profile_Test';

		// Lock without any prior profile set
		await appendLedgerEvent(
			dir,
			{
				event_type: 'execution_profile_locked',
				source: 'save_plan',
				plan_id: planId,
			},
			{ planHashAfter: computePlanLedgerHash(plan) },
		);

		const replayed = await replayFromLedger(dir);
		expect(replayed).not.toBeNull();
		// No profile was set, so execution_profile should remain absent
		expect(replayed?.execution_profile).toBeUndefined();
	});

	test('appended events are present in ledger', async () => {
		const plan = createTestPlan();
		const planId = 'ep-swarm-Execution_Profile_Test';
		const profile = {
			parallelization_enabled: false,
			max_concurrent_tasks: 1,
			council_parallel: false,
			locked: false,
		};

		await appendLedgerEvent(
			dir,
			{
				event_type: 'execution_profile_set',
				source: 'save_plan',
				plan_id: planId,
				payload: { execution_profile: profile },
			},
			{
				planHashAfter: computePlanLedgerHash({
					...plan,
					execution_profile: profile,
				}),
			},
		);

		await appendLedgerEvent(
			dir,
			{
				event_type: 'execution_profile_locked',
				source: 'save_plan',
				plan_id: planId,
			},
			{
				planHashAfter: computePlanLedgerHash({
					...plan,
					execution_profile: { ...profile, locked: true },
				}),
			},
		);

		const events = await readLedgerEvents(dir);
		const types = events.map((e) => e.event_type);
		expect(types).toContain('execution_profile_set');
		expect(types).toContain('execution_profile_locked');
	});
});

describe('LEDGER_EVENT_TYPES includes new events', () => {
	test('LEDGER_EVENT_TYPES array contains execution_profile_set', async () => {
		const { LEDGER_EVENT_TYPES } = await import('../../../src/plan/ledger');
		expect(LEDGER_EVENT_TYPES).toContain('execution_profile_set');
	});

	test('LEDGER_EVENT_TYPES array contains execution_profile_locked', async () => {
		const { LEDGER_EVENT_TYPES } = await import('../../../src/plan/ledger');
		expect(LEDGER_EVENT_TYPES).toContain('execution_profile_locked');
	});
});
