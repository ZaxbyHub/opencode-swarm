/**
 * Tests for test-file scoping in executeMutation / executeMutationSuite.
 *
 * Covers:
 *   - Bug fix: _testFiles was ignored; now appended to the test command
 *   - testFiles=[] (empty) → full suite (only testCommand.slice(1) passed)
 *   - testFiles=['a.test.ts'] → only that file appended
 *   - testFiles=['a.test.ts','b.test.ts'] → both appended
 *   - testCommand allowlist validation via executeMutationSuite
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
	_internals,
	executeMutation,
	executeMutationSuite,
	type MutationPatch,
	ALLOWED_TEST_RUNNERS,
	validateTestCommand,
} from '../../../src/mutation/engine.js';

const mockSpawnSync = mock((_cmd: string, _args: string[]) => ({
	status: 0,
	stderr: Buffer.from(''),
	stdout: Buffer.from('Tests passed'),
}));

function makePatch(id = 'mut-001'): MutationPatch {
	return {
		id,
		filePath: 'src/foo.ts',
		functionName: 'foo',
		mutationType: 'off-by-one',
		patch: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-x\n+y\n',
	};
}

describe('executeMutation — testFiles scoping (bug fix)', () => {
	let tempDir: string;
	let savedSpawnSync: typeof _internals.spawnSync;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-scoping-')),
		);
		savedSpawnSync = _internals.spawnSync;
		mockSpawnSync.mockClear();
		mockSpawnSync.mockImplementation(
			(cmd: string, _args: string[]) => {
				if (cmd === 'git') {
					return { status: 0, stderr: Buffer.from(''), stdout: Buffer.from('') };
				}
				return {
					status: 0,
					stderr: Buffer.from(''),
					stdout: Buffer.from('Tests passed'),
				};
			},
		);
		_internals.spawnSync = mockSpawnSync as unknown as typeof _internals.spawnSync;
	});

	afterEach(() => {
		_internals.spawnSync = savedSpawnSync;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	test('empty testFiles → only testCommand.slice(1) passed to spawnSync', async () => {
		await executeMutation(makePatch(), ['bun', 'test'], [], tempDir);

		const testCall = mockSpawnSync.mock.calls.find(
			([cmd]) => cmd !== 'git',
		);
		expect(testCall).toBeDefined();
		const [, args] = testCall!;
		expect(args).toEqual(['test']);
	});

	test('single testFile → appended after testCommand.slice(1)', async () => {
		await executeMutation(
			makePatch(),
			['bun', 'test'],
			['src/foo.test.ts'],
			tempDir,
		);

		const testCall = mockSpawnSync.mock.calls.find(
			([cmd]) => cmd !== 'git',
		);
		expect(testCall).toBeDefined();
		const [, args] = testCall!;
		expect(args).toEqual(['test', 'src/foo.test.ts']);
	});

	test('multiple testFiles → all appended after testCommand.slice(1)', async () => {
		await executeMutation(
			makePatch(),
			['bun', 'test'],
			['src/foo.test.ts', 'src/bar.test.ts'],
			tempDir,
		);

		const testCall = mockSpawnSync.mock.calls.find(
			([cmd]) => cmd !== 'git',
		);
		expect(testCall).toBeDefined();
		const [, args] = testCall!;
		expect(args).toEqual(['test', 'src/foo.test.ts', 'src/bar.test.ts']);
	});

	test('testFiles with flag-like entries are filtered out', async () => {
		await executeMutation(
			makePatch(),
			['bun', 'test'],
			['-flag', 'src/foo.test.ts', '--another-flag'],
			tempDir,
		);

		const testCall = mockSpawnSync.mock.calls.find(
			([cmd]) => cmd !== 'git',
		);
		expect(testCall).toBeDefined();
		const [, args] = testCall!;
		// Flag-like entries starting with '-' should be filtered out
		expect(args).toEqual(['test', 'src/foo.test.ts']);
	});

	test('testCommand with existing flags: files appended after flags', async () => {
		// e.g. ["bun", "test", "--bail"] + ["foo.test.ts"] = ["test", "--bail", "foo.test.ts"]
		await executeMutation(
			makePatch(),
			['bun', 'test', '--bail'],
			['src/foo.test.ts'],
			tempDir,
		);

		const testCall = mockSpawnSync.mock.calls.find(
			([cmd]) => cmd !== 'git',
		);
		expect(testCall).toBeDefined();
		const [, args] = testCall!;
		expect(args).toEqual(['test', '--bail', 'src/foo.test.ts']);
	});
});

describe('executeMutationSuite — testFiles scoping integration', () => {
	let tempDir: string;
	let savedSpawnSync: typeof _internals.spawnSync;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-suite-scoping-')),
		);
		savedSpawnSync = _internals.spawnSync;
		mockSpawnSync.mockClear();
		mockSpawnSync.mockImplementation(
			(cmd: string, _args: string[]) => {
				if (cmd === 'git') {
					return { status: 0, stderr: Buffer.from(''), stdout: Buffer.from('') };
				}
				return {
					status: 0,
					stderr: Buffer.from(''),
					stdout: Buffer.from('Tests passed'),
				};
			},
		);
		_internals.spawnSync = mockSpawnSync as unknown as typeof _internals.spawnSync;
	});

	afterEach(() => {
		_internals.spawnSync = savedSpawnSync;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	test('testFiles passed through executeMutationSuite to executeMutation', async () => {
		const report = await executeMutationSuite(
			[makePatch()],
			['bun', 'test'],
			['src/foo.test.ts'],
			tempDir,
		);

		// At least one test call should have happened with the scoped file
		const testCalls = mockSpawnSync.mock.calls.filter(
			([cmd]) => cmd !== 'git',
		);
		expect(testCalls.length).toBeGreaterThan(0);

		const testCallArgs = testCalls[0][1] as string[];
		expect(testCallArgs).toContain('src/foo.test.ts');
	});

	test('empty testFiles in executeMutationSuite → runs full suite', async () => {
		await executeMutationSuite(
			[makePatch()],
			['bun', 'test'],
			[], // empty — full suite
			tempDir,
		);

		const testCalls = mockSpawnSync.mock.calls.filter(
			([cmd]) => cmd !== 'git',
		);
		expect(testCalls.length).toBeGreaterThan(0);

		const testCallArgs = testCalls[0][1] as string[];
		// Should NOT include any test file
		expect(testCallArgs).toEqual(['test']);
	});
});

describe('validateTestCommand — allowlist', () => {
	test('returns null for all known test runners', () => {
		for (const runner of ALLOWED_TEST_RUNNERS) {
			expect(validateTestCommand([runner, 'test'])).toBeNull();
		}
	});

	test('accepts full path to a known runner (basename check)', () => {
		expect(validateTestCommand(['/usr/local/bin/bun', 'test'])).toBeNull();
		expect(validateTestCommand(['/usr/bin/python3', '-m', 'pytest'])).toBeNull();
	});

	test('accepts runner with .exe extension on Windows (basename strip)', () => {
		expect(validateTestCommand(['bun.exe', 'test'])).toBeNull();
		expect(validateTestCommand(['jest.cmd', 'test'])).toBeNull();
	});

	test('returns error for empty testCommand', () => {
		expect(validateTestCommand([])).not.toBeNull();
	});

	test('returns error for unknown executable', () => {
		expect(validateTestCommand(['arbitrary-binary', 'test'])).not.toBeNull();
		expect(validateTestCommand(['echo', 'test'])).not.toBeNull();
		expect(validateTestCommand(['curl', 'http://evil.com'])).not.toBeNull();
		expect(validateTestCommand(['rm', '-rf', '/'])).not.toBeNull();
		expect(validateTestCommand(['/bin/sh', '-c', 'id'])).not.toBeNull();
	});

	test('error message mentions the rejected executable', () => {
		const err = validateTestCommand(['evil-binary', 'test']);
		expect(err).toContain('evil-binary');
	});

	test('executeMutationSuite returns empty report for disallowed runner', async () => {
		const report = await executeMutationSuite(
			[makePatch()],
			['arbitrary-binary', 'test'],
			[],
			os.tmpdir(),
		);
		expect(report.totalMutants).toBe(0);
		expect(report.results).toHaveLength(0);
	});
});
