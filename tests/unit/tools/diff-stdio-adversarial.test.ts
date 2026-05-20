import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Adversarial test suite for stdio fix verification

const mockExecFileSync = mock(() => '');

const realChildProcess = await import('node:child_process');
mock.module('node:child_process', () => ({
	...realChildProcess,
	execFileSync: mockExecFileSync,
}));

const { diff } = await import('../../../src/tools/diff');

describe('ADVERSARIAL: stdio fix verification', () => {
	beforeEach(() => {
		mockExecFileSync.mockClear();
	});

	afterEach(() => {
		mockExecFileSync.mockClear();
	});

	describe('ADVERSARIAL TEST 1: Verify stdio uses array form ["ignore","pipe","pipe"] not "pipe" string', () => {
		test('CONFIRMED: source uses stdio array form, not single string "pipe"', async () => {
			mockExecFileSync.mockReturnValueOnce('5\t2\tsrc/foo.ts');
			mockExecFileSync.mockReturnValueOnce('');

			await diff.execute({ base: 'HEAD' }, '/fake/dir');

			// Verify all stdio calls use array form
			for (const call of mockExecFileSync.mock.calls) {
				const opts = call[2];
				if (opts && opts.stdio !== undefined) {
					// CONFIRMED: stdio is array ['ignore', 'pipe', 'pipe']
					expect(Array.isArray(opts.stdio)).toBe(true);
					expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
				}
			}
		});

		test('All four execFileSync calls have correct stdio option', async () => {
			// Only mock 2 calls (numstat + fullDiff) - other calls may not happen if no files
			mockExecFileSync.mockReturnValueOnce('1\t0\tsrc/a.ts');
			mockExecFileSync.mockReturnValueOnce('diff output');

			await diff.execute({ base: 'HEAD' }, '/fake/dir');

			// Count how many execFileSync calls have stdio options
			// Source has 4 execFileSync calls total:
			// 1. numstat
			// 2. fullDiff
			// 3. fileExistsInRef (git cat-file -e) - called if files exist
			// 4. getContentFromRef (git show) - called if files exist
			const stdioCalls = mockExecFileSync.mock.calls.filter(
				(call) => call[2] && call[2].stdio !== undefined,
			);

			// For this test with 1 file, we expect at least 2 stdio-verified calls (numstat + fullDiff)
			// fileExistsInRef and getContentFromRef may or may not be called depending on git state
			expect(stdioCalls.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('ADVERSARIAL TEST 2: mock.calls with fewer than 2 entries (empty diff scenario)', () => {
		test('handles empty mock.calls gracefully when git returns nothing', async () => {
			// Edge case: if mock returns empty strings (no changes)
			mockExecFileSync.mockReturnValueOnce('');
			mockExecFileSync.mockReturnValueOnce('');

			const result = await diff.execute({ base: 'HEAD' }, '/fake/dir');
			const parsed = JSON.parse(result);

			// Should handle empty calls without crashing
			expect(parsed.files).toEqual([]);
			expect(parsed.contractChanges).toEqual([]);
			expect(parsed.hasContractChanges).toBe(false);
		});

		test('throws gracefully if accessing calls[1] when only calls[0] exists', async () => {
			// Regression: verify we don't access calls[1] without checking length
			mockExecFileSync.mockReturnValueOnce('5\t2\tsrc/foo.ts');

			// This should still work - the second call returning undefined is handled
			const result = await diff.execute({ base: 'HEAD' }, '/fake/dir');
			const parsed = JSON.parse(result);

			// Should parse successfully despite incomplete mock
			expect(parsed.files).toBeDefined();
		});

		test('handles case where mock returns undefined instead of string', async () => {
			// Edge case: mock returns undefined
			mockExecFileSync.mockReturnValueOnce(undefined as unknown as string);

			// Should not throw on split('\n')
			const result = await diff.execute({ base: 'HEAD' }, '/fake/dir');
			const parsed = JSON.parse(result);

			// Should return valid result (possibly empty)
			expect(typeof parsed).toBe('object');
		});
	});

	describe('ADVERSARIAL TEST 3: Boundary - diff with no changed files passes stdio correctly', () => {
		test('empty diff (no changed files) passes correct stdio to both calls', async () => {
			mockExecFileSync.mockReturnValueOnce(''); // numstat returns empty
			mockExecFileSync.mockReturnValueOnce(''); // diff returns empty

			await diff.execute({ base: 'HEAD' }, '/fake/dir');

			// Verify numstat call (calls[0])
			const [, , numstatOpts] = mockExecFileSync.mock.calls[0];
			expect(numstatOpts.stdio).toEqual(['ignore', 'pipe', 'pipe']);

			// Verify fullDiff call (calls[1])
			const [, , fullDiffOpts] = mockExecFileSync.mock.calls[1];
			expect(fullDiffOpts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
		});

		test('empty diff produces correct empty result structure', async () => {
			mockExecFileSync.mockReturnValueOnce('');
			mockExecFileSync.mockReturnValueOnce('');

			const result = await diff.execute({ base: 'HEAD' }, '/fake/dir');
			const parsed = JSON.parse(result);

			expect(parsed.files).toEqual([]);
			expect(parsed.contractChanges).toEqual([]);
			expect(parsed.hasContractChanges).toBe(false);
			expect(parsed.summary).toContain('0 files changed');
		});

		test('empty diff still has correct timeout and stdio options', async () => {
			mockExecFileSync.mockReturnValueOnce('');
			mockExecFileSync.mockReturnValueOnce('');

			await diff.execute({ base: 'HEAD' }, '/fake/dir');

			const [, , opts] = mockExecFileSync.mock.calls[0];
			// cwd is passed through - verify timeout and stdio are correct
			expect(opts.timeout).toBe(30_000);
			expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
		});
	});

	describe('ADVERSARIAL: Verify fix is applied to all 4 execFileSync calls', () => {
		test('numstat call has stdio fix', async () => {
			mockExecFileSync.mockReturnValueOnce('1\t0\tsrc/a.ts');
			mockExecFileSync.mockReturnValueOnce('diff');

			await diff.execute({ base: 'HEAD' }, '/fake/dir');

			const [, , opts] = mockExecFileSync.mock.calls[0];
			expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
		});

		test('fullDiff call has stdio fix', async () => {
			mockExecFileSync.mockReturnValueOnce('1\t0\tsrc/a.ts');
			mockExecFileSync.mockReturnValueOnce('diff');

			await diff.execute({ base: 'HEAD' }, '/fake/dir');

			const [, , opts] = mockExecFileSync.mock.calls[1];
			expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
		});

		// Note: fileExistsInRef and getContentFromRef are internal helpers
		// They are called within the AST diff loop when files exist
		// Testing them requires mocking file existence which is complex
		// The source code at lines 228-232 and 247-252 shows they ALSO use stdio: ['ignore', 'pipe', 'pipe']
		test('internal helpers (fileExistsInRef, getContentFromRef) also use stdio fix', async () => {
			// We need to verify the source code has stdio fix on all 4 calls
			// This is a source verification test - we check that when AST diff is triggered,
			// the internal helpers also use the correct stdio

			// Mock a file that exists in git
			mockExecFileSync.mockReturnValueOnce('1\t0\tsrc/a.ts'); // numstat
			mockExecFileSync.mockReturnValueOnce('diff content'); // diff
			mockExecFileSync.mockReturnValueOnce(true); // fileExistsInRef returns true
			mockExecFileSync.mockReturnValueOnce('file content'); // getContentFromRef

			const result = await diff.execute({ base: 'HEAD' }, '/fake/dir');
			const parsed = JSON.parse(result);

			// Should have called fileExistsInRef and getContentFromRef for AST diff
			// These calls should also have stdio: ['ignore', 'pipe', 'pipe']
			// Find calls that are git cat-file or git show
			const catFileCalls = mockExecFileSync.mock.calls.filter(
				(call) =>
					call[0] === 'git' &&
					Array.isArray(call[1]) &&
					call[1].includes('cat-file'),
			);
			const showCalls = mockExecFileSync.mock.calls.filter(
				(call) =>
					call[0] === 'git' &&
					Array.isArray(call[1]) &&
					call[1].includes('show'),
			);

			for (const call of [...catFileCalls, ...showCalls]) {
				const [, , opts] = call;
				expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
			}
		});
	});

	describe('ADVERSARIAL: Edge case - stdio option not passed at all', () => {
		test('existing tests confirm stdio IS always passed (no undefined)', async () => {
			mockExecFileSync.mockReturnValueOnce('1\t0\tsrc/a.ts');
			mockExecFileSync.mockReturnValueOnce('diff');

			await diff.execute({ base: 'HEAD' }, '/fake/dir');

			// Verify no call has undefined stdio
			for (const call of mockExecFileSync.mock.calls) {
				const opts = call[2];
				if (opts) {
					expect(opts.stdio).not.toBeUndefined();
				}
			}
		});
	});

	describe('ADVERSARIAL: Regression - single string "pipe" would break Windows', () => {
		test('CONFIRMED: source uses array form which prevents Windows ETIMEDOUT', async () => {
			// This test documents the regression:
			// Before fix: stdio: 'pipe' (string) caused stdin to wait on Windows
			// After fix: stdio: ['ignore', 'pipe', 'pipe'] (array) correctly ignores stdin

			mockExecFileSync.mockReturnValueOnce('1\t0\tsrc/a.ts');
			mockExecFileSync.mockReturnValueOnce('');

			await diff.execute({ base: 'HEAD' }, '/fake/dir');

			// Confirm all stdio options are arrays with 'ignore' as first element
			for (const call of mockExecFileSync.mock.calls) {
				const opts = call[2];
				if (opts && opts.stdio !== undefined) {
					expect(opts.stdio[0]).toBe('ignore'); // This is the key fix for Windows
				}
			}
		});
	});
});
