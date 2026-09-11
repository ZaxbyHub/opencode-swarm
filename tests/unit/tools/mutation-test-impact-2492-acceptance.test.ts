import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildImpactMap,
	loadImpactMap,
} from '../../../src/test-impact/analyzer';
import { mutation_test } from '../../../src/tools/mutation-test';
import { MAX_SAFE_TEST_FILES } from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;

beforeEach(() => {
	tempDir = canonicalMkdtemp('mutation-impact-2492-');
	fs.mkdirSync(path.join(tempDir, '.git'));
	fs.writeFileSync(
		path.join(tempDir, 'package.json'),
		JSON.stringify({
			name: 'mutation-impact-2492',
			scripts: { test: 'bun test' },
		}),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function patch(): Record<string, unknown> {
	return {
		id: 'value-change',
		filePath: 'src/value.ts',
		functionName: 'value',
		mutationType: 'return_value',
		patch: [
			'diff --git a/src/value.ts b/src/value.ts',
			'--- a/src/value.ts',
			'+++ b/src/value.ts',
			'@@ -1 +1 @@',
			'-export function value() { return 1; }',
			'+export function value() { return 2; }',
		].join('\n'),
	};
}

function runTool(args: Record<string, unknown>): Promise<string> {
	return mutation_test.execute({ ...args, working_directory: tempDir }, {
		directory: tempDir,
	} as never) as Promise<string>;
}

function markerTest(markerPath: string, expectation: string): string {
	return [
		"import { writeFileSync } from 'node:fs';",
		"import { value } from '../src/value';",
		`test('mutation target', () => { writeFileSync(${JSON.stringify(markerPath)}, 'ran'); expect(value()).toBe(${expectation}); });`,
	].join('\n');
}

function unrelatedMarkerTest(markerPath: string): string {
	return [
		"import { writeFileSync } from 'node:fs';",
		`test('unrelated test', () => { writeFileSync(${JSON.stringify(markerPath)}, 'ran'); });`,
	].join('\n');
}

describe('issue #2492: mutation_test impact selection', () => {
	test('auto-derives impacted files and does not run the full suite', async () => {
		fs.mkdirSync(path.join(tempDir, 'src'));
		fs.mkdirSync(path.join(tempDir, 'tests'));
		fs.writeFileSync(
			path.join(tempDir, 'src', 'value.ts'),
			'export function value() { return 1; }\n',
		);
		const selectedMarker = path.join(tempDir, 'selected.marker');
		const unrelatedMarker = path.join(tempDir, 'unrelated.marker');
		fs.writeFileSync(
			path.join(tempDir, 'tests', 'selected.test.ts'),
			markerTest(selectedMarker, '1'),
		);
		fs.writeFileSync(
			path.join(tempDir, 'tests', 'unrelated.test.ts'),
			`${unrelatedMarkerTest(unrelatedMarker)}\nthrow new Error('full suite must not run');\n`,
		);
		await buildImpactMap(tempDir);
		const impactBefore = await loadImpactMap(tempDir);
		const sourceBefore = fs.readFileSync(
			path.join(tempDir, 'src', 'value.ts'),
			'utf8',
		);

		const raw = await runTool({
			patches: [patch()],
			test_command: ['bun', 'test'],
		});
		expect(raw).toMatch(
			/files must be a non-empty array of file paths|verdict/,
		);
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(parsed.verdict).toBe('pass');
		expect(parsed.selection).toMatchObject({
			kind: 'impact',
			sourceFiles: ['src/value.ts'],
			testFiles: ['tests/selected.test.ts'],
			cap: MAX_SAFE_TEST_FILES,
			fallbackReason: null,
			evaluable: true,
		});
		expect(fs.existsSync(selectedMarker)).toBe(true);
		expect(fs.existsSync(unrelatedMarker)).toBe(false);
		expect(fs.readFileSync(path.join(tempDir, 'src', 'value.ts'), 'utf8')).toBe(
			sourceBefore,
		);
		expect(await loadImpactMap(tempDir)).toEqual(impactBefore);
	});

	test('explicit files override impact-derived files', async () => {
		fs.mkdirSync(path.join(tempDir, 'src'));
		fs.mkdirSync(path.join(tempDir, 'tests'));
		fs.writeFileSync(
			path.join(tempDir, 'src', 'value.ts'),
			'export function value() { return 1; }\n',
		);
		const explicitMarker = path.join(tempDir, 'explicit.marker');
		const impactMarker = path.join(tempDir, 'impact.marker');
		fs.writeFileSync(
			path.join(tempDir, 'tests', 'impact.test.ts'),
			markerTest(impactMarker, '1'),
		);
		fs.writeFileSync(
			path.join(tempDir, 'tests', 'explicit.test.ts'),
			markerTest(explicitMarker, '1'),
		);
		await buildImpactMap(tempDir);

		const parsed = JSON.parse(
			await runTool({
				patches: [patch()],
				files: ['tests/explicit.test.ts'],
				test_command: ['bun', 'test'],
			}),
		) as Record<string, unknown>;

		expect(parsed.selection).toMatchObject({
			kind: 'explicit',
			testFiles: ['tests/explicit.test.ts'],
		});
	});

	test('no impact returns a typed unevaluable skip without running a full suite', async () => {
		fs.mkdirSync(path.join(tempDir, 'src'));
		fs.mkdirSync(path.join(tempDir, 'tests'));
		fs.writeFileSync(
			path.join(tempDir, 'src', 'value.ts'),
			'export function value() { return 1; }\n',
		);
		const unrelatedMarker = path.join(tempDir, 'unrelated.marker');
		fs.writeFileSync(
			path.join(tempDir, 'tests', 'unrelated.test.ts'),
			`${unrelatedMarkerTest(unrelatedMarker)}\nthrow new Error('must not run');\n`,
		);
		await buildImpactMap(tempDir);

		const raw = await runTool({
			patches: [patch()],
			test_command: ['bun', 'test'],
		});
		expect(raw).toMatch(
			/files must be a non-empty array of file paths|verdict/,
		);
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(parsed.verdict).toBe('skip');
		expect(parsed.outcome).toBe('unevaluable');
		expect(parsed.selection).toMatchObject({
			kind: 'impact',
			sourceFiles: ['src/value.ts'],
			testFiles: [],
			cap: MAX_SAFE_TEST_FILES,
			fallbackReason: expect.any(String),
			evaluable: false,
		});
		expect(fs.existsSync(unrelatedMarker)).toBe(false);
	});
});
