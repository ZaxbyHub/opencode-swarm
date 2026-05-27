import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { aggregatePhaseSummary } from '../../../src/summaries/aggregate';
import { normalizeAgentWorkSummary } from '../../../src/summaries/schema';
import {
	readPhaseArchitectureSummary,
	writeAgentSummary,
} from '../../../src/summaries/store';

let tempDir: string;

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'swarm-aggregate-')),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

async function seed(
	overrides: Partial<Parameters<typeof normalizeAgentWorkSummary>[0]>,
) {
	await writeAgentSummary(
		tempDir,
		normalizeAgentWorkSummary({
			phase: 1,
			session_id: 's1',
			agent: 'coder',
			summary: 'did work',
			...overrides,
		}),
	);
}

describe('aggregatePhaseSummary', () => {
	test('returns null and writes nothing when there are no summaries', async () => {
		const result = await aggregatePhaseSummary(tempDir, 1);
		expect(result).toBeNull();
		expect(readPhaseArchitectureSummary(tempDir, 1)).toBeNull();
	});

	test('rolls up agents, tasks, decisions, and risks', async () => {
		await seed({
			task_id: '1.1',
			agent: 'coder',
			key_decisions: ['use redis'],
			risks: ['cache eviction'],
		});
		await seed({
			task_id: '1.2',
			agent: 'test_engineer',
			key_decisions: ['add load test'],
			risks: ['flaky timing'],
		});

		const result = await aggregatePhaseSummary(tempDir, 1);
		expect(result).not.toBeNull();
		expect(result?.agents_seen).toEqual(['coder', 'test_engineer']);
		expect(result?.tasks_seen).toEqual(['1.1', '1.2']);
		expect(result?.key_decisions.sort()).toEqual([
			'add load test',
			'use redis',
		]);
		expect(result?.unresolved_risks.sort()).toEqual([
			'cache eviction',
			'flaky timing',
		]);

		// Sidecar persisted and readable.
		const read = readPhaseArchitectureSummary(tempDir, 1);
		expect(read?.agents_seen).toEqual(['coder', 'test_engineer']);
	});

	test('detects a cross-agent constraint contradiction', async () => {
		await seed({
			task_id: '1.1',
			agent: 'coder',
			constraints_observed: ['no network in init'],
		});
		await seed({
			task_id: '1.2',
			agent: 'explorer',
			constraints_violated: ['no network in init'],
		});

		const result = await aggregatePhaseSummary(tempDir, 1);
		expect(result?.conflicts).toHaveLength(1);
		expect(result?.conflicts[0]).toContain('no network in init');
		expect(result?.conflicts[0]).toContain('coder');
		expect(result?.conflicts[0]).toContain('explorer');
		expect(result?.constraint_violations).toEqual(['no network in init']);
	});

	test('does not flag a constraint only violated (no observer)', async () => {
		await seed({
			task_id: '1.1',
			agent: 'coder',
			constraints_violated: ['budget exceeded'],
		});
		const result = await aggregatePhaseSummary(tempDir, 1);
		expect(result?.conflicts).toEqual([]);
		expect(result?.constraint_violations).toEqual(['budget exceeded']);
	});

	test('only aggregates the requested phase', async () => {
		await seed({ phase: 1, task_id: '1.1', agent: 'coder' });
		await seed({ phase: 2, task_id: '2.1', agent: 'coder' });
		const p2 = await aggregatePhaseSummary(tempDir, 2);
		expect(p2?.tasks_seen).toEqual(['2.1']);
	});
});
