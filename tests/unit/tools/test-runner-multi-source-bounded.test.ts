import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	MAX_SAFE_TEST_FILES,
	test_runner,
} from '../../../src/tools/test-runner.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Bounded multi-source discovery (issue #2492 AC1/AC2/AC9/AC12): multi-source
 * graph/impact batches run when the resolved union stays under
 * MAX_SAFE_TEST_FILES (deduplicated), union overflow returns the typed
 * scope_exceeded with the binding cap_decision, zero-tests is the typed
 * no_impacted_tests outcome, and graph discovery no longer hangs on external
 * ESM imports. Mirrors frozen checks c1/c2/c9/c12.
 */

const execute = test_runner.execute as unknown as (
	args: Record<string, unknown>,
	directory: string | undefined,
) => Promise<string>;

function makeFixture(): string {
	const dir = canonicalMkdtemp('tr-multi-');
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify(
			{ name: 'fixture', private: true, scripts: { test: 'bun test' } },
			null,
			2,
		),
	);
	return dir;
}

function write(rel: string, content: string, root: string): void {
	const p = path.join(root, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
}

function parse(raw: string): Record<string, any> {
	return JSON.parse(raw) as Record<string, any>;
}

const norm = (p: string): string => p.replace(/\\/g, '/');

describe('bounded multi-source graph/impact batches (issue #2492)', () => {
	test('under-cap multi-source graph batch runs both sources with dedup and cap reporting', async () => {
		const fixture = makeFixture();
		write('src/alpha.ts', 'export const alpha = 1;\n', fixture);
		write('src/beta.ts', 'export const beta = 2;\n', fixture);
		// alpha.test.ts imports BOTH sources (shared); beta.test.ts imports beta.
		// Graph candidates come from the convention mapping, so shared tests ride
		// a matching basename — the same shape the frozen checks use.
		write(
			'tests/alpha.test.ts',
			"import { test, expect } from 'bun:test';\nimport { alpha } from '../src/alpha';\nimport { beta } from '../src/beta';\n\ntest('shared', () => { expect(alpha + beta).toBe(3); });\n",
			fixture,
		);
		write(
			'tests/beta.test.ts',
			"import { test, expect } from 'bun:test';\nimport { beta } from '../src/beta';\n\ntest('beta', () => { expect(beta).toBe(2); });\n",
			fixture,
		);

		const parsed = parse(
			await execute(
				{
					scope: 'graph',
					files: ['src/alpha.ts', 'src/beta.ts'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		expect(parsed.success).toBe(true);
		expect(parsed.outcome).toBe('pass');
		const cmdFiles = (parsed.command ?? []).slice(2).map(norm);
		expect(cmdFiles).toContain('tests/alpha.test.ts');
		expect(cmdFiles).toContain('tests/beta.test.ts');
		// Dedup: each resolved file appears exactly once.
		const sorted = [...cmdFiles].sort();
		expect(new Set(sorted).size).toBe(sorted.length);
		expect(parsed.cap_decision).toEqual({
			decision: 'within_cap',
			resolved_test_count: 2,
			limit: MAX_SAFE_TEST_FILES,
		});
		expect(parsed.resolved_test_files.map(norm).sort()).toEqual(sorted);
	}, 30_000);

	test('union overflow returns typed scope_exceeded with binding cap_decision, never a partial run', async () => {
		const fixture = makeFixture();
		write('src/alpha.ts', 'export const alpha = 1;\n', fixture);
		write('src/beta.ts', 'export const beta = 2;\n', fixture);
		for (let i = 0; i < MAX_SAFE_TEST_FILES + 5; i++) {
			write(
				`tests/t${String(i).padStart(2, '0')}.test.ts`,
				`import { test, expect } from 'bun:test';\nimport { alpha } from '../src/alpha';\nimport { beta } from '../src/beta';\n\ntest('t${i}', () => { expect(alpha + beta).toBe(3); });\n`,
				fixture,
			);
		}
		const parsed = parse(
			await execute(
				{
					scope: 'impact',
					files: ['src/alpha.ts', 'src/beta.ts'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.outcome).toBe('scope_exceeded');
		expect(parsed.cap_decision?.decision).toBe('cap_exceeded');
		expect(parsed.cap_decision?.limit).toBe(MAX_SAFE_TEST_FILES);
		expect(parsed.cap_decision?.resolved_test_count).toBeGreaterThanOrEqual(
			MAX_SAFE_TEST_FILES,
		);
	}, 60_000);

	test('high occurrence count with small dedup union runs (budget bounds the union, not occurrences)', async () => {
		// The discriminating shape for the analyzer budget: 6 sources whose
		// impact-map rows all list the SAME 10 tests = 60 occurrences but a
		// deduplicated union of 10 (well under the cap). The budget must bound
		// the union — counting occurrences would spuriously return
		// scope_exceeded here.
		const fixture = makeFixture();
		const sources = 6;
		const uniqueTests = 10;
		for (let s = 0; s < sources; s++) {
			write(`src/mod${s}.ts`, `export const v${s} = ${s};\n`, fixture);
		}
		for (let t = 0; t < uniqueTests; t++) {
			write(
				`tests/u${String(t).padStart(2, '0')}.test.ts`,
				`import { test, expect } from 'bun:test';\n${Array.from(
					{ length: sources },
					(_, s) => `import { v${s} } from '../src/mod${s}';`,
				).join('\n')}\n\ntest('u${t}', () => { expect(true).toBe(true); });\n`,
				fixture,
			);
		}
		// Seed the impact map: every source maps to ALL 10 unique tests.
		const cacheDir = path.join(fixture, '.swarm', 'cache');
		fs.mkdirSync(cacheDir, { recursive: true });
		const map: Record<string, string[]> = {};
		for (let s = 0; s < sources; s++) {
			map[norm(path.join(fixture, `src/mod${s}.ts`))] = Array.from(
				{ length: uniqueTests },
				(_, t) =>
					norm(
						path.join(fixture, `tests/u${String(t).padStart(2, '0')}.test.ts`),
					),
			);
		}
		fs.writeFileSync(
			path.join(cacheDir, 'impact-map.json'),
			JSON.stringify({
				// Far-future generatedAt keeps the seeded cache fresh regardless of
				// fixture file mtimes (derived form; deterministic).
				generatedAt: new Date('2099-01-01T00:00:00.000Z').toISOString(),
				fileCount: sources,
				map,
			}),
		);

		const parsed = parse(
			await execute(
				{
					scope: 'impact',
					files: Array.from({ length: sources }, (_, s) => `src/mod${s}.ts`),
					working_directory: fixture,
				},
				undefined,
			),
		);
		expect(parsed.success).toBe(true);
		expect(parsed.outcome).toBe('pass');
		expect(parsed.cap_decision?.decision).toBe('within_cap');
		expect(parsed.cap_decision?.resolved_test_count).toBe(uniqueTests);
	}, 60_000);

	test('zero impacted tests is the typed no_impacted_tests outcome, distinct from error', async () => {
		const fixture = makeFixture();
		write('src/lonely.ts', 'export const lonely = 1;\n', fixture);
		const parsed = parse(
			await execute(
				{
					scope: 'impact',
					files: ['src/lonely.ts'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.outcome).toBe('no_impacted_tests');
		expect(parsed.outcome).not.toBe('error');
		expect(parsed.cap_decision?.decision).toBe('within_cap');
		expect(parsed.resolved_test_files).toEqual([]);
	}, 30_000);

	test('graph discovery completes on external ESM imports instead of hanging', async () => {
		const fixture = makeFixture();
		write('src/alpha.ts', 'export const alpha = 1;\n', fixture);
		// External package import: the historical non-advancing regex loop hung
		// here forever. Bun's test-level timeout bounds this if it regresses.
		write(
			'tests/alpha.test.ts',
			"import { test, expect } from 'bun:test';\nimport { alpha } from '../src/alpha';\n\ntest('alpha', () => { expect(alpha).toBe(1); });\n",
			fixture,
		);
		const parsed = parse(
			await execute(
				{
					scope: 'graph',
					files: ['src/alpha.ts'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		// Completion is the contract: it ran (or typed outcome), never a hang.
		expect(parsed.outcome).toBe('pass');
		expect((parsed.command ?? []).map(norm)).toContain('tests/alpha.test.ts');
	}, 30_000);

	test('multi-source regression path is reported, not swallowed (preserving case)', async () => {
		const fixture = makeFixture();
		write('src/alpha.ts', 'export const alpha = 1;\n', fixture);
		write('src/beta.ts', 'export const beta = 2;\n', fixture);
		write(
			'tests/alpha.test.ts',
			"import { test, expect } from 'bun:test';\nimport { alpha } from '../src/alpha';\nimport { beta } from '../src/beta';\n\ntest('wrong expectation', () => { expect(alpha + beta).toBe(99); });\n",
			fixture,
		);
		const parsed = parse(
			await execute(
				{
					scope: 'graph',
					files: ['src/alpha.ts', 'src/beta.ts'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		expect(parsed.outcome).toBe('regression');
		expect(parsed.cap_decision?.decision).toBe('within_cap');
	}, 30_000);
});
