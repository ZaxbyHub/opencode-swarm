import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	allocateSummaryId,
	listSummaries,
	loadFullOutput,
	SummaryIdCollisionError,
	storeSummary,
} from '../../../src/summaries/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2576 storage-side contract: durable max-plus-one allocation and
 * no-overwrite install semantics for `.swarm/summaries/`.
 */
describe('summaries manager allocation + no-overwrite store', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('manager-allocation-test-');
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('allocateSummaryId returns S1 for an empty summaries directory', () => {
		expect(allocateSummaryId(tempDir)).toBe('S1');
	});

	test('allocateSummaryId returns S1 when .swarm does not exist yet', () => {
		const bare = canonicalMkdtemp('manager-allocation-bare-');
		try {
			expect(allocateSummaryId(bare)).toBe('S1');
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	test('allocateSummaryId continues after the max persisted numeric ID', async () => {
		await storeSummary(tempDir, 'S1', 'one', 'one', 1048576);
		await storeSummary(tempDir, 'S2', 'two', 'two', 1048576);
		await storeSummary(tempDir, 'S7', 'seven', 'seven', 1048576);
		expect(allocateSummaryId(tempDir)).toBe('S8');
	});

	test('allocateSummaryId stays exact past 2^53 (BigInt, not float)', async () => {
		// Two 17-digit IDs that alias under float comparison: +1 apart.
		const big1 = 'S9007199254740993'; // 2^53 + 1
		const big2 = 'S9007199254740995'; // 2^53 + 3 (float-rounds to +2)
		await storeSummary(tempDir, big1, 'a', 'a', 1048576);
		await storeSummary(tempDir, big2, 'b', 'b', 1048576);
		expect(allocateSummaryId(tempDir)).toBe('S9007199254740996');
	});

	test('allocateSummaryId normalizes leading-zero legacy IDs numerically', async () => {
		await storeSummary(tempDir, 'S007', 'legacy', 'legacy', 1048576);
		await storeSummary(tempDir, 'S3', 'three', 'three', 1048576);
		expect(allocateSummaryId(tempDir)).toBe('S8');
	});

	test('allocateSummaryId ignores files outside the S\\d+ grammar', async () => {
		await storeSummary(tempDir, 'S2', 'two', 'two', 1048576);
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		writeFileSync(join(summariesDir, 'notes.txt'), 'not a summary');
		writeFileSync(join(summariesDir, 'Sx.json'), '{"foreign":true}');
		expect(allocateSummaryId(tempDir)).toBe('S3');
	});

	test('a directory named like a summary neither occupies an ID slot nor is listed', async () => {
		// PRR-005: non-file entries must be invisible to enumeration.
		await storeSummary(tempDir, 'S2', 'two', 'two', 1048576);
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		mkdirSync(join(summariesDir, 'S9.json'), { recursive: true });
		expect(allocateSummaryId(tempDir)).toBe('S3');
		expect(await listSummaries(tempDir)).toEqual(['S2']);
	});

	test('storeSummary refuses to replace an existing entry with a typed collision error', async () => {
		await storeSummary(tempDir, 'S1', 'PRECIOUS', 'first summary', 1048576);

		let caught: unknown;
		try {
			await storeSummary(tempDir, 'S1', 'NEWCOMER', 'second summary', 1048576);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(SummaryIdCollisionError);
		expect((caught as Error).name).toBe('SummaryIdCollisionError');
		expect((caught as SummaryIdCollisionError).summaryId).toBe('S1');

		// The pre-existing entry is retained untouched.
		expect(await loadFullOutput(tempDir, 'S1')).toBe('PRECIOUS');
	});

	test('storeSummary collision leaves no temp file behind', async () => {
		await storeSummary(tempDir, 'S1', 'PRECIOUS', 'first summary', 1048576);
		const summariesDir = join(tempDir, '.swarm', 'summaries');

		let collisions = 0;
		for (let i = 0; i < 3; i += 1) {
			try {
				await storeSummary(tempDir, 'S1', `NEWCOMER-${i}`, 'again', 1048576);
			} catch (error) {
				if (error instanceof SummaryIdCollisionError) collisions += 1;
			}
		}

		expect(collisions).toBe(3);
		const leftovers = readdirSync(summariesDir).filter((name) =>
			name.includes('.tmp.'),
		);
		expect(leftovers).toEqual([]);
		expect(await loadFullOutput(tempDir, 'S1')).toBe('PRECIOUS');
	});

	test('storeSummary still enforces the size precheck before install', async () => {
		let caught: unknown;
		try {
			await storeSummary(tempDir, 'S1', 'x'.repeat(2000), 'summary', 10);
		} catch (error) {
			caught = error;
		}
		expect(caught).not.toBeInstanceOf(SummaryIdCollisionError);
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain('exceeds maximum');
	});
});
