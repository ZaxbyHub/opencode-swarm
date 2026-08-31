import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { repo_map } from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { writeKg15Workspace } from './repo-map-kg15.fixture';

let tmp = '';

function call(args: Record<string, unknown>): Promise<string> {
	type Executable = {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	return (repo_map as unknown as Executable).execute(args, { directory: tmp });
}

function parse(out: string): Record<string, unknown> {
	return JSON.parse(out) as Record<string, unknown>;
}

describe('repo_map: test_pack (KG-15, issue #1536)', () => {
	beforeEach(() => {
		tmp = canonicalMkdtemp('repo-map-kg15-pack-');
		writeKg15Workspace(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('packs tests for an implementation file with explicit-import coverage (colocated fixture)', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'test_pack', file: 'src/lib/calc.ts' }),
		);
		expect(r.success).toBe(true);
		expect(r.target).toEqual({
			files: ['src/lib/calc.ts'],
			symbol: null,
		});
		const tests = r.tests as Array<Record<string, unknown>>;
		expect(tests.length).toBe(1);
		expect(tests[0]).toMatchObject({
			file: 'src/lib/calc.test.ts',
			basis: 'import',
			confidence: 'high',
			evidence: './calc',
		});
		expect(tests[0].coveredSymbols).toEqual(['add']);
		// unusedHelper has no detected coverage → uncovered + risk note hint.
		const uncovered = r.uncoveredExports as Array<Record<string, unknown>>;
		expect(uncovered).toEqual([
			{ file: 'src/lib/calc.ts', symbol: 'unusedHelper' },
		]);
		expect((r.riskNotes as string[]).join('\n')).toContain(
			'1 exported symbol(s) without detected test coverage in src/lib/calc.ts',
		);
	});

	test('associates a non-importing colocated spec via the name heuristic', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'test_pack', file: 'src/lib/widget.ts' }),
		);
		const tests = r.tests as Array<Record<string, unknown>>;
		expect(tests.length).toBe(1);
		expect(tests[0]).toMatchObject({
			file: 'src/lib/widget.spec.ts',
			basis: 'colocated',
			confidence: 'medium',
			evidence: 'colocated sibling of widget.ts',
		});
		expect(r.associations).toContainEqual({
			kind: 'TESTS',
			fromFile: 'src/lib/widget.spec.ts',
			toFile: 'src/lib/widget.ts',
			evidence: 'colocated sibling of widget.ts',
			confidence: 'medium',
		});
		expect((r.riskNotes as string[]).join('\n')).toContain(
			'test association for src/lib/widget.ts relies on colocated-name heuristics only',
		);
	});

	test('surfaces fixtures and tests for the service used by route and test', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'test_pack', file: 'src/services/user-service.ts' }),
		);
		const tests = r.tests as Array<Record<string, unknown>>;
		expect(tests.length).toBe(1);
		expect(tests[0].file).toBe('src/services/user-service.test.ts');
		expect(tests[0].coveredSymbols).toEqual(['createUser']);
		const fixtures = r.fixtures as Array<Record<string, unknown>>;
		expect(fixtures.length).toBe(1);
		expect(fixtures[0].file).toBe('src/test-fixtures/users.fixture.ts');
		expect(fixtures[0].usedBy).toEqual(['src/services/user-service.test.ts']);
		expect(fixtures[0].confidence).toBe('medium');
		expect(fixtures[0].evidence).toBe('../test-fixtures/users.fixture');
		// Derived TESTS/USES_FIXTURE associations surface the link kinds.
		const assoc = r.associations as Array<Record<string, unknown>>;
		expect(assoc).toContainEqual({
			kind: 'USES_FIXTURE',
			fromFile: 'src/services/user-service.test.ts',
			toFile: 'src/test-fixtures/users.fixture.ts',
			evidence: '../test-fixtures/users.fixture',
			confidence: 'medium',
		});
		expect(assoc).toContainEqual({
			kind: 'TESTS',
			fromFile: 'src/services/user-service.test.ts',
			toFile: 'src/services/user-service.ts',
			evidence: './user-service',
			confidence: 'high',
		});
	});

	test('accepts a files list (change form) and merges tests', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({
				action: 'test_pack',
				files: ['src/lib/calc.ts', 'src/lib/widget.ts'],
			}),
		);
		expect(r.target).toEqual({
			files: ['src/lib/calc.ts', 'src/lib/widget.ts'],
			symbol: null,
		});
		const testFiles = (r.tests as Array<Record<string, unknown>>).map(
			(t) => t.file,
		);
		expect(testFiles).toEqual([
			'src/lib/calc.test.ts',
			'src/lib/widget.spec.ts',
		]);
	});

	test('accepts a diff (change form) and resolves changed files', async () => {
		await call({ action: 'build' });
		const diff = [
			'diff --git a/src/lib/calc.ts b/src/lib/calc.ts',
			'--- a/src/lib/calc.ts',
			'+++ b/src/lib/calc.ts',
			'@@ -1,4 +1,5 @@',
			' export function add(a: number, b: number): number {',
			'-\treturn a + b;',
			'+\treturn (a + b) | 0;',
			' }',
		].join('\n');
		const r = parse(await call({ action: 'test_pack', diff }));
		expect(r.success).toBe(true);
		expect(r.target).toEqual({ files: ['src/lib/calc.ts'], symbol: null });
		const tests = r.tests as Array<Record<string, unknown>>;
		expect(tests.map((t) => t.file)).toEqual(['src/lib/calc.test.ts']);
	});

	test('warns when no tests exist for the target', async () => {
		await call({ action: 'build' });
		const r = parse(
			await call({ action: 'test_pack', file: 'app/api/orders/route.ts' }),
		);
		expect(r.success).toBe(true);
		expect(r.tests).toEqual([]);
		expect((r.riskNotes as string[]).join('\n')).toContain(
			'no tests detected for app/api/orders/route.ts',
		);
	});

	test('rejects invalid inputs', async () => {
		await call({ action: 'build' });
		const noTarget = parse(await call({ action: 'test_pack' }));
		expect(noTarget.success).toBe(false);
		expect(noTarget.error).toContain('test_pack requires');

		const traversal = parse(
			await call({ action: 'test_pack', file: '../outside.ts' }),
		);
		expect(traversal.success).toBe(false);
		expect(traversal.error).toContain('traversal');

		const badDiff = parse(
			await call({ action: 'test_pack', diff: 'not a real diff' }),
		);
		// An unparseable diff surfaces the same structured error envelope as
		// diff_context (getDiffContext throws; the handler wraps it).
		expect(badDiff.success).toBe(false);
		expect(String(badDiff.error)).toContain('diff');
	});

	test('errors when the graph is missing', async () => {
		const r = parse(
			await call({ action: 'test_pack', file: 'src/lib/calc.ts' }),
		);
		expect(r.success).toBe(false);
		expect(r.error).toContain('No repo graph found');
	});
});
