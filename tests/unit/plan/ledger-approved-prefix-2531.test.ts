import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	computePlanLedgerHash,
	initLedger,
	loadLastApprovedPlan,
	loadLastPlanCriticApprovedSnapshot,
	readLedgerEventsWithIntegrity,
	takeSnapshotEvent,
} from '../../../src/plan/ledger';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makePlan(title: string): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'approved-prefix-2531',
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
						description: 'Approved snapshot task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	} as Plan;
}

async function freshDir(tag: string): Promise<string> {
	const directory = canonicalMkdtemp(`approved-prefix-2531-${tag}-`);
	await mkdir(join(directory, '.swarm'), { recursive: true });
	await mkdir(join(directory, '.git'));
	resetStartupLedgerCheck();
	return directory;
}

async function cleanup(directory: string): Promise<void> {
	resetStartupLedgerCheck();
	try {
		await rm(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	} catch {
		/* best-effort on Windows swarm.db handles */
	}
}

describe('approved-snapshot reads are scoped to the verified prefix (#2531 AC7)', () => {
	let donor: string;
	let poisoned: string;
	let healthy: string;

	beforeEach(async () => {
		donor = await freshDir('donor');
		poisoned = await freshDir('poisoned');
		healthy = await freshDir('healthy');
	});

	afterEach(async () => {
		await cleanup(donor);
		await cleanup(poisoned);
		await cleanup(healthy);
	});

	async function seedDonor(): Promise<void> {
		const plan = makePlan('Approved on verified prefix');
		const planId = derivePlanId(plan);
		await initLedger(donor, planId, computePlanLedgerHash(plan), plan);
		await takeSnapshotEvent(donor, plan, {
			source: 'critic_approved',
			approvalMetadata: {
				phase: 1,
				verdict: 'APPROVE',
				summary: 'test',
				source: 'plan_critic_gate',
			},
		});
	}

	test('a critic_approved snapshot behind a poison line is NOT served', async () => {
		await seedDonor();
		const lines = readFileSync(
			join(donor, '.swarm', 'plan-ledger.jsonl'),
			'utf8',
		)
			.split('\n')
			.filter((line) => line.trim() !== '');
		await writeFile(
			join(poisoned, '.swarm', 'plan-ledger.jsonl'),
			`${lines[0]}\n{"poison": true, "not": "a ledger event"}\n${lines[1]}\n`,
			'utf8',
		);

		const integrity = await readLedgerEventsWithIntegrity(poisoned);
		expect(integrity.truncated).toBe(true);
		expect(integrity.events.length).toBe(1);

		await expect(loadLastApprovedPlan(poisoned)).resolves.toBeNull();
		await expect(
			loadLastPlanCriticApprovedSnapshot(poisoned),
		).resolves.toBeNull();
	});

	test('a critic_approved snapshot inside the verified prefix IS served', async () => {
		await seedDonor();
		const lines = readFileSync(
			join(donor, '.swarm', 'plan-ledger.jsonl'),
			'utf8',
		)
			.split('\n')
			.filter((line) => line.trim() !== '');
		await writeFile(
			join(healthy, '.swarm', 'plan-ledger.jsonl'),
			`${lines[0]}\n${lines[1]}\n`,
			'utf8',
		);

		const approved = await loadLastApprovedPlan(healthy);
		expect(approved?.plan.title).toBe('Approved on verified prefix');
		const gateApproved = await loadLastPlanCriticApprovedSnapshot(healthy);
		expect(gateApproved?.plan.title).toBe('Approved on verified prefix');
	});
});
