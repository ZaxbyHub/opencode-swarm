import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { executeSavePlan } from '../../../src/tools/save-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #2532 review follow-up (PRR-009): save_plan must reject duplicate
 * phase ids — a duplicated id makes find-first cursor/phase resolution
 * ambiguous across every current_phase consumer.
 */
describe('save_plan duplicate phase id rejection (#2532)', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('save-plan-dup-phase-');
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'spec.md'),
			'# Spec\n',
			'utf-8',
		);
		process.env.SWARM_SKIP_SPEC_GATE = '1';
		process.env.SWARM_SKIP_GATE_SELECTION = '1';
	});

	afterEach(() => {
		delete process.env.SWARM_SKIP_SPEC_GATE;
		delete process.env.SWARM_SKIP_GATE_SELECTION;
		try {
			closeProjectDb(directory);
		} catch {
			// best-effort
		}
		try {
			fs.rmSync(directory, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('rejects a plan with a duplicated phase id', async () => {
		const result = await executeSavePlan(
			{
				title: 'Dup Phase Plan',
				swarm_id: 'dup-phase',
				phases: [
					{
						id: 1,
						name: 'One',
						tasks: [{ id: '1.1', description: 'Task one', size: 'small' }],
					},
					{
						id: 1,
						name: 'One Again',
						tasks: [{ id: '1.2', description: 'Task two', size: 'small' }],
					},
				],
				working_directory: directory,
			},
			directory,
		);
		expect(result.success).toBe(false);
		expect(
			(result.errors ?? []).some((error) => error.includes('duplicated')),
		).toBe(true);
	});

	test('accepts distinct phase ids (control)', async () => {
		const result = await executeSavePlan(
			{
				title: 'Distinct Phase Plan',
				swarm_id: 'distinct-phase',
				phases: [
					{
						id: 1,
						name: 'One',
						tasks: [{ id: '1.1', description: 'Task one', size: 'small' }],
					},
					{
						id: 2,
						name: 'Two',
						tasks: [{ id: '2.1', description: 'Task two', size: 'small' }],
					},
				],
				working_directory: directory,
			},
			directory,
		);
		expect(result.success).toBe(true);
	});
});
