/**
 * True base-vs-head delta math tests for quality metrics
 * (issue #2470 / #1655).
 *
 * Real git repos in temp directories: the metrics module resolves the
 * merge-base against the 'main' branch, reads base file content via
 * `git show`, and computes delta = head − base for complexity and public API.
 *
 * Adversarial cases from the issue: negative, zero, and positive deltas;
 * new files (base 0); deleted files (negative contribution); no-git fallback
 * (base unavailable → historical absolute behavior).
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { computeQualityMetrics } from '../../../src/quality/metrics';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const THRESHOLDS = {
	enabled: true,
	max_complexity_delta: 5,
	max_public_api_delta: 10,
	max_duplication_ratio: 0.05,
	min_test_to_code_ratio: 0.3,
	enforce_on_globs: ['src/**'],
	exclude_globs: [],
} as const;

/** `if` statements only; estimateCyclomaticComplexity = 1 + count. */
function ifs(n: number): string {
	return Array.from({ length: n }, (_, i) => `if (x === ${i}) { y++; }`).join(
		'\n',
	);
}

function exports_(n: number): string {
	return Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join(
		'\n',
	);
}

function git(dir: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd: dir,
		stdio: ['ignore', 'ignore', 'ignore'],
	});
}

/** Create a git repo whose 'main' branch holds baseFileContent at src/big.ts. */
function makeRepo(baseContent: string): string {
	const dir = canonicalMkdtemp('metrics-delta-');
	try {
		fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
		// -b main: create-or-fail on the canonical branch name (a bare
		// `git init` + `checkout -qb main` exits 128 when init.defaultBranch
		// is already main) and keeps the temp dir from leaking on failure.
		git(dir, 'init', '-q', '-b', 'main');
		git(dir, 'config', 'user.email', 't@t.test');
		git(dir, 'config', 'user.name', 'Test');
		fs.writeFileSync(path.join(dir, 'src', 'big.ts'), baseContent);
		git(dir, 'add', '-A');
		git(dir, 'commit', '-qm', 'base');
		git(dir, 'checkout', '-qb', 'work');
		return dir;
	} catch (error) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

function metrics(
	dir: string,
	files: string[],
): ReturnType<typeof computeQualityMetrics> {
	return computeQualityMetrics([...files], { ...THRESHOLDS }, dir);
}

function complexityViolations(
	m: Awaited<ReturnType<typeof computeQualityMetrics>>,
): string[] {
	return m.violations
		.filter((v) => v.type === 'complexity')
		.map((v) => v.message);
}

function apiViolations(
	m: Awaited<ReturnType<typeof computeQualityMetrics>>,
): string[] {
	return m.violations.filter((v) => v.type === 'api').map((v) => v.message);
}

describe('quality metrics true base-vs-head deltas (issue #2470/#1655)', () => {
	test('negative delta: a complexity-REDUCING refactor no longer fails the gate', async () => {
		const dir = makeRepo(ifs(20));
		try {
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), ifs(8));
			const m = await metrics(dir, ['src/big.ts']);
			// head complexity (9) − base complexity (21) = −12
			expect(m.complexity_delta).toBe(-12);
			expect(complexityViolations(m)).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('absolute changed-file paths (pre_check_batch convention) are analyzed like relative ones', async () => {
		const dir = makeRepo(ifs(20));
		try {
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), ifs(8));
			// pre_check_batch passes path.resolve(directory, file) — absolute
			// paths. The enforce globs are repo-relative, so the absolute form
			// must be relativized or the gate silently analyzes nothing.
			const m = await computeQualityMetrics(
				[path.join(dir, 'src', 'big.ts')],
				{ ...THRESHOLDS },
				dir,
			);
			expect(m.files_analyzed).toContain('src/big.ts');
			expect(m.complexity_delta).toBe(-12);
			expect(m.base_resolved).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('zero delta: unchanged file passed as changed reports 0', async () => {
		const dir = makeRepo(ifs(8));
		try {
			const m = await metrics(dir, ['src/big.ts']);
			expect(m.complexity_delta).toBe(0);
			expect(complexityViolations(m)).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('positive delta over threshold still fails', async () => {
		const dir = makeRepo(ifs(2));
		try {
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), ifs(20));
			const m = await metrics(dir, ['src/big.ts']);
			// head 21 − base 3 = 18 > 5 → error (18 > 5*1.5)
			expect(m.complexity_delta).toBe(18);
			expect(complexityViolations(m).length).toBe(1);
			expect(complexityViolations(m)[0]).toContain('Complexity delta (18)');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('public API delta is base-vs-head, not an absolute total', async () => {
		const dir = makeRepo(exports_(2));
		try {
			// base 2 → head 8: delta 6, under the 10 threshold → no violation.
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), exports_(8));
			const m = await metrics(dir, ['src/big.ts']);
			expect(m.public_api_delta).toBe(6);
			expect(apiViolations(m)).toEqual([]);

			// base 2 → head 13: delta 11 > 10 → violation.
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), exports_(13));
			const m2 = await metrics(dir, ['src/big.ts']);
			expect(m2.public_api_delta).toBe(11);
			expect(apiViolations(m2).length).toBe(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('new file (no base version) counts its full complexity as added', async () => {
		const dir = makeRepo(ifs(2));
		try {
			fs.writeFileSync(path.join(dir, 'src', 'new.ts'), ifs(8));
			const m = await metrics(dir, ['src/new.ts']);
			// no base → base 0; head complexity 9 counts fully.
			expect(m.complexity_delta).toBe(9);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('deleted file subtracts its base complexity (negative contribution)', async () => {
		const dir = makeRepo(ifs(8));
		try {
			fs.rmSync(path.join(dir, 'src', 'big.ts'));
			const m = await metrics(dir, ['src/big.ts']);
			// head 0 − base 9 = −9
			expect(m.complexity_delta).toBe(-9);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('no-git fallback: without a repo the value stays the absolute total (head-only)', async () => {
		const dir = canonicalMkdtemp('metrics-nogit-');
		try {
			fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), ifs(8));
			const m = await metrics(dir, ['src/big.ts']);
			// No merge base resolvable → base 0 → historical absolute behavior.
			expect(m.complexity_delta).toBe(9);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('base reads are capped (MAX_BASE_FILE_READS): beyond-cap files fall back to head-only', async () => {
		// The f* base content must be in the MERGE-BASE (the branch point), so
		// it is committed before 'work' forks from 'main'.
		const dir = canonicalMkdtemp('metrics-delta-cap-');
		try {
			fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
			git(dir, 'init', '-q', '-b', 'main');
			git(dir, 'config', 'user.email', 't@t.test');
			git(dir, 'config', 'user.name', 'Test');
			fs.writeFileSync(path.join(dir, 'src', 'big.ts'), ifs(2));
			const files: string[] = [];
			for (let i = 0; i < 201; i++) {
				const rel = `src/f${i}.ts`;
				files.push(rel);
				fs.writeFileSync(path.join(dir, rel), ifs(2));
			}
			git(dir, 'add', '-A');
			git(dir, 'commit', '-qm', 'base-all');
			git(dir, 'checkout', '-qb', 'work');
			for (const rel of files) {
				fs.writeFileSync(path.join(dir, rel), ifs(8));
			}
			// big.ts stays unchanged (delta 0); f* files: base 3, head 9.
			// The 200-file base-read budget spans ALL changed files: big.ts
			// consumes one slot, so 199 f* files get base reads (delta 6
			// each) and the remaining 2 fall back to full head complexity 9.
			const m = await metrics(dir, ['src/big.ts', ...files]);
			expect(m.complexity_delta).toBe(199 * 6 + 2 * 9 + 0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});
