import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../../tests/helpers/tmpdir.js';
import { mutation_test } from '../../../src/tools/mutation-test.js';

/**
 * mutation_test analyzer-derived selection (issue #2492 AC3/AC10): explicit
 * files override, source_files derive via the impact analyzer, empty/failed
 * derivation takes a typed bounded fallback (never a broad run), evaluability
 * and outcome counts are reported, and a completed batch invalidates the
 * cached impact-map selection. Mirrors frozen checks c3/c7/c10.
 */

const execute = mutation_test.execute as unknown as (
	args: Record<string, unknown>,
	directory: string | undefined,
) => Promise<string>;

const norm = (p: string): string => p.replace(/\\/g, '/');

function makeFixture(): string {
	const dir = canonicalMkdtemp('mut-sel-');
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

const KILLABLE_PATCH = (file: string, fn: string) => ({
	id: 'm1',
	filePath: file,
	functionName: fn,
	mutationType: 'operator_flip',
	patch: `--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n export function ${fn}(a: number, b: number): number {\n-  return a + b;\n+  return a - b;\n }\n`,
});

describe('mutation_test selection + evaluability + cache refresh (issue #2492)', () => {
	test('source_files derive impacted tests via the impact analyzer', async () => {
		const fixture = makeFixture();
		write(
			'src/math.ts',
			'export function addM(a: number, b: number): number {\n  return a + b;\n}\n',
			fixture,
		);
		write(
			'tests/math.test.ts',
			"import { test, expect } from 'bun:test';\nimport { addM } from '../src/math';\n\ntest('addM', () => { expect(addM(1, 2)).toBe(3); });\n",
			fixture,
		);
		const parsed = parse(
			await execute(
				{
					patches: [KILLABLE_PATCH('src/math.ts', 'addM')],
					source_files: ['src/math.ts'],
					test_command: ['bun', 'test'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		expect(parsed.error).toBeUndefined();
		expect(parsed.test_selection?.source).toBe('impact_analysis');
		expect(parsed.test_selection?.resolved_test_files?.map(norm)).toContain(
			'tests/math.test.ts',
		);
		expect(parsed.evaluability?.evaluable).toBe(true);
		expect(typeof parsed.evaluability?.reason).toBe('string');
		expect(['pass', 'warn', 'fail']).toContain(parsed.verdict);
		expect(parsed.mutation_outcome_counts?.total).toBe(1);
		expect(parsed.mutation_outcome_counts?.killed).toBe(1);
	}, 60_000);

	test('explicit files win over derivation (override)', async () => {
		const fixture = makeFixture();
		write(
			'src/calc.ts',
			'export function addC(a: number, b: number): number {\n  return a + b;\n}\n',
			fixture,
		);
		write(
			'tests/calc.test.ts',
			"import { test, expect } from 'bun:test';\nimport { addC } from '../src/calc';\n\ntest('addC', () => { expect(addC(1, 2)).toBe(3); });\n",
			fixture,
		);
		const parsed = parse(
			await execute(
				{
					patches: [KILLABLE_PATCH('src/calc.ts', 'addC')],
					files: ['tests/calc.test.ts'],
					source_files: ['src/calc.ts'],
					test_command: ['bun', 'test'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		expect(parsed.test_selection?.source).toBe('explicit_override');
		expect(parsed.test_selection?.resolved_test_files?.map(norm)).toContain(
			'tests/calc.test.ts',
		);
	}, 60_000);

	test('derivation yielding nothing returns a typed bounded fallback (no run)', async () => {
		const fixture = makeFixture();
		write('src/orphan.ts', 'export const orphan = 1;\n', fixture);
		const parsed = parse(
			await execute(
				{
					patches: [KILLABLE_PATCH('src/orphan.ts', 'anything')],
					source_files: ['src/orphan.ts'],
					test_command: ['bun', 'test'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.test_selection?.source).toBe('fallback');
		expect(parsed.test_selection?.fallback_reason?.length ?? 0).toBeGreaterThan(
			0,
		);
		expect(parsed.evaluability?.evaluable).toBe(false);
	}, 30_000);

	test('derive-mode cap overflow is refused via the typed fallback, never a truncated partial run', async () => {
		const fixture = makeFixture();
		write(
			'src/math.ts',
			'export function addO(a: number, b: number): number {\n  return a + b;\n}\n',
			fixture,
		);
		// 55 distinct tests all importing the source: the analyzer truncates at
		// its budget with budgetExceeded=true — the refusal must fire on that
		// signal (the truncated length reads exactly 50, never > 50).
		for (let i = 0; i < 55; i++) {
			write(
				`tests/o${String(i).padStart(2, '0')}.test.ts`,
				`import { test, expect } from 'bun:test';\nimport { addO } from '../src/math';\n\ntest('o${i}', () => { expect(addO(1, 2)).toBe(3); });\n`,
				fixture,
			);
		}
		const parsed = parse(
			await execute(
				{
					patches: [KILLABLE_PATCH('src/math.ts', 'addO')],
					source_files: ['src/math.ts'],
					test_command: ['bun', 'test'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		// Typed bounded refusal — NOT impact_analysis with a silent 50-of-55 set.
		expect(parsed.test_selection?.source).toBe('fallback');
		expect(parsed.test_selection?.fallback_reason).toContain('safe cap');
		expect(parsed.test_selection?.resolved_test_files).toEqual([]);
		expect(parsed.evaluability?.evaluable).toBe(false);
		expect(parsed.success).toBe(false);
	}, 60_000);

	test('neither files nor source_files is rejected', async () => {
		const parsed = parse(
			await execute(
				{
					patches: [KILLABLE_PATCH('src/x.ts', 'f')],
					test_command: ['bun', 'test'],
					working_directory: makeFixture(),
				},
				undefined,
			),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error).toContain('provide either files');
	}, 10_000);

	test('a completed batch invalidates the cached impact-map selection', async () => {
		const fixture = makeFixture();
		write(
			'src/math.ts',
			'export function addK(a: number, b: number): number {\n  return a + b;\n}\n',
			fixture,
		);
		write(
			'tests/math.test.ts',
			"import { test, expect } from 'bun:test';\nimport { addK } from '../src/math';\n\ntest('addK', () => { expect(addK(2, 3)).toBe(5); });\n",
			fixture,
		);
		// Seed the cached selection explicitly (the analyzer's rebuild+save path).
		const { loadImpactMap } = await import(
			'../../../src/test-impact/analyzer.js'
		);
		await loadImpactMap(fixture);
		const cachePath = path.join(fixture, '.swarm', 'cache', 'impact-map.json');
		expect(fs.existsSync(cachePath)).toBe(true);
		const parsed = parse(
			await execute(
				{
					patches: [KILLABLE_PATCH('src/math.ts', 'addK')],
					files: ['tests/math.test.ts'],
					test_command: ['bun', 'test'],
					working_directory: fixture,
				},
				undefined,
			),
		);
		expect(parsed.cache_refreshed).toBe(true);
		// The cached selection was invalidated so the next load rebuilds fresh.
		expect(fs.existsSync(cachePath)).toBe(false);
	}, 90_000);
});
