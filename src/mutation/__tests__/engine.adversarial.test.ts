import { describe, expect, test } from 'bun:test';
import {
	freezeClock,
	type Restore,
} from '../../../tests/helpers/test-clock.js';
import type {
	MutationOutcome,
	MutationPatch,
	MutationResult,
} from '../engine.js';
import { computeReport, executeMutationSuite } from '../engine.js';

describe('computeReport adversarial tests', () => {
	// 1. All-equivalent results — adjustedKillRate denominator should not divide by zero
	test('all-equivalent results yields adjustedKillRate = 0, not NaN', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/foo.ts',
				functionName: 'foo',
				mutationType: 'negate',
				outcome: 'equivalent',
				durationMs: 10,
			},
			{
				patchId: 'p2',
				filePath: 'src/bar.ts',
				functionName: 'bar',
				mutationType: 'negate',
				outcome: 'equivalent',
				durationMs: 10,
			},
		];
		const report = computeReport(results, 100);
		expect(report.adjustedKillRate).toBe(0);
		expect(Number.isNaN(report.adjustedKillRate)).toBe(false);
	});

	// 2. All-skipped results — killRate denominator = 0
	test('all-skipped results yields killRate = 0, not NaN', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/foo.ts',
				functionName: 'foo',
				mutationType: 'negate',
				outcome: 'skipped',
				durationMs: 0,
			},
			{
				patchId: 'p2',
				filePath: 'src/bar.ts',
				functionName: 'bar',
				mutationType: 'negate',
				outcome: 'skipped',
				durationMs: 0,
			},
		];
		const report = computeReport(results, 100);
		expect(report.killRate).toBe(0);
		expect(Number.isNaN(report.killRate)).toBe(false);
	});

	// 3. Extremely large result array (10,000+ mutants) — should not cause performance issues
	test('handles 10,000 results without performance degradation', () => {
		const results: MutationResult[] = [];
		for (let i = 0; i < 10_000; i++) {
			results.push({
				patchId: `p${i}`,
				filePath: `src/file${i}.ts`,
				functionName: 'fn',
				mutationType: 'negate',
				outcome: i % 2 === 0 ? 'killed' : 'survived',
				durationMs: 5,
			});
		}
		const start = Date.now();
		const report = computeReport(results, 500);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(2000); // Should complete within 2 seconds
		expect(report.totalMutants).toBe(10_000);
		expect(report.killed).toBe(5_000);
		expect(report.survived).toBe(5_000);
	});

	// 4. NaN/Infinity in durationMs — report should not crash
	test('NaN durationMs is preserved in report without crashing', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/foo.ts',
				functionName: 'foo',
				mutationType: 'negate',
				outcome: 'killed',
				durationMs: NaN,
			},
		];
		const report = computeReport(results, NaN);
		expect(report.durationMs).toBeNaN();
	});

	test('Infinity durationMs is preserved in report without crashing', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/foo.ts',
				functionName: 'foo',
				mutationType: 'negate',
				outcome: 'killed',
				durationMs: Infinity,
			},
		];
		const report = computeReport(results, Infinity);
		expect(report.durationMs).toBe(Infinity);
	});

	// 5. Malformed MutationResult objects — extra fields and missing optional fields
	test('result with extra fields is handled gracefully', () => {
		const results = [
			{
				patchId: 'p1',
				filePath: 'src/foo.ts',
				functionName: 'foo',
				mutationType: 'negate',
				outcome: 'killed' as MutationOutcome,
				durationMs: 10,
				// extra fields
				unknownField: 'should be ignored',
				nested: { a: 1 },
				arr: [1, 2, 3],
			},
		];
		const report = computeReport(results as MutationResult[], 100);
		expect(report.killed).toBe(1);
	});

	test('result with only required fields (no optional) is handled', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/foo.ts',
				functionName: 'foo',
				mutationType: 'negate',
				outcome: 'survived',
				durationMs: 10,
				// no testOutput, no error, no lineNumber
			},
		];
		const report = computeReport(results, 100);
		expect(report.survived).toBe(1);
	});

	// 6. All 6 MutationOutcome values are handled in switch statement
	test('all 6 outcome values are counted correctly', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/a.ts',
				functionName: 'a',
				mutationType: 'x',
				outcome: 'killed',
				durationMs: 10,
			},
			{
				patchId: 'p2',
				filePath: 'src/b.ts',
				functionName: 'b',
				mutationType: 'x',
				outcome: 'survived',
				durationMs: 10,
			},
			{
				patchId: 'p3',
				filePath: 'src/c.ts',
				functionName: 'c',
				mutationType: 'x',
				outcome: 'timeout',
				durationMs: 10,
			},
			{
				patchId: 'p4',
				filePath: 'src/d.ts',
				functionName: 'd',
				mutationType: 'x',
				outcome: 'error',
				durationMs: 10,
			},
			{
				patchId: 'p5',
				filePath: 'src/e.ts',
				functionName: 'e',
				mutationType: 'x',
				outcome: 'equivalent',
				durationMs: 10,
			},
			{
				patchId: 'p6',
				filePath: 'src/f.ts',
				functionName: 'f',
				mutationType: 'x',
				outcome: 'skipped',
				durationMs: 10,
			},
		];
		const report = computeReport(results, 100);
		expect(report.killed).toBe(1);
		expect(report.survived).toBe(1);
		expect(report.timeout).toBe(1);
		expect(report.errors).toBe(1);
		expect(report.equivalent).toBe(1);
		expect(report.skipped).toBe(1);
	});

	// 7. Per-function key collision — filePath with ':' characters (Windows drive letter)
	test('filePath with colon characters produces valid perFunction key', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'C:/project/src/foo.ts',
				functionName: 'foo',
				mutationType: 'negate',
				outcome: 'killed',
				durationMs: 10,
			},
			{
				patchId: 'p2',
				filePath: 'C:/project/src/foo.ts',
				functionName: 'foo',
				mutationType: 'swap',
				outcome: 'survived',
				durationMs: 10,
			},
		];
		const report = computeReport(results, 100);
		const fnEntry = report.perFunction.get('C:/project/src/foo.ts:foo');
		expect(fnEntry).toBeDefined();
		expect(fnEntry!.total).toBe(2);
		expect(fnEntry!.killed).toBe(1);
		expect(fnEntry!.survived).toBe(1);
		expect(fnEntry!.killRate).toBe(0.5);
	});

	// Edge: perFunction killRate when only killed
	test('perFunction killRate = 1 when all killed', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/a.ts',
				functionName: 'fn',
				mutationType: 'x',
				outcome: 'killed',
				durationMs: 10,
			},
			{
				patchId: 'p2',
				filePath: 'src/a.ts',
				functionName: 'fn',
				mutationType: 'x',
				outcome: 'killed',
				durationMs: 10,
			},
		];
		const report = computeReport(results, 100);
		const fnEntry = report.perFunction.get('src/a.ts:fn');
		expect(fnEntry!.killRate).toBe(1);
	});

	// Edge: perFunction killRate = 0 when all survived
	test('perFunction killRate = 0 when all survived', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/a.ts',
				functionName: 'fn',
				mutationType: 'x',
				outcome: 'survived',
				durationMs: 10,
			},
			{
				patchId: 'p2',
				filePath: 'src/a.ts',
				functionName: 'fn',
				mutationType: 'x',
				outcome: 'survived',
				durationMs: 10,
			},
		];
		const report = computeReport(results, 100);
		const fnEntry = report.perFunction.get('src/a.ts:fn');
		expect(fnEntry!.killRate).toBe(0);
	});

	// 8. Budget = 0 — first patch still runs (elapsed=0 is NOT > 0), subsequent patches skipped
	test('budgetMs = 0 skips patches after the first in executeMutationSuite', async () => {
		const patches: MutationPatch[] = [
			{
				id: 'p1',
				filePath: 'src/a.ts',
				functionName: 'a',
				mutationType: 'x',
				patch:
					'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
			},
			{
				id: 'p2',
				filePath: 'src/b.ts',
				functionName: 'b',
				mutationType: 'x',
				patch:
					'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new\n',
			},
		];
		let restoreClock: Restore = freezeClock({ fixedNow: 0 });
		try {
			// Hold elapsed time at zero through the first mutation, then restore the
			// real clock so the second iteration deterministically exceeds the budget.
			const report = await executeMutationSuite(
				patches,
				['node', '-e', 'process.exit(1)'],
				[],
				'/tmp',
				0,
				() => {
					restoreClock();
					restoreClock = () => {};
				},
			);
			expect(report.totalMutants).toBe(2);
			expect(report.skipped).toBe(1);
			// First patch outcome: error (git apply fails on non-existent file) or killed (if it works)
			// Either way exactly 1 is skipped — the key invariant
			expect(
				report.killed +
					report.errors +
					report.survived +
					report.timeout +
					report.equivalent,
			).toBe(1);
			expect(report.budgetExceeded).toBe(true);
		} finally {
			restoreClock();
		}
	});

	// 9. Budget = Infinity — no patches should be skipped
	test('budgetMs = Infinity never skips patches', async () => {
		const patches: MutationPatch[] = [
			{
				id: 'p1',
				filePath: 'src/a.ts',
				functionName: 'a',
				mutationType: 'x',
				patch: '',
			},
		];
		const report = await executeMutationSuite(
			patches,
			['true'],
			[],
			'/tmp',
			Infinity,
		);
		// If budgetMs = Infinity, budgetExceeded should always be false
		expect(report.budgetExceeded).toBe(false);
		expect(report.budgetMs).toBe(Infinity);
	});

	// 10. Empty patches array returns valid empty report
	test('empty patches array returns valid report with all zeros', async () => {
		const patches: MutationPatch[] = [];
		const report = await executeMutationSuite(patches, ['true'], [], '/tmp');
		expect(report.totalMutants).toBe(0);
		expect(report.killed).toBe(0);
		expect(report.survived).toBe(0);
		expect(report.timeout).toBe(0);
		expect(report.equivalent).toBe(0);
		expect(report.skipped).toBe(0);
		expect(report.errors).toBe(0);
		expect(report.killRate).toBe(0);
		expect(report.adjustedKillRate).toBe(0);
		expect(report.perFunction.size).toBe(0);
		expect(report.results).toEqual([]);
		expect(report.budgetExceeded).toBe(false);
	});

	// Extra: budgetExceeded boundary — duration exactly equal to budget
	test('durationMs exactly equal to budgetMs is NOT budgetExceeded', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/a.ts',
				functionName: 'a',
				mutationType: 'x',
				outcome: 'killed',
				durationMs: 10,
			},
		];
		// Budget = 100, duration = 100 → not exceeded (elapsed > budget is the condition)
		const report = computeReport(results, 100, 100);
		expect(report.budgetExceeded).toBe(false);
	});

	// Extra: negative durationMs (edge case from clock skew)
	test('negative durationMs is handled without crashing', () => {
		const results: MutationResult[] = [
			{
				patchId: 'p1',
				filePath: 'src/a.ts',
				functionName: 'a',
				mutationType: 'x',
				outcome: 'killed',
				durationMs: 10,
			},
		];
		const report = computeReport(results, -5000);
		expect(report.durationMs).toBe(-5000);
		// -5000 > 300000 (TOTAL_BUDGET_MS) is false — negative duration never exceeds budget
		expect(report.budgetExceeded).toBe(false);
	});
});
