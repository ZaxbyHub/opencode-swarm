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

	test('a schema-invalid newest snapshot is skipped; an older valid snapshot is served', async () => {
		// #2531 feedback: the critic-approved-snapshot rung must schema-validate
		// the embedded plan exactly like the sibling recovery rungs. A newest
		// snapshot whose plan is schema-invalid is skipped (with a warning) and
		// the scan continues to older history instead of serving an
		// unvalidated plan.
		await seedDonor();
		const ledgerPath = join(donor, '.swarm', 'plan-ledger.jsonl');
		const lines = readFileSync(ledgerPath, 'utf8')
			.split('\n')
			.filter((line) => line.trim() !== '');
		const newest = JSON.parse(lines[lines.length - 1]) as {
			seq: number;
			payload: { plan: unknown; payload_hash: string };
		};
		const degraded = {
			...newest,
			seq: newest.seq + 1,
			payload: {
				...newest.payload,
				// Schema-invalid but JSON-valid: wrong schema_version.
				plan: { ...(newest.payload.plan as object), schema_version: '9.9.9' },
			},
		};
		await writeFile(
			join(healthy, '.swarm', 'plan-ledger.jsonl'),
			`${lines.join('\n')}\n${JSON.stringify(degraded)}\n`,
			'utf8',
		);

		const approved = await loadLastApprovedPlan(healthy);
		expect(approved?.plan.title).toBe('Approved on verified prefix');
		const gateApproved = await loadLastPlanCriticApprovedSnapshot(healthy);
		expect(gateApproved?.plan.title).toBe('Approved on verified prefix');
	});

	test('a schema-invalid snapshot with no valid fallback is NOT served', async () => {
		await seedDonor();
		const ledgerPath = join(donor, '.swarm', 'plan-ledger.jsonl');
		const lines = readFileSync(ledgerPath, 'utf8')
			.split('\n')
			.filter((line) => line.trim() !== '');
		const newest = JSON.parse(lines[lines.length - 1]) as {
			seq: number;
			payload: { plan: unknown };
		};
		const degraded = {
			...newest,
			seq: newest.seq + 1,
			payload: {
				...newest.payload,
				plan: { ...(newest.payload.plan as object), schema_version: '9.9.9' },
			},
		};
		// Replace the valid snapshot with only the degraded one.
		await writeFile(
			join(healthy, '.swarm', 'plan-ledger.jsonl'),
			`${lines[0]}\n${JSON.stringify(degraded)}\n`,
			'utf8',
		);

		await expect(loadLastApprovedPlan(healthy)).resolves.toBeNull();
		await expect(
			loadLastPlanCriticApprovedSnapshot(healthy),
		).resolves.toBeNull();
	});
});
