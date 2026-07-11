import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Spread real engine exports so named imports the tool relies on
// (validateTestCommand, etc.) survive the mock. See AGENTS.md invariant 7.
import * as realEngine from '../../mutation/engine.js';

// Mock functions defined at module level - will be used in mock.module calls
const mockExecuteMutationSuiteFn = mock(async () => ({
	totalMutants: 10,
	killed: 8,
	survived: 2,
	timeout: 0,
	equivalent: 0,
	skipped: 0,
	errors: 0,
	killRate: 0.8,
	adjustedKillRate: 0.8,
	perFunction: new Map(),
	results: [],
	durationMs: 100,
	budgetMs: 300000,
	budgetExceeded: false,
	timestamp: '2024-01-01T00:00:00.000Z',
}));

const mockEvaluateMutationGateFn = mock(() => ({
	verdict: 'pass' as const,
	killRate: 0.8,
	adjustedKillRate: 0.8,
	totalMutants: 10,
	killed: 8,
	survived: 2,
	threshold: 0.8,
	warnThreshold: 0.6,
	message: 'Mutation gate PASSED: 80% kill rate (8/10 mutants killed)',
	survivedMutants: [],
	testImprovementPrompt: '',
}));

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'mutation-sourcefiles-'));

	// Reset mock call history between tests
	mockExecuteMutationSuiteFn.mockReset();
	mockEvaluateMutationGateFn.mockReset();

	// Mock engine and gate modules
	mock.module('../../mutation/engine.js', () => ({
		...realEngine,
		executeMutationSuite: mockExecuteMutationSuiteFn,
	}));

	mock.module('../../mutation/gate.js', () => ({
		evaluateMutationGate: mockEvaluateMutationGateFn,
		MutationGateResult: {},
	}));
});

afterEach(() => {
	mock.restore();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('mutation_test sourceFiles wiring', () => {
	describe('sourceFiles Map building', () => {
		test('1. sourceFiles is passed to executeMutationSuite with correct content', async () => {
			// Create a real file to read
			const testFilePath = path.join(tmpDir, 'src', 'foo.ts');
			mkdirSync(path.dirname(testFilePath), { recursive: true });

			const fs = await import('node:fs');
			fs.writeFileSync(testFilePath, 'export function foo() { return 1; }');

			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;

			const args = {
				patches: [
					{
						id: 'patch-1',
						filePath: 'src/foo.ts',
						functionName: 'foo',
						mutationType: 'off_by_one',
						patch:
							'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\nexport function foo() { return 1; }',
					},
				],
				files: ['test/foo.test.ts'],
				test_command: ['npx', 'vitest', '--run'],
				working_directory: tmpDir,
			};

			await execute(args, tmpDir);

			// Verify executeMutationSuite was called
			expect(mockExecuteMutationSuiteFn).toHaveBeenCalled();

			const lastCall = mockExecuteMutationSuiteFn.mock.calls[0];
			const sourceFilesArg = (lastCall as any[])[6];

			// sourceFiles should be a Map with the file content
			expect(sourceFilesArg).toBeDefined();
			expect(sourceFilesArg).toBeInstanceOf(Map);
			expect(sourceFilesArg!.size).toBe(1);
			expect(sourceFilesArg!.get('src/foo.ts')).toBe(
				'export function foo() { return 1; }',
			);
		});

		test('2. deduplicated filePaths - only one entry per unique file', async () => {
			// Create real files
			const testFilePath = path.join(tmpDir, 'src', 'shared.ts');
			mkdirSync(path.dirname(testFilePath), { recursive: true });

			const fs = await import('node:fs');
			fs.writeFileSync(testFilePath, 'export function shared() { return 1; }');

			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;

			const args = {
				patches: [
					{
						id: 'patch-1',
						filePath: 'src/shared.ts',
						functionName: 'shared',
						mutationType: 'off_by_one',
						patch:
							'--- a/src/shared.ts\n+++ b/src/shared.ts\n@@ -1 +1 @@\nexport function shared() { return 1; }',
					},
					{
						id: 'patch-2',
						filePath: 'src/shared.ts', // Same file - should be deduplicated
						functionName: 'shared',
						mutationType: 'null_substitution',
						patch:
							'--- a/src/shared.ts\n+++ b/src/shared.ts\n@@ -1 +1 @@\nexport function shared() { return 1; }',
					},
				],
				files: ['test/shared.test.ts'],
				test_command: ['npx', 'vitest', '--run'],
				working_directory: tmpDir,
			};

			await execute(args, tmpDir);

			// Verify executeMutationSuite was called
			expect(mockExecuteMutationSuiteFn).toHaveBeenCalled();

			const lastCall = mockExecuteMutationSuiteFn.mock.calls[0];
			const sourceFilesArg = (lastCall as any[])[6];

			// sourceFiles should have only 1 entry (deduplicated)
			expect(sourceFilesArg).toBeInstanceOf(Map);
			expect(sourceFilesArg!.size).toBe(1);
		});
	});

	describe('missing file handling', () => {
		test('3. when some files missing, readable files are still included', async () => {
			// Create only one of the two files
			const readableFilePath = path.join(tmpDir, 'src', 'existent.ts');
			mkdirSync(path.dirname(readableFilePath), { recursive: true });

			const fs = await import('node:fs');
			fs.writeFileSync(
				readableFilePath,
				'export function existent() { return 1; }',
			);
			// src/missing.ts does NOT exist

			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;

			const args = {
				patches: [
					{
						id: 'patch-1',
						filePath: 'src/existent.ts',
						functionName: 'existent',
						mutationType: 'off_by_one',
						patch:
							'--- a/src/existent.ts\n+++ b/src/existent.ts\n@@ -1 +1 @@\nexport function existent() { return 1; }',
					},
					{
						id: 'patch-2',
						filePath: 'src/missing.ts', // This file doesn't exist
						functionName: 'missing',
						mutationType: 'null_substitution',
						patch:
							'--- a/src/missing.ts\n+++ b/src/missing.ts\n@@ -1 +1 @@\nexport function missing() { return 2; }',
					},
				],
				files: ['test/existent.test.ts'],
				test_command: ['npx', 'vitest', '--run'],
				working_directory: tmpDir,
			};

			await execute(args, tmpDir);

			// Verify executeMutationSuite was called
			expect(mockExecuteMutationSuiteFn).toHaveBeenCalled();

			const lastCall = mockExecuteMutationSuiteFn.mock.calls[0];
			const sourceFilesArg = (lastCall as any[])[6];

			// sourceFiles should have only 1 entry (the readable one)
			expect(sourceFilesArg).toBeInstanceOf(Map);
			expect(sourceFilesArg!.size).toBe(1);
			expect(sourceFilesArg!.has('src/existent.ts')).toBe(true);
			expect(sourceFilesArg!.has('src/missing.ts')).toBe(false);
		});

		test('4. when all files missing, sourceFiles is undefined', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;

			const args = {
				patches: [
					{
						id: 'patch-1',
						filePath: 'src/nonexistent1.ts',
						functionName: 'foo',
						mutationType: 'off_by_one',
						patch:
							'--- a/src/nonexistent1.ts\n+++ b/src/nonexistent1.ts\n@@ -1 +1 @@\nexport function foo() { return 1; }',
					},
					{
						id: 'patch-2',
						filePath: 'src/nonexistent2.ts',
						functionName: 'bar',
						mutationType: 'null_substitution',
						patch:
							'--- a/src/nonexistent2.ts\n+++ b/src/nonexistent2.ts\n@@ -1 +1 @@\nexport function bar() { return 2; }',
					},
				],
				files: ['test/foo.test.ts'],
				test_command: ['npx', 'vitest', '--run'],
				working_directory: tmpDir,
			};

			await execute(args, tmpDir);

			// Verify executeMutationSuite was called
			expect(mockExecuteMutationSuiteFn).toHaveBeenCalled();

			const lastCall = mockExecuteMutationSuiteFn.mock.calls[0];
			const sourceFilesArg = (lastCall as any[])[6];

			// When no files can be read, sourceFiles should be undefined
			expect(sourceFilesArg).toBeUndefined();
		});

		test('5. when all files readable, sourceFiles is a Map (not undefined)', async () => {
			// Create real files
			const filePath1 = path.join(tmpDir, 'src', 'foo.ts');
			const filePath2 = path.join(tmpDir, 'src', 'bar.ts');
			mkdirSync(path.dirname(filePath1), { recursive: true });
			mkdirSync(path.dirname(filePath2), { recursive: true });

			const fs = await import('node:fs');
			fs.writeFileSync(filePath1, 'export function foo() { return 1; }');
			fs.writeFileSync(filePath2, 'export function bar() { return 2; }');

			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;

			const args = {
				patches: [
					{
						id: 'patch-1',
						filePath: 'src/foo.ts',
						functionName: 'foo',
						mutationType: 'off_by_one',
						patch:
							'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\nexport function foo() { return 1; }',
					},
					{
						id: 'patch-2',
						filePath: 'src/bar.ts',
						functionName: 'bar',
						mutationType: 'null_substitution',
						patch:
							'--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -1 +1 @@\nexport function bar() { return 2; }',
					},
				],
				files: ['test/foo.test.ts', 'test/bar.test.ts'],
				test_command: ['npx', 'vitest', '--run'],
				working_directory: tmpDir,
			};

			await execute(args, tmpDir);

			// Verify executeMutationSuite was called
			expect(mockExecuteMutationSuiteFn).toHaveBeenCalled();

			const lastCall = mockExecuteMutationSuiteFn.mock.calls[0];
			const sourceFilesArg = (lastCall as any[])[6];

			// When files can be read, sourceFiles should be a Map
			expect(sourceFilesArg).toBeInstanceOf(Map);
			expect(sourceFilesArg!.size).toBe(2);
		});
	});

	describe('empty patches validation', () => {
		test('6. empty patches array returns error before sourceFiles are built', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;

			const args = {
				patches: [],
				files: ['test/foo.test.ts'],
				test_command: ['npx', 'vitest', '--run'],
			};

			const result = await execute(args, tmpDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('patches must be a non-empty array');

			// executeMutationSuite should NOT have been called
			expect(mockExecuteMutationSuiteFn).not.toHaveBeenCalled();
		});

		test('7. undefined patches returns error', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;

			const args = {
				patches: undefined,
				files: ['test/foo.test.ts'],
				test_command: ['npx', 'vitest', '--run'],
			};

			const result = await execute(args, tmpDir);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('patches must be a non-empty array');
		});
	});

	describe('sourceFiles argument position', () => {
		test('8. sourceFiles is the 7th argument (after patches, testCommand, testFiles, workingDir, budgetMs, onProgress)', async () => {
			// Create a real file
			const testFilePath = path.join(tmpDir, 'src', 'test.ts');
			mkdirSync(path.dirname(testFilePath), { recursive: true });

			const fs = await import('node:fs');
			fs.writeFileSync(testFilePath, 'export function test() { return 1; }');

			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;

			const args = {
				patches: [
					{
						id: 'patch-1',
						filePath: 'src/test.ts',
						functionName: 'test',
						mutationType: 'off_by_one',
						patch:
							'--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1 +1 @@\nexport function test() { return 1; }',
					},
				],
				files: ['test/test.test.ts'],
				test_command: ['npx', 'vitest', '--run'],
				working_directory: tmpDir,
			};

			await execute(args, tmpDir);

			expect(mockExecuteMutationSuiteFn).toHaveBeenCalled();

			// Verify all arguments are in correct positions
			const callArgs = mockExecuteMutationSuiteFn.mock.calls[0] as any[];
			expect(callArgs[0]).toEqual(args.patches); // patches
			expect(callArgs[1]).toEqual(args.test_command); // testCommand
			expect(callArgs[2]).toEqual(args.files); // testFiles
			expect(callArgs[3]).toBe(tmpDir); // workingDir
			expect(callArgs[4]).toBeUndefined(); // budgetMs
			expect(callArgs[5]).toBeUndefined(); // onProgress
			expect(callArgs[6]).toBeInstanceOf(Map); // sourceFiles
		});
	});
});
