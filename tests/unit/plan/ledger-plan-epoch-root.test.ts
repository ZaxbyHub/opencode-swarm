import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendLedgerEvent,
	computePlanHash,
	getOrAdoptPlanEpochUnderLock,
	initLedger,
	readLedgerEvents,
	readPlanEpochIdentity,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { derivePlanId, derivePlanIdentityHash } from '../../../src/plan/utils';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';

function makePlan(overrides: Partial<Plan> = {}): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Ledger Epoch Root Test',
		swarm: 'ledger-epoch-root',
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

async function createWorkspace(plan: Plan): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'ledger-plan-epoch-root-'));
	await mkdir(join(directory, '.swarm'), { recursive: true });
	writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);
	return directory;
}

describe('ledger plan epoch root initialization', () => {
	const cleanup = new Set<string>();

	afterEach(async () => {
		for (const directory of cleanup) {
			await rm(directory, { recursive: true, force: true });
		}
		cleanup.clear();
	});

	test('initializes a missing ledger with a root plan_epoch and returns root identity', async () => {
		const plan = makePlan();
		const directory = await createWorkspace(plan);
		cleanup.add(directory);

		const identity = await getOrAdoptPlanEpochUnderLock(directory, plan);
		const events = await readLedgerEvents(directory);
		const payload = events[0]?.payload as Record<string, unknown> | undefined;

		expect(events).toHaveLength(1);
		expect(events[0]?.event_type).toBe('plan_created');
		expect(typeof payload?.plan_epoch).toBe('string');
		expect(payload?.plan_epoch).toBe(identity.planEpoch);
		expect(identity.planId).toBe(derivePlanId(plan));
		expect(identity.planIdentityHash).toBe(derivePlanIdentityHash(plan));
		expect(identity.payloadHash).toBe(computePlanHash(plan));
		expect(identity.rootEventHash).toHaveLength(64);
		expect(identity.source).toBe('root');
	});

	test('same-millisecond identical plan initializations still get different epochs', async () => {
		const restoreClock: Restore = freezeClock({
			isoNow: '2026-08-16T12:34:56.000Z',
		});
		try {
			const plan = makePlan();
			const directoryA = await createWorkspace(plan);
			const directoryB = await createWorkspace(plan);
			cleanup.add(directoryA);
			cleanup.add(directoryB);

			await initLedger(
				directoryA,
				derivePlanId(plan),
				computePlanHash(plan),
				plan,
			);
			await initLedger(
				directoryB,
				derivePlanId(plan),
				computePlanHash(plan),
				plan,
			);

			const epochA = (
				(await readLedgerEvents(directoryA))[0]?.payload as Record<
					string,
					unknown
				>
			)?.plan_epoch;
			const epochB = (
				(await readLedgerEvents(directoryB))[0]?.payload as Record<
					string,
					unknown
				>
			)?.plan_epoch;

			expect(typeof epochA).toBe('string');
			expect(typeof epochB).toBe('string');
			expect(epochA).not.toBe(epochB);
		} finally {
			restoreClock();
		}
	});

	test('root epoch stays stable across ordinary events, snapshots, and repeated reads', async () => {
		const plan = makePlan();
		const directory = await createWorkspace(plan);
		cleanup.add(directory);

		await initLedger(
			directory,
			derivePlanId(plan),
			computePlanHash(plan),
			plan,
		);

		const first = await getOrAdoptPlanEpochUnderLock(directory, plan);

		await appendLedgerEvent(
			directory,
			{
				plan_id: derivePlanId(plan),
				event_type: 'plan_exported',
				source: 'epoch-stability-test',
			},
			{ planHashAfter: computePlanHash(plan) },
		);
		await takeSnapshotEvent(directory, plan);

		const second = await getOrAdoptPlanEpochUnderLock(directory, plan);
		const third = await getOrAdoptPlanEpochUnderLock(directory, plan);

		expect(second.planEpoch).toBe(first.planEpoch);
		expect(second.rootEventHash).toBe(first.rootEventHash);
		expect(second.planIdentityHash).toBe(first.planIdentityHash);
		expect(third).toEqual(second);
	});

	test('readPlanEpochIdentity returns null for a missing ledger without creating one', async () => {
		const plan = makePlan();
		const directory = await createWorkspace(plan);
		cleanup.add(directory);

		const identity = await readPlanEpochIdentity(directory, plan);

		expect(identity).toBeNull();
		expect((await readLedgerEvents(directory)).length).toBe(0);
	});
});
