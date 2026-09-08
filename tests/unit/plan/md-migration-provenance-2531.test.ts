import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	derivePlanMarkdown,
	loadPlan,
	resetStartupLedgerCheck,
} from '../../../src/plan/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makePlan(title: string): Plan {
	return {
		schema_version: '1.0.0',
		title,
		swarm: 'md-provenance-2531',
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
						description: 'Migrated task',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	} as Plan;
}

function provenanceRecorded(ledgerText: string): boolean {
	// #2531 AC4: the durable provenance record is a plan_rebuilt event whose
	// source names the markdown migration. Bare plan_created /
	// plan_epoch_adopted roots do NOT count, and the embedded plan's
	// migration_status is data, not attribution.
	for (const line of ledgerText.split('\n')) {
		if (line.trim() === '') continue;
		try {
			const event = JSON.parse(line) as {
				event_type?: string;
				source?: string;
				payload?: { plan?: unknown; reason?: string };
			};
			if (event.event_type === 'plan_rebuilt') {
				const { plan: _embeddedPlan, ...payloadRest } = event.payload ?? {};
				const fields = `${event.source ?? ''} ${JSON.stringify(payloadRest)}`;
				if (fields.includes('load_plan_migration_from_md')) return true;
			}
		} catch {
			// skip unparseable line
		}
	}
	return false;
}

describe('markdown migration provenance (#2531 AC4)', () => {
	let directory: string;

	beforeEach(async () => {
		directory = canonicalMkdtemp('md-provenance-2531-');
		await mkdir(join(directory, '.swarm'), { recursive: true });
		await mkdir(join(directory, '.git'));
		resetStartupLedgerCheck();
	});

	afterEach(async () => {
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
	});

	test('ledger-absent migration persists migration_status and a durable provenance event', async () => {
		const plan = makePlan('Migratable plan');
		await writeFile(
			join(directory, '.swarm', 'plan.md'),
			derivePlanMarkdown(plan),
			'utf8',
		);

		const loaded = await loadPlan(directory);

		expect(loaded?.migration_status).toBe('migrated');
		const ledgerPath = join(directory, '.swarm', 'plan-ledger.jsonl');
		expect(existsSync(ledgerPath)).toBe(true);
		const ledgerText = readFileSync(ledgerPath, 'utf8');
		expect(provenanceRecorded(ledgerText)).toBe(true);
	});

	test('ledger history is retained (append-only) after the migration', async () => {
		const plan = makePlan('Retained history plan');
		await writeFile(
			join(directory, '.swarm', 'plan.md'),
			derivePlanMarkdown(plan),
			'utf8',
		);
		await loadPlan(directory);

		const ledgerText = readFileSync(
			join(directory, '.swarm', 'plan-ledger.jsonl'),
			'utf8',
		);
		const lines = ledgerText.split('\n').filter((line) => line.trim() !== '');
		// plan_created root + provenance event — history only grows.
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const first = JSON.parse(lines[0]) as { event_type?: string };
		expect(first.event_type).toBe('plan_created');
	});
});
