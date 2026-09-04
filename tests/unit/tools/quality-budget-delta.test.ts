/**
 * End-to-end verdict tests for the quality_budget tool with true deltas
 * (issue #2470 / #1655 acceptance criteria).
 *
 *  - A changed file whose complexity DECREASED relative to base passes even
 *    though its absolute total exceeds the threshold.
 *  - A change whose complexity genuinely increases past the delta threshold
 *    still fails.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { qualityBudget } from '../../../src/tools/quality-budget';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function ifs(n: number): string {
	return Array.from({ length: n }, (_, i) => `if (x === ${i}) { y++; }`).join(
		'\n',
	);
}

function git(dir: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd: dir,
		stdio: ['ignore', 'ignore', 'ignore'],
	});
}

describe('quality_budget tool verdicts with true base-vs-head deltas (#2470/#1655)', () => {
	test('complexity-reducing refactor of a high-complexity file passes', async () => {
		const dir = canonicalMkdtemp('qb-delta-reduce-');
		try {
			fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
			// -b main: create-or-fail on the canonical branch name. A bare
			// `git init` + `checkout -qb main` fails (exit 128) on any machine
			// with init.defaultBranch=main.
			git(dir, 'init', '-q', '-b', 'main');
			git(dir, 'config', 'user.email', 't@t.test');
			git(dir, 'config', 'user.name', 'Test');
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), ifs(20));
			git(dir, 'add', '-A');
			git(dir, 'commit', '-qm', 'base');
			git(dir, 'checkout', '-qb', 'work');

			// Halve complexity: 21 → 9. Absolute total (9) still exceeds the
			// default max_complexity_delta (5); the true delta is −12.
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), ifs(8));

			const result = await qualityBudget(
				{
					changed_files: ['src/big.ts'],
					// Isolate the complexity-delta verdict: the temp fixture has
					// no tests, so the unrelated test-ratio gate is disabled.
					config: { min_test_to_code_ratio: 0 },
				},
				dir,
			);
			expect(result.metrics.complexity_delta).toBe(-12);
			expect(result.violations.filter((v) => v.type === 'complexity')).toEqual(
				[],
			);
			expect(
				result.violations.filter(
					(v) => v.type === 'complexity' && v.severity === 'error',
				).length,
			).toBe(0);
			expect(result.verdict).toBe('pass');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('genuine complexity increase past the delta threshold fails', async () => {
		const dir = canonicalMkdtemp('qb-delta-increase-');
		try {
			fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
			// -b main: create-or-fail on the canonical branch name. A bare
			// `git init` + `checkout -qb main` fails (exit 128) on any machine
			// with init.defaultBranch=main.
			git(dir, 'init', '-q', '-b', 'main');
			git(dir, 'config', 'user.email', 't@t.test');
			git(dir, 'config', 'user.name', 'Test');
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), ifs(2));
			git(dir, 'add', '-A');
			git(dir, 'commit', '-qm', 'base');
			git(dir, 'checkout', '-qb', 'work');

			// True delta 18 > 5 (and > 1.5×5) → error → verdict fail.
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), ifs(20));

			const result = await qualityBudget(
				{ changed_files: ['src/big.ts'] },
				dir,
			);
			expect(result.metrics.complexity_delta).toBe(18);
			expect(result.verdict).toBe('fail');
			expect(
				result.violations.some(
					(v) =>
						v.type === 'complexity' &&
						v.severity === 'error' &&
						v.message.includes('(18)'),
				),
			).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
