import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	type LedgerEvent,
	quarantineLedgerSuffix,
} from '../../../src/plan/ledger';
import {
	loadPlan,
	PlanRecoverySupersededError,
	regeneratePlanMarkdown,
	resetStartupLedgerCheck,
} from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makePlan(status: Plan['phases'][0]['tasks'][0]['status']): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Corrupt ledger quarantine supersession',
		swarm: 'quarantine-supersession-2668',
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
						status,
						size: 'small',
						description: 'Preserve the authoritative plan',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

function eventLine(event: LedgerEvent): string {
	return `${JSON.stringify(event)}\n`;
}

async function seedCorruptLedger(directory: string): Promise<{
	ledgerPath: string;
	planJsonPath: string;
}> {
	const authoritative = makePlan('completed');
	const prefixPlan = makePlan('pending');
	const planId = derivePlanId(authoritative);
	const swarmDir = path.join(directory, '.swarm');
	const planJsonPath = path.join(swarmDir, 'plan.json');
	const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');

	await writeFile(planJsonPath, JSON.stringify(authoritative, null, 2), 'utf8');
	await regeneratePlanMarkdown(directory, authoritative);

	const created: LedgerEvent = {
		seq: 1,
		timestamp: '2026-01-01T00:00:00.000Z',
		plan_id: planId,
		event_type: 'plan_created',
		source: 'test',
		plan_hash_before: '',
		plan_hash_after: 'H1',
		schema_version: '1.1.0',
		payload: { plan: prefixPlan, payload_hash: 'H1' },
	};
	const progress: LedgerEvent = {
		seq: 2,
		timestamp: '2026-01-01T00:00:01.000Z',
		plan_id: planId,
		event_type: 'task_status_changed',
		task_id: '1.1',
		from_status: 'pending',
		to_status: 'in_progress',
		source: 'test',
		plan_hash_before: 'H1',
		plan_hash_after: 'H2',
		schema_version: '1.1.0',
	};
	const postPoison: LedgerEvent = {
		seq: 4,
		timestamp: '2026-01-01T00:00:03.000Z',
		plan_id: planId,
		event_type: 'task_status_changed',
		task_id: '1.1',
		from_status: 'in_progress',
		to_status: 'completed',
		source: 'test',
		plan_hash_before: 'H2',
		plan_hash_after: 'SENTINEL_CORRUPT_LEDGER_HASH',
		schema_version: '1.1.0',
	};

	await writeFile(
		ledgerPath,
		eventLine(created) +
			eventLine(progress) +
			'{ POISON — integrity read must return this suffix\n' +
			eventLine(postPoison),
		'utf8',
	);
	return { ledgerPath, planJsonPath };
}

describe('loadPlan corrupt-ledger quarantine authority fence (#2668)', () => {
	let directory = '';

	beforeEach(async () => {
		directory = canonicalMkdtemp('quarantine-supersession-2668-');
		await mkdir(path.join(directory, '.swarm'), { recursive: true });
		await mkdir(path.join(directory, '.git'));
		resetStartupLedgerCheck();
	});

	afterEach(async () => {
		resetStartupLedgerCheck();
		await rm(directory, { recursive: true, force: true });
	});

	test('supersession after integrity read prevents quarantine publication', async () => {
		const { ledgerPath, planJsonPath } = await seedCorruptLedger(directory);
		const ledgerBefore = fs.readFileSync(ledgerPath, 'utf8');
		const planBefore = fs.readFileSync(planJsonPath, 'utf8');
		let checkCount = 0;
		const preCommitCheck = () => {
			checkCount++;
			// loadPlan checks at entry and before claiming startup authority. The
			// third check is the fence immediately after the async integrity read.
			if (checkCount === 3) {
				throw new PlanRecoverySupersededError(
					'hydration generation superseded',
				);
			}
		};

		await expect(
			loadPlan(directory, undefined, { preCommitCheck }),
		).rejects.toBeInstanceOf(PlanRecoverySupersededError);

		expect(checkCount).toBe(3);
		expect(
			fs
				.readdirSync(path.join(directory, '.swarm'))
				.filter((name) => name.startsWith('plan-ledger.quarantine.')),
		).toEqual([]);
		// The superseded recovery must not mutate or remove either authoritative
		// input while refusing the quarantine publication.
		expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);
		expect(fs.readFileSync(planJsonPath, 'utf8')).toBe(planBefore);
	});

	test('quarantine propagates typed supersession before its side-file write', async () => {
		const superseded = new PlanRecoverySupersededError('newer authority won');
		await expect(
			quarantineLedgerSuffix(directory, '{ POISON\n', {
				preCommitCheck: () => {
					throw superseded;
				},
			}),
		).rejects.toBe(superseded);

		expect(
			fs
				.readdirSync(path.join(directory, '.swarm'))
				.filter((name) => name.startsWith('plan-ledger.quarantine.')),
		).toEqual([]);
	});
});
