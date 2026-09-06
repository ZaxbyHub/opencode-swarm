import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { computePlanLedgerHash, initLedger } from '../../../src/plan/ledger';
import {
	_internals,
	derivePlanMarkdown,
	loadPlan,
	resetStartupLedgerCheck,
} from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makePlan(title: string): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'ledger-first-test',
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
						description: 'Recover the plan',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

describe('loadPlan lifecycle recovery (#2531)', () => {
	let directory: string;

	beforeEach(async () => {
		directory = canonicalMkdtemp('manager-ledger-first-');
		await mkdir(join(directory, '.swarm'), { recursive: true });
		await mkdir(join(directory, '.git'));
		resetStartupLedgerCheck();
	});

	afterEach(async () => {
		resetStartupLedgerCheck();
		await rm(directory, { recursive: true, force: true });
	});

	test('recovers from the ledger before consulting lossy Markdown when plan.json is absent', async () => {
		const authoritative = makePlan('Ledger authority');
		await initLedger(
			directory,
			derivePlanId(authoritative),
			computePlanLedgerHash(authoritative),
			authoritative,
		);
		await writeFile(
			join(directory, '.swarm', 'plan.md'),
			'# Plan: Markdown fallback\n\n## Phase 1: Wrong projection\n',
		);

		const recovered = await loadPlan(directory);

		expect(recovered?.title).toBe('Ledger authority');
	});

	test('preserves a valid U+FFFD in plan.json', async () => {
		const plan = makePlan('Replacement � is valid data');
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan),
			'utf8',
		);
		await writeFile(
			join(directory, '.swarm', 'plan.md'),
			derivePlanMarkdown(plan),
			'utf8',
		);

		const loaded = await loadPlan(directory);

		expect(loaded?.title).toBe('Replacement � is valid data');
	});

	test('rejects malformed UTF-8 bytes with fatal decoding', async () => {
		await writeFile(
			join(directory, '.swarm', 'plan.json'),
			Buffer.from([
				0x7b, 0x22, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x22, 0x3a, 0xc3, 0x28, 0x7d,
			]),
		);

		await expect(_internals.readPlanJsonUtf8(directory)).rejects.toThrow();
	});
});
