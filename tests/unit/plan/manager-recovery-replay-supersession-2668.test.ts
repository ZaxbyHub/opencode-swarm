import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import type { LedgerEvent } from '../../../src/plan/ledger';
import {
	loadPlan,
	PlanRecoverySupersededError,
	rebuildPlan,
	regeneratePlanMarkdown,
	resetStartupLedgerCheck,
	savePlan,
} from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makePlan(
	status: Plan['phases'][0]['tasks'][0]['status'] = 'pending',
): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Recovery replay supersession',
		swarm: 'recovery-replay-supersession-2668',
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
						description: 'Preserve canonical state',
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

async function seedCorruptLedger(
	directory: string,
	projection: 'invalid' | 'missing' | 'valid',
): Promise<{ ledgerPath: string; planPath: string; plan: Plan }> {
	const authoritative = makePlan('completed');
	const prefixPlan = makePlan('pending');
	const planId = derivePlanId(authoritative);
	const swarmDir = path.join(directory, '.swarm');
	const planPath = path.join(swarmDir, 'plan.json');
	const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');

	if (projection === 'valid') {
		await writeFile(planPath, JSON.stringify(authoritative, null, 2), 'utf8');
		await regeneratePlanMarkdown(directory, authoritative);
	} else if (projection === 'invalid') {
		await writeFile(
			planPath,
			JSON.stringify({ ...authoritative, phases: 'not-an-array' }, null, 2),
			'utf8',
		);
	}

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
		phase_id: 1,
		from_status: 'pending',
		to_status: 'in_progress',
		source: 'test',
		plan_hash_before: 'H1',
		plan_hash_after: 'H2',
		schema_version: '1.1.0',
	};
	await writeFile(
		ledgerPath,
		eventLine(created) +
			eventLine(progress) +
			'{ poison: recovery must not publish a quarantine file\n' +
			'after-poison bytes must remain canonical\n',
		'utf8',
	);
	return { ledgerPath, planPath, plan: authoritative };
}

async function expectSuperseded(
	operation: () => Promise<unknown>,
): Promise<void> {
	await expect(operation()).rejects.toBeInstanceOf(PlanRecoverySupersededError);
}

function quarantineNames(directory: string): string[] {
	return fs
		.readdirSync(path.join(directory, '.swarm'))
		.filter((name) => name.startsWith('plan-ledger.quarantine.'));
}

describe('manager recovery replay authority fences (#2668)', () => {
	let directory = '';

	beforeEach(async () => {
		directory = canonicalMkdtemp('manager-replay-supersession-2668-');
		await mkdir(path.join(directory, '.swarm'), { recursive: true });
		await mkdir(path.join(directory, '.git'));
		resetStartupLedgerCheck();
	});

	afterEach(async () => {
		resetStartupLedgerCheck();
		await rm(directory, { recursive: true, force: true });
	});

	test('schema-invalid projection does not quarantine after replay read supersession', async () => {
		const { ledgerPath, planPath } = await seedCorruptLedger(
			directory,
			'invalid',
		);
		const ledgerBefore = await readFile(ledgerPath, 'utf8');
		const planBefore = await readFile(planPath, 'utf8');
		let checks = 0;
		const preCommitCheck = () => {
			checks++;
			if (checks === 2) throw new PlanRecoverySupersededError('new authority');
		};

		await expectSuperseded(() =>
			loadPlan(directory, undefined, { preCommitCheck }),
		);
		expect(checks).toBe(2);
		expect(quarantineNames(directory)).toEqual([]);
		expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore);
		expect(await readFile(planPath, 'utf8')).toBe(planBefore);
	});

	test('missing projection does not quarantine after replay read supersession', async () => {
		const { ledgerPath } = await seedCorruptLedger(directory, 'missing');
		const ledgerBefore = await readFile(ledgerPath, 'utf8');
		let checks = 0;
		const preCommitCheck = () => {
			checks++;
			if (checks === 2) throw new PlanRecoverySupersededError('new authority');
		};

		await expectSuperseded(() =>
			loadPlan(directory, undefined, { preCommitCheck }),
		);
		expect(checks).toBe(2);
		expect(quarantineNames(directory)).toEqual([]);
		expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore);
		expect(fs.existsSync(path.join(directory, '.swarm', 'plan.json'))).toBe(
			false,
		);
	});

	test('savePlan pre-projection replay propagates supersession without mutation', async () => {
		const { ledgerPath, planPath, plan } = await seedCorruptLedger(
			directory,
			'valid',
		);
		const ledgerBefore = await readFile(ledgerPath, 'utf8');
		const planBefore = await readFile(planPath, 'utf8');
		const preCommitCheck = () => {
			throw new PlanRecoverySupersededError('new authority');
		};

		await expectSuperseded(() => savePlan(directory, plan, { preCommitCheck }));
		expect(quarantineNames(directory)).toEqual([]);
		expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore);
		expect(await readFile(planPath, 'utf8')).toBe(planBefore);
	});

	test('rebuildPlan self-replay propagates supersession without quarantine', async () => {
		const { ledgerPath } = await seedCorruptLedger(directory, 'missing');
		const ledgerBefore = await readFile(ledgerPath, 'utf8');
		const preCommitCheck = () => {
			throw new PlanRecoverySupersededError('new authority');
		};

		await expectSuperseded(() =>
			rebuildPlan(directory, undefined, { preCommitCheck }),
		);
		expect(quarantineNames(directory)).toEqual([]);
		expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore);
		expect(fs.existsSync(path.join(directory, '.swarm', 'plan.json'))).toBe(
			false,
		);
	});

	describe('rebuildPlan markdown temp cleanup (F-003)', () => {
		test('removes the staged markdown temp when superseded before rename', async () => {
			const swarmDir = path.join(directory, '.swarm');
			let sawStagedMarkdown = false;
			const preCommitCheck = () => {
				const names = fs.readdirSync(swarmDir);
				if (names.some((name) => name.startsWith('plan.md.rebuild.'))) {
					// Before the cleanup fix, this fence rejected publication while
					// leaving the already-written plan.md.rebuild.* file behind.
					sawStagedMarkdown = true;
					throw new PlanRecoverySupersededError('new authority');
				}
			};

			await expectSuperseded(() =>
				rebuildPlan(directory, makePlan(), { preCommitCheck }),
			);

			expect(sawStagedMarkdown).toBe(true);
			expect(
				fs
					.readdirSync(swarmDir)
					.filter((name) => name.startsWith('plan.md.rebuild.')),
			).toEqual([]);
		});

		test('removes the staged JSON temp when superseded before rename (R1)', async () => {
			const swarmDir = path.join(directory, '.swarm');
			const planPath = path.join(swarmDir, 'plan.json');
			let sawStagedPlan = false;
			const preCommitCheck = () => {
				const names = fs.readdirSync(swarmDir);
				if (names.some((name) => name.startsWith('plan.json.rebuild.'))) {
					// Before the cleanup fix, this authority fence rejected the rename
					// but left the fsynced plan.json.rebuild.* file in .swarm/.
					sawStagedPlan = true;
					throw new PlanRecoverySupersededError('new authority');
				}
			};

			await expectSuperseded(() =>
				rebuildPlan(directory, makePlan(), { preCommitCheck }),
			);

			expect(sawStagedPlan).toBe(true);
			expect(fs.existsSync(planPath)).toBe(false);
			expect(
				fs
					.readdirSync(swarmDir)
					.filter((name) => name.startsWith('plan.json.rebuild.')),
			).toEqual([]);
		});
	});

	test('spec-staleness temp preparation cannot publish after supersession', async () => {
		const plan = { ...makePlan(), specHash: 'stale-hash' };
		const planPath = path.join(directory, '.swarm', 'plan.json');
		await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
		await regeneratePlanMarkdown(directory, plan);
		await writeFile(
			path.join(directory, '.swarm', 'spec.md'),
			'changed spec\n',
			'utf8',
		);
		const planBefore = await readFile(planPath, 'utf8');
		let checks = 0;
		const preCommitCheck = () => {
			checks++;
			if (checks === 2) throw new PlanRecoverySupersededError('new authority');
		};

		await expectSuperseded(() =>
			loadPlan(directory, undefined, { preCommitCheck }),
		);
		expect(checks).toBe(2);
		expect(await readFile(planPath, 'utf8')).toBe(planBefore);
		const names = await readdir(path.join(directory, '.swarm'));
		expect(
			names.some((name) =>
				name.startsWith('spec-staleness.json.spec-staleness.'),
			),
		).toBe(false);
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'spec-staleness.json')),
		).toBe(false);
	});
});
