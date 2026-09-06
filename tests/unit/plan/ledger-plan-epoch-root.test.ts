import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	appendLedgerEvent,
	computePlanLedgerHash,
	getOrAdoptPlanEpochUnderLock,
	initLedger,
	readLedgerEvents,
	readPlanEpochIdentity,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { derivePlanId, derivePlanIdentityHash } from '../../../src/plan/utils';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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
	const directory = canonicalMkdtemp('ledger-plan-epoch-root-');
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
		expect(identity.payloadHash).toBe(computePlanLedgerHash(plan));
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
				computePlanLedgerHash(plan),
				plan,
			);
			await initLedger(
				directoryB,
				derivePlanId(plan),
				computePlanLedgerHash(plan),
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
			computePlanLedgerHash(plan),
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
			{ planHashAfter: computePlanLedgerHash(plan) },
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

describe('readPlanEpochIdentity fails closed on an unreadable ledger', () => {
	const cleanup = new Set<string>();
	let restoreReadFileSync: (() => void) | null = null;

	afterEach(async () => {
		restoreReadFileSync?.();
		restoreReadFileSync = null;
		for (const directory of cleanup) {
			await rm(directory, { recursive: true, force: true });
		}
		cleanup.clear();
	});

	async function createPopulatedLedger(plan: Plan): Promise<string> {
		const directory = await createWorkspace(plan);
		cleanup.add(directory);
		await initLedger(
			directory,
			derivePlanId(plan),
			computePlanLedgerHash(plan),
			plan,
		);
		await appendLedgerEvent(
			directory,
			{
				plan_id: derivePlanId(plan),
				event_type: 'plan_exported',
				source: 'unreadable-ledger-test',
			},
			{ planHashAfter: computePlanLedgerHash(plan) },
		);
		return directory;
	}

	function failLedgerReadsWith(code: string, ledgerPath: string): void {
		const realReadFileSync = fs.readFileSync;
		// Only the ledger file is unreadable; the file still EXISTS on disk, so
		// fs.existsSync is deliberately left untouched.
		const spy = spyOn(fs, 'readFileSync').mockImplementation(((
			target: unknown,
			...rest: unknown[]
		) => {
			if (typeof target === 'string' && resolve(target) === ledgerPath) {
				const error = new Error(
					`${code}: permission denied, open '${ledgerPath}'`,
				) as NodeJS.ErrnoException;
				error.code = code;
				throw error;
			}
			return (realReadFileSync as (...args: unknown[]) => unknown)(
				target,
				...rest,
			);
		}) as unknown as typeof fs.readFileSync);
		restoreReadFileSync = () => {
			spy.mockRestore();
		};
	}

	test('surfaces PLAN_LEDGER_UNREADABLE, not "Plan ledger is empty"', async () => {
		const plan = makePlan();
		const directory = await createPopulatedLedger(plan);
		const ledgerPath = resolve(join(directory, '.swarm', 'plan-ledger.jsonl'));
		expect(fs.existsSync(ledgerPath)).toBe(true);

		failLedgerReadsWith('EACCES', ledgerPath);

		let caught: unknown;
		try {
			await readPlanEpochIdentity(directory, plan);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		const message = (caught as Error).message;
		expect(message).toMatch(/PLAN_LEDGER_UNREADABLE/);
		expect(message).not.toContain('Plan ledger is empty');
	});

	test('a missing portable ledger is restored from the verified SQLite shadow', async () => {
		const plan = makePlan();
		const directory = await createPopulatedLedger(plan);
		const ledgerPath = resolve(join(directory, '.swarm', 'plan-ledger.jsonl'));
		fs.rmSync(ledgerPath, { force: true });

		const identity = await readPlanEpochIdentity(directory, plan);
		expect(identity).not.toBeNull();
		expect(identity?.planId).toBe(derivePlanId(plan));
		expect(fs.existsSync(ledgerPath)).toBe(true);
	});
});
