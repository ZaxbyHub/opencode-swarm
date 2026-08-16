import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	computePlanHash,
	getOrAdoptPlanEpochUnderLock,
	LEDGER_SCHEMA_VERSION,
	type LedgerEvent,
	readLedgerEvents,
	readPlanEpochIdentity,
	replayFromLedger,
} from '../../../src/plan/ledger';
import { derivePlanId, derivePlanIdentityHash } from '../../../src/plan/utils';

function makePlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Ledger Epoch Adoption Test',
		swarm: 'ledger-epoch-adoption',
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
	};
}

function eventHash(event: LedgerEvent): string {
	return createHash('sha256')
		.update(JSON.stringify(event), 'utf8')
		.digest('hex');
}

async function createLegacyLedger(plan: Plan): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'ledger-plan-epoch-adopt-'));
	await mkdir(join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf8',
	);

	const rootEvent: LedgerEvent = {
		seq: 1,
		timestamp: '2026-08-16T00:00:00.000Z',
		plan_id: derivePlanId(plan),
		event_type: 'plan_created',
		source: 'legacy-init',
		plan_hash_before: '',
		plan_hash_after: computePlanHash(plan),
		schema_version: LEDGER_SCHEMA_VERSION,
		payload: {
			plan,
			payload_hash: computePlanHash(plan),
		},
	};
	fs.writeFileSync(
		join(directory, '.swarm', 'plan-ledger.jsonl'),
		`${JSON.stringify(rootEvent)}\n`,
		'utf8',
	);
	return directory;
}

function appendRawLedgerEvent(directory: string, event: LedgerEvent): void {
	fs.appendFileSync(
		join(directory, '.swarm', 'plan-ledger.jsonl'),
		`${JSON.stringify(event)}\n`,
		'utf8',
	);
}

describe('legacy ledger plan epoch adoption', () => {
	let directory = '';
	let plan: Plan;

	beforeEach(() => {
		plan = makePlan();
	});

	afterEach(async () => {
		_internals.readLedgerEvents = readLedgerEvents;
		if (directory) {
			await rm(directory, { recursive: true, force: true });
			directory = '';
		}
	});

	test('adopts exactly one backward-readable snapshot and stays replay-neutral', async () => {
		directory = await createLegacyLedger(plan);
		const beforeReplay = await replayFromLedger(directory);

		const identity = await getOrAdoptPlanEpochUnderLock(directory, plan);
		const events = await readLedgerEvents(directory);
		const adoption = events.find(
			(event) => event.source === 'plan_epoch_adopted',
		);
		const payload = adoption?.payload as Record<string, unknown> | undefined;
		const afterReplay = await replayFromLedger(directory);

		expect(identity.planId).toBe(derivePlanId(plan));
		expect(identity.planIdentityHash).toBe(derivePlanIdentityHash(plan));
		expect(identity.source).toBe('plan_epoch_adopted');
		expect(adoption?.event_type).toBe('snapshot');
		expect(payload?.plan).toEqual(plan);
		expect(payload?.payload_hash).toBe(computePlanHash(plan));
		expect(payload?.plan_epoch).toBe(identity.planEpoch);
		expect(payload?.root_event_hash).toBe(identity.rootEventHash);
		expect(afterReplay).toEqual(beforeReplay);
	});

	test('readPlanEpochIdentity returns null for a legacy ledger and does not append adoption metadata', async () => {
		directory = await createLegacyLedger(plan);
		const ledgerPath = join(directory, '.swarm', 'plan-ledger.jsonl');
		const before = fs.readFileSync(ledgerPath, 'utf8');

		const identity = await readPlanEpochIdentity(directory, plan);

		expect(identity).toBeNull();
		expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(before);
	});

	test('concurrent adopters append exactly one snapshot and agree on the same epoch', async () => {
		directory = await createLegacyLedger(plan);

		const results = await Promise.all(
			Array.from({ length: 3 }, () =>
				getOrAdoptPlanEpochUnderLock(directory, plan),
			),
		);
		const events = await readLedgerEvents(directory);
		const adoptions = events.filter(
			(event) => event.source === 'plan_epoch_adopted',
		);

		expect(adoptions).toHaveLength(1);
		expect(new Set(results.map((result) => result.planEpoch)).size).toBe(1);
		expect(new Set(results.map((result) => result.rootEventHash)).size).toBe(1);
	});

	test('conflicting duplicate adoption metadata fails closed without appending more events', async () => {
		directory = await createLegacyLedger(plan);
		const root = (await readLedgerEvents(directory))[0]!;
		const rootHash = eventHash(root);

		appendRawLedgerEvent(directory, {
			seq: 2,
			timestamp: '2026-08-16T00:00:01.000Z',
			plan_id: derivePlanId(plan),
			event_type: 'snapshot',
			source: 'plan_epoch_adopted',
			plan_hash_before: computePlanHash(plan),
			plan_hash_after: computePlanHash(plan),
			schema_version: LEDGER_SCHEMA_VERSION,
			payload: {
				plan,
				payload_hash: computePlanHash(plan),
				plan_epoch: '11111111-1111-4111-8111-111111111111',
				root_event_hash: rootHash,
			},
		});
		const beforeEvents = await readLedgerEvents(directory);

		appendRawLedgerEvent(directory, {
			seq: 3,
			timestamp: '2026-08-16T00:00:02.000Z',
			plan_id: derivePlanId(plan),
			event_type: 'snapshot',
			source: 'plan_epoch_adopted',
			plan_hash_before: computePlanHash(plan),
			plan_hash_after: computePlanHash(plan),
			schema_version: LEDGER_SCHEMA_VERSION,
			payload: {
				plan,
				payload_hash: computePlanHash(plan),
				plan_epoch: '22222222-2222-4222-8222-222222222222',
				root_event_hash: rootHash,
			},
		});

		await expect(getOrAdoptPlanEpochUnderLock(directory, plan)).rejects.toThrow(
			/plan epoch/i,
		);
		const afterEvents = await readLedgerEvents(directory);
		expect(afterEvents).toHaveLength(beforeEvents.length + 1);
		expect(
			afterEvents.filter((event) => event.source === 'plan_epoch_adopted'),
		).toHaveLength(2);
	});

	test('rejects a valid-looking adoption hash that does not bind to the canonical root', async () => {
		directory = await createLegacyLedger(plan);
		appendRawLedgerEvent(directory, {
			seq: 2,
			timestamp: '2026-08-16T00:00:01.000Z',
			plan_id: derivePlanId(plan),
			event_type: 'snapshot',
			source: 'plan_epoch_adopted',
			plan_hash_before: computePlanHash(plan),
			plan_hash_after: computePlanHash(plan),
			schema_version: LEDGER_SCHEMA_VERSION,
			payload: {
				plan,
				payload_hash: computePlanHash(plan),
				plan_epoch: '11111111-1111-4111-8111-111111111111',
				root_event_hash: 'a'.repeat(64),
			},
		});

		await expect(readPlanEpochIdentity(directory, plan)).rejects.toThrow(
			/canonical ledger root/i,
		);
	});

	test('rejects when append read-verification cannot confirm the appended adoption snapshot', async () => {
		directory = await createLegacyLedger(plan);
		const realReadLedgerEvents = readLedgerEvents;
		let readCount = 0;
		_internals.readLedgerEvents = async (worktree: string) => {
			readCount += 1;
			const events = await realReadLedgerEvents(worktree);
			if (readCount < 2 || events.length === 0) {
				return events;
			}
			const corruptedTail = {
				...events[events.length - 1]!,
				payload: {
					...((events[events.length - 1]!.payload as Record<string, unknown>) ??
						{}),
					plan_epoch: 'corrupted-after-append',
				},
			};
			return [...events.slice(0, -1), corruptedTail];
		};

		await expect(getOrAdoptPlanEpochUnderLock(directory, plan)).rejects.toThrow(
			/read verification/i,
		);
	});
});
