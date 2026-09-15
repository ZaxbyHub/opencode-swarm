import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeProjectDb } from '../../../src/db/project-db';
import {
	computePlanLedgerHash,
	initLedger,
	replacePlanLedgerWithRoot,
} from '../../../src/plan/ledger';
import {
	cutoverSqliteLedger,
	getPlanLedgerState,
} from '../../../src/plan/ledger-sqlite';
import { PlanRecoverySupersededError } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makePlan(title = 'Ledger predicate propagation'): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'ledger-predicate-propagation-2668',
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
						description: 'Keep typed authority failures visible',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

describe('ledger recovery predicate propagation (#2668)', () => {
	let directory = '';

	beforeEach(async () => {
		directory = canonicalMkdtemp('ledger-predicate-propagation-2668-');
		await mkdir(path.join(directory, '.swarm'), { recursive: true });
		await mkdir(path.join(directory, '.git'));
	});

	afterEach(async () => {
		closeProjectDb(directory);
		await rm(directory, { recursive: true, force: true });
	});

	async function seedLedger(): Promise<{ plan: Plan; ledgerPath: string }> {
		const plan = makePlan();
		await writeFile(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
			'utf8',
		);
		await initLedger(
			directory,
			derivePlanId(plan),
			computePlanLedgerHash(plan),
			plan,
		);
		return {
			plan,
			ledgerPath: path.join(directory, '.swarm', 'plan-ledger.jsonl'),
		};
	}

	test('initLedger does not swallow supersession in optional SQLite shadow catch', async () => {
		const { plan: originalPlan, ledgerPath } = await seedLedger();
		await unlink(ledgerPath);
		const sqlitePlanIdBefore = getPlanLedgerState(directory)?.planId;
		const newPlan = makePlan('New init root');
		const observedPlanIds: Array<string | null> = [];
		const superseded = new PlanRecoverySupersededError('new authority');

		await expect(
			initLedger(
				directory,
				derivePlanId(newPlan),
				computePlanLedgerHash(newPlan),
				newPlan,
				{
					preCommitCheck: () => {
						const lines = fs.existsSync(ledgerPath)
							? fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
							: [];
						observedPlanIds.push(
							lines.length > 0
								? (JSON.parse(lines[0]!) as { plan_id: string }).plan_id
								: null,
						);
						if (observedPlanIds.length === 2) throw superseded;
					},
				},
			),
		).rejects.toBe(superseded);
		// The first fence is before canonical publication; the second observes
		// the new root after its atomic rename but before the SQLite shadow commit.
		expect(observedPlanIds).toEqual([null, derivePlanId(newPlan)]);
		expect(fs.existsSync(ledgerPath)).toBe(true);
		expect(getPlanLedgerState(directory)?.planId).toBe(sqlitePlanIdBefore);
		expect(sqlitePlanIdBefore).toBe(derivePlanId(originalPlan));
	});

	test('replacePlanLedgerWithRoot does not swallow supersession before SQLite shadow publication', async () => {
		const { plan, ledgerPath } = await seedLedger();
		const before = await readFile(ledgerPath, 'utf8');
		const newPlan = makePlan('Replacement root');
		const sqlitePlanIdBefore = getPlanLedgerState(directory)?.planId;
		const observedPlanIds: string[] = [];
		const superseded = new PlanRecoverySupersededError('new authority');

		await expect(
			replacePlanLedgerWithRoot(directory, newPlan, 'test-recovery', {
				preCommitCheck: () => {
					const line = fs.readFileSync(ledgerPath, 'utf8').trim();
					observedPlanIds.push(
						(JSON.parse(line) as { plan_id: string }).plan_id,
					);
					if (observedPlanIds.length === 3) throw superseded;
				},
			}),
		).rejects.toBe(superseded);
		// Both pre-archive and pre-file-publication fences see the old root; the
		// third fence sees the replacement export before SQLite shadow publication.
		expect(observedPlanIds).toEqual([
			derivePlanId(plan),
			derivePlanId(plan),
			derivePlanId(newPlan),
		]);
		expect(await readFile(ledgerPath, 'utf8')).not.toBe(before);
		expect(getPlanLedgerState(directory)?.planId).toBe(sqlitePlanIdBefore);
		expect(sqlitePlanIdBefore).toBe(derivePlanId(plan));
	});

	test('SQLite-authoritative export fence propagates supersession outside its catch', async () => {
		const { plan, ledgerPath } = await seedLedger();
		const state = getPlanLedgerState(directory);
		if (!state) throw new Error('fixture did not initialize SQLite state');
		cutoverSqliteLedger(directory, {
			expectedShadowStartedVersion: state.shadowStartedVersion ?? undefined,
		});
		const before = await readFile(ledgerPath, 'utf8');
		let checks = 0;
		const superseded = new PlanRecoverySupersededError('new authority');

		await expect(
			replacePlanLedgerWithRoot(directory, plan, 'test-recovery', {
				preCommitCheck: () => {
					checks++;
					if (checks === 2) throw superseded;
				},
			}),
		).rejects.toBe(superseded);
		expect(checks).toBe(2);
		expect(await readFile(ledgerPath, 'utf8')).toBe(before);
	});
});
