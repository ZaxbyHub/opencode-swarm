import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type MutationCommandRunner,
	_internals as mutationInternals,
} from '../../../src/mutation/engine';
import { _internals as impactInternals } from '../../../src/test-impact/analyzer';
import { mutation_test } from '../../../src/tools/mutation-test';
import { MAX_SAFE_TEST_FILES } from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let tempDir: string;
let executionMarker: string;
const originalRunCommand = mutationInternals.runCommand;
const originalAnalyzeImpact = impactInternals.analyzeImpact;

function mutationPatch(): Record<string, unknown> {
	return {
		id: 'cap-check',
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

function runTool(files: string[]): Promise<string> {
	return mutation_test.execute(
		{
			patches: [mutationPatch()],
			files,
			test_command: ['bun', 'test'],
			working_directory: tempDir,
		},
		{ directory: tempDir } as never,
	) as Promise<string>;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('mutation-cap-2492-');
	fs.mkdirSync(path.join(tempDir, '.git'));
	fs.mkdirSync(path.join(tempDir, 'src'));
	fs.mkdirSync(path.join(tempDir, 'tests'));
	fs.writeFileSync(
		path.join(tempDir, 'src', 'value.ts'),
		'export function value() { return 1; }\n',
	);
	executionMarker = path.join(tempDir, 'mutation-engine-ran.marker');
	mutationInternals.runCommand = (async () => {
		fs.writeFileSync(executionMarker, 'ran');
		return {
			status: 'completed',
			exitCode: 0,
			stdout: '1 pass',
			stderr: '',
		};
	}) as MutationCommandRunner;
});

afterEach(() => {
	mutationInternals.runCommand = originalRunCommand;
	impactInternals.analyzeImpact = originalAnalyzeImpact;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('issue #2492: mutation_test explicit-file cap', () => {
	test('51 unique explicit test paths return a typed scope_exceeded skip before execution', async () => {
		const files = Array.from(
			{ length: MAX_SAFE_TEST_FILES + 1 },
			(_, index) => {
				const relative = `tests/test-${index}.test.ts`;
				fs.writeFileSync(
					path.join(tempDir, relative),
					"test('ok', () => {});\n",
				);
				return relative;
			},
		);

		const parsed = JSON.parse(await runTool(files)) as Record<string, unknown>;
		expect(parsed.outcome).toBe('scope_exceeded');
		expect(parsed.selection).toMatchObject({
			kind: 'explicit',
			testFiles: files,
			cap: MAX_SAFE_TEST_FILES,
			evaluable: false,
		});
		expect(fs.existsSync(executionMarker)).toBe(false);
	});

	test('explicit overflow evidence retains 51 paths and omits the remainder', async () => {
		const files = Array.from(
			{ length: MAX_SAFE_TEST_FILES + 10 },
			(_, index) => {
				const relative = `tests/overflow-${index}.test.ts`;
				fs.writeFileSync(
					path.join(tempDir, relative),
					"test('ok', () => {});\n",
				);
				return relative;
			},
		);

		const parsed = JSON.parse(await runTool(files)) as Record<string, unknown>;
		const selection = parsed.selection as Record<string, unknown>;
		const selectedFiles = selection.testFiles as string[];

		expect(parsed.outcome).toBe('scope_exceeded');
		expect(selectedFiles).toHaveLength(MAX_SAFE_TEST_FILES + 1);
		expect(selectedFiles.at(-1)).toBe(files[MAX_SAFE_TEST_FILES]);
		expect(selectedFiles).not.toContain(files[MAX_SAFE_TEST_FILES + 1]);
		expect(fs.existsSync(executionMarker)).toBe(false);
	});

	test('duplicate explicit paths count once toward the safe cap', async () => {
		const files = [
			...Array.from({ length: 30 }, () => 'tests/one.test.ts'),
			...Array.from({ length: 30 }, () => 'tests/two.test.ts'),
		];
		fs.writeFileSync(
			path.join(tempDir, 'tests', 'one.test.ts'),
			"test('one', () => {});\n",
		);
		fs.writeFileSync(
			path.join(tempDir, 'tests', 'two.test.ts'),
			"test('two', () => {});\n",
		);

		const parsed = JSON.parse(await runTool(files)) as Record<string, unknown>;
		expect(parsed.selection).toMatchObject({
			kind: 'explicit',
			testFiles: ['tests/one.test.ts', 'tests/two.test.ts'],
			cap: MAX_SAFE_TEST_FILES,
			evaluable: true,
		});
	});

	test('impact overflow retains exactly cap plus one bounded sentinel path', async () => {
		const files = Array.from(
			{ length: MAX_SAFE_TEST_FILES + 1 },
			(_, index) => `tests/impact-${index}.test.ts`,
		);
		for (const file of files) {
			fs.writeFileSync(path.join(tempDir, file), "test('ok', () => {});\n");
		}

		let observedBudget: number | undefined;
		impactInternals.analyzeImpact = async (_changedFiles, cwd, budget) => {
			observedBudget = budget;
			return {
				impactedTests: files.map((file) => path.resolve(cwd, file)),
				unrelatedTests: [],
				untestedFiles: [],
				impactMap: {},
				budgetExceeded: false,
			};
		};

		const parsed = JSON.parse(
			await mutation_test.execute(
				{
					patches: [mutationPatch()],
					test_command: ['bun', 'test'],
					working_directory: tempDir,
				},
				{ directory: tempDir } as never,
			),
		) as Record<string, unknown>;
		const selection = parsed.selection as Record<string, unknown>;
		const selectedFiles = selection.testFiles as string[];

		expect(observedBudget).toBe(MAX_SAFE_TEST_FILES + 1);
		expect(parsed.outcome).toBe('scope_exceeded');
		expect(selection.evaluable).toBe(false);
		expect(selectedFiles).toHaveLength(MAX_SAFE_TEST_FILES + 1);
		expect(selectedFiles.at(-1)).toBe(files.at(-1));
	});
});
