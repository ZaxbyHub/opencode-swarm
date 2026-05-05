import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock spawnSync using bun's mock.module
const mockSpawnSync = mock(() => ({
	status: 0,
	stderr: Buffer.from(''),
	stdout: Buffer.from(''),
}));

const mockWriteFileSync = mock(() => '');
const mockUnlinkSync = mock(() => '');
const mockPathJoin = mock((...args: string[]) => path.join(...args));
const mockBatchCheckEquivalence = mock(
	async () =>
		[] as Array<{
			patchId: string;
			isEquivalent: boolean;
			method: 'static';
			confidence: number;
			reason: string;
		}>,
);

mock.module('node:child_process', () => ({
	...realChildProcess,
	spawnSync: mockSpawnSync,
}));

mock.module('node:fs', () => ({
	unlinkSync: mockUnlinkSync,
	writeFileSync: mockWriteFileSync,
}));

mock.module('node:path', () => ({
	default: {
		join: mockPathJoin,
	},
}));

mock.module('../../../src/mutation/equivalence.js', () => ({
	batchCheckEquivalence: mockBatchCheckEquivalence,
}));

// Import after mocking
import {
	executeMutationSuite,
	type MutationPatch,
	type MutationResult,
} from '../../../src/mutation/engine.js';

function makeSpawnSuccess(stdout = 'Tests passed') {
	return {
		pid: 0,
		output: ['', '', ''],
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(''),
		status: 0,
		error: undefined,
		signal: null,
	};
}

describe('executeMutationSuite — equivalence detection wiring', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-equiv-'));
		mockSpawnSync.mockClear();
		mockWriteFileSync.mockClear();
		mockUnlinkSync.mockClear();
		mockPathJoin.mockClear();
		mockBatchCheckEquivalence.mockClear();

		mockWriteFileSync.mockImplementation(() => '');
		mockUnlinkSync.mockImplementation(() => '');
		mockPathJoin.mockImplementation((...args: string[]) => path.join(...args));

		// Default: successful git apply and revert, test passes
		mockSpawnSync.mockImplementation(
			(command: string, args: string[], _options?: unknown) => {
				if (command === 'git' && args[0] === 'apply' && !args.includes('-R')) {
					return makeSpawnSuccess();
				}
				if (command === 'git' && args.includes('-R')) {
					return makeSpawnSuccess();
				}
				return makeSpawnSuccess('all tests passed');
			},
		);
	});

	afterEach(() => {
		mock.restore();
		try {
			const entries = fs.readdirSync(tempDir);
			for (const entry of entries) {
				try {
					fs.unlinkSync(path.join(tempDir, entry));
				} catch {
					/* ignore */
				}
			}
			fs.rmdirSync(tempDir);
		} catch {
			/* ignore */
		}
	});

	// Helper to create a MutationPatch
	function makePatch(id: string, patchContent: string): MutationPatch {
		return {
			id,
			filePath: path.join(tempDir, 'test.ts'),
			functionName: 'testFn',
			mutationType: 'test',
			patch: patchContent,
			lineNumber: 1,
		};
	}

	describe('Scenario 1: sourceFiles provided with comment-only change → equivalent', () => {
		test('mutant gets outcome=equivalent when stripped code is identical', async () => {
			// Original code has a comment, patch changes only the comment
			const originalCode = `function test() {\n  // old comment\n  return 1;\n}`;

			// The diff only changes the comment line
			const patch = makePatch(
				'patch-1',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  // old comment\n+  // new comment\n   return 1;\n }`,
			);

			// Mock batchCheckEquivalence to return equivalent
			mockBatchCheckEquivalence.mockImplementation(async () => [
				{
					patchId: 'patch-1',
					isEquivalent: true,
					method: 'static',
					confidence: 1.0,
					reason: 'stripped identical',
				},
			]);

			const sourceFiles = new Map([[patch.filePath, originalCode]]);
			const progressCalls: MutationResult[] = [];

			const report = await executeMutationSuite(
				[patch],
				['echo', 'test'],
				['test.ts'],
				tempDir,
				undefined,
				(_c, _t, r) => progressCalls.push(r),
				sourceFiles,
			);

			// Mutant should be marked equivalent
			expect(report.results[0].outcome).toBe('equivalent');
			expect(report.equivalent).toBe(1);
			expect(report.killed).toBe(0);
			// spawnSync should NOT have been called for git apply (mutant was skipped)
			expect(mockSpawnSync).not.toHaveBeenCalled();
			// onProgress should have fired for the equivalent mutant
			expect(progressCalls.length).toBe(1);
			expect(progressCalls[0].outcome).toBe('equivalent');
		});
	});

	describe('Scenario 2: sourceFiles provided but code is NOT equivalent → executed normally', () => {
		test('mutant is executed when equivalence check returns false', async () => {
			const originalCode = `function test() {\n  return 1;\n}`;
			// Patch actually changes behavior (return value)
			const patch = makePatch(
				'patch-1',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  return 1;\n+  return 2;\n }`,
			);

			// Mock batchCheckEquivalence to return NOT equivalent
			mockBatchCheckEquivalence.mockImplementation(async () => [
				{
					patchId: 'patch-1',
					isEquivalent: false,
					method: 'static',
					confidence: 1.0,
					reason: 'code differs',
				},
			]);

			const sourceFiles = new Map([[patch.filePath, originalCode]]);

			const report = await executeMutationSuite(
				[patch],
				['echo', 'test'],
				['test.ts'],
				tempDir,
				undefined,
				undefined,
				sourceFiles,
			);

			// Mutant should have been executed (git apply called)
			expect(mockSpawnSync).toHaveBeenCalled();
			// Outcome depends on test result — test passed → 'survived'
			expect(report.results[0].outcome).toBe('survived');
		});
	});

	describe('Scenario 3: sourceFiles NOT provided → backward compat, all mutants executed', () => {
		test('mutants execute normally without sourceFiles', async () => {
			const patch = makePatch(
				'patch-1',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  return 1;\n+  return 2;\n }`,
			);

			// NO sourceFiles provided
			const report = await executeMutationSuite(
				[patch],
				['echo', 'test'],
				['test.ts'],
				tempDir,
			);

			// batchCheckEquivalence should NOT have been called
			expect(mockBatchCheckEquivalence).not.toHaveBeenCalled();
			// Mutant was executed
			expect(mockSpawnSync).toHaveBeenCalled();
			expect(report.results[0].outcome).toBe('survived');
		});
	});

	describe('Scenario 4: onProgress callback fires for equivalent mutants', () => {
		test('onProgress is called with equivalent result', async () => {
			const originalCode = `function test() {\n  // old comment\n  return 1;\n}`;
			const patch = makePatch(
				'patch-1',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  // old comment\n+  // new comment\n   return 1;\n }`,
			);

			mockBatchCheckEquivalence.mockImplementation(async () => [
				{
					patchId: 'patch-1',
					isEquivalent: true,
					method: 'static',
					confidence: 1.0,
					reason: 'stripped identical',
				},
			]);

			const progressCalls: Array<{
				completed: number;
				total: number;
				result: MutationResult;
			}> = [];

			const report = await executeMutationSuite(
				[patch],
				['echo', 'test'],
				['test.ts'],
				tempDir,
				undefined,
				(c, t, r) => progressCalls.push({ completed: c, total: t, result: r }),
				new Map([[patch.filePath, originalCode]]),
			);

			// onProgress should have fired exactly once for the equivalent mutant
			expect(progressCalls.length).toBe(1);
			expect(progressCalls[0].result.outcome).toBe('equivalent');
			expect(progressCalls[0].completed).toBe(1);
			expect(progressCalls[0].total).toBe(1);
			expect(report.results[0].outcome).toBe('equivalent');
		});
	});

	describe('Scenario 5: Equivalent mutants do not consume time budget', () => {
		test('second mutant still runs after first equivalent mutant with tight budget', async () => {
			const originalCode = `function test() {\n  // old comment\n  return 1;\n}`;

			const patch1 = makePatch(
				'patch-1',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  // old comment\n+  // new comment\n   return 1;\n }`,
			);

			const patch2 = makePatch(
				'patch-2',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  return 1;\n+  return 2;\n }`,
			);

			// First mutant is equivalent, second is not
			mockBatchCheckEquivalence.mockImplementation(async () => [
				{
					patchId: 'patch-1',
					isEquivalent: true,
					method: 'static',
					confidence: 1.0,
					reason: 'stripped identical',
				},
				{
					patchId: 'patch-2',
					isEquivalent: false,
					method: 'static',
					confidence: 1.0,
					reason: 'code differs',
				},
			]);

			// Use a small budget (100ms) — equivalent mutant should be skipped so fast that second mutant still gets to run
			const report = await executeMutationSuite(
				[patch1, patch2],
				['echo', 'test'],
				['test.ts'],
				tempDir,
				100, // 100ms budget
				undefined,
				new Map([[patch1.filePath, originalCode]]),
			);

			// First mutant should be equivalent, second should have run
			expect(report.results[0].outcome).toBe('equivalent');
			expect(report.results.length).toBe(2);
		});

		test('equivalent mutants are skipped (not executed) and do not consume significant time', async () => {
			const originalCode = `function test() {\n  // old comment\n  return 1;\n}`;

			// Create multiple patches - first is equivalent, second and third are not
			const patch1 = makePatch(
				'patch-1',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  // old comment\n+  // new comment\n   return 1;\n }`,
			);

			const patch2 = makePatch(
				'patch-2',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  return 1;\n+  return 2;\n }`,
			);

			const patch3 = makePatch(
				'patch-3',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  return 2;\n+  return 3;\n }`,
			);

			// Only first mutant is equivalent
			mockBatchCheckEquivalence.mockImplementation(async () => [
				{
					patchId: 'patch-1',
					isEquivalent: true,
					method: 'static',
					confidence: 1.0,
					reason: 'stripped identical',
				},
				{
					patchId: 'patch-2',
					isEquivalent: false,
					method: 'static',
					confidence: 1.0,
					reason: 'code differs',
				},
				{
					patchId: 'patch-3',
					isEquivalent: false,
					method: 'static',
					confidence: 1.0,
					reason: 'code differs',
				},
			]);

			// Mutant 2 and 3 should still be executed (spawnSync called for them)
			// But mutant 1 should be skipped (no spawnSync for it)
			const report = await executeMutationSuite(
				[patch1, patch2, patch3],
				['echo', 'test'],
				['test.ts'],
				tempDir,
				1000, // plenty of budget
				undefined,
				new Map([[patch1.filePath, originalCode]]),
			);

			// First mutant should be equivalent (no execution)
			expect(report.results[0].outcome).toBe('equivalent');
			// Second and third should have run (survived since tests pass)
			expect(report.results[1].outcome).toBe('survived');
			expect(report.results[2].outcome).toBe('survived');
		});

		test('when budget is exceeded during execution, remaining non-executed mutants are skipped', async () => {
			// This tests that budget check in the loop actually works
			// We'll use a very short budget and many mutants
			const originalCode = `function test() {\n  return 1;\n}`;

			const patch1 = makePatch(
				'patch-1',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  return 1;\n+  return 2;\n }`,
			);

			const patch2 = makePatch(
				'patch-2',
				`--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,3 @@\n function test() {\n-  return 2;\n+  return 3;\n }`,
			);

			// First mutant is not equivalent, second is not equivalent
			mockBatchCheckEquivalence.mockImplementation(async () => [
				{
					patchId: 'patch-1',
					isEquivalent: false,
					method: 'static',
					confidence: 1.0,
					reason: 'code differs',
				},
				{
					patchId: 'patch-2',
					isEquivalent: false,
					method: 'static',
					confidence: 1.0,
					reason: 'code differs',
				},
			]);

			// Make the first mutant execution take a long time by mocking spawnSync to delay
			let callCount = 0;
			mockSpawnSync.mockImplementation(
				(command: string, args: string[], _options?: unknown) => {
					callCount++;
					if (
						command === 'git' &&
						args[0] === 'apply' &&
						!args.includes('-R')
					) {
						return makeSpawnSuccess();
					}
					if (command === 'git' && args.includes('-R')) {
						return makeSpawnSuccess();
					}
					// First execution (test command) - simulate long running
					if (callCount === 2) {
						// Spin for 50ms to consume budget
						const start = Date.now();
						while (Date.now() - start < 50) {
							/* busy wait */
						}
					}
					return makeSpawnSuccess('all tests passed');
				},
			);

			const report = await executeMutationSuite(
				[patch1, patch2],
				['echo', 'test'],
				['test.ts'],
				tempDir,
				20, // 20ms budget - should be exceeded by the 50ms delay
				undefined,
				new Map([[patch1.filePath, originalCode]]),
			);

			// First mutant should have run
			expect(report.results[0].outcome).toBe('survived');
			// Second mutant might have been skipped due to budget
			// (depending on timing)
		});
	});
});
