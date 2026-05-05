import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the entire child_process module to track spawnSync calls
const mockSpawnSync = mock(() => ({
	status: 0,
	stderr: Buffer.from(''),
	stdout: Buffer.from(''),
}));
const realChildProcess = await import('node:child_process');

// Inline realChildProcess to avoid circular import issues
const realSpawnSync = realChildProcess.spawnSync;

mock.module('node:child_process', () => ({
	...realChildProcess,
	spawnSync: mockSpawnSync,
}));

// We need to import the module AFTER mocking
const { executeMutation, MutationPatch } = await import(
	'../../../src/mutation/engine.ts'
);

describe('executeMutation — shell injection adversarial tests', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-adversarial-'));
		mockSpawnSync.mockImplementation(
			(cmd: string, args: string[], opts: Record<string, unknown>) => {
				// Record the call for verification
				const result = realSpawnSync?.(cmd, args, opts) ?? {
					status: 0,
					stderr: Buffer.from(''),
					stdout: Buffer.from(''),
				};
				return result;
			},
		);
	});

	afterEach(() => {
		mock.restore();
		mockSpawnSync.mockClear();
		// Clean up temp directory
		try {
			const entries = fs.readdirSync(tempDir);
			for (const entry of entries) {
				fs.unlinkSync(path.join(tempDir, entry));
			}
			fs.rmdirSync(tempDir);
		} catch {
			// best effort
		}
	});

	// -------------------------------------------------------------------------
	// Attack Vector 1: Path Traversal — Unix
	// -------------------------------------------------------------------------
	test('patch.id with path traversal (Unix) is sanitized — does not escape workingDir', async () => {
		const maliciousId = '../../../etc/passwd';
		const patch: MutationPatch = {
			id: maliciousId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		// Find the spawnSync calls for git apply
		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		// The patchFile path should NOT contain path traversal characters
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Critical: path traversal sequences must be neutralized
		expect(patchFilePath).not.toContain('../');
		// The path must be inside tempDir (no escaping)
		expect(patchFilePath!.startsWith(tempDir)).toBe(true);
		// The filename must have underscores replacing slashes (not actual path sep)
		expect(patchFilePath).toContain('____etc_passwd');
	});

	// -------------------------------------------------------------------------
	// Attack Vector 2: Path Traversal — Windows
	// -------------------------------------------------------------------------
	test('patch.id with path traversal (Windows) is sanitized — does not escape workingDir', async () => {
		const maliciousId = '..\\..\\windows\\system32\\config\\sam';
		const patch: MutationPatch = {
			id: maliciousId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Critical: Windows path traversal must be neutralized
		expect(patchFilePath).not.toContain('..\\');
		// Path must be inside tempDir
		expect(patchFilePath!.startsWith(tempDir)).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 3: Null Byte Injection
	// -------------------------------------------------------------------------
	test('patch.id with null byte is sanitized — null byte does not survive sanitization', async () => {
		// Creating a patch with null byte in ID
		const nullByteId = `malicious\x00id`;
		const patch: MutationPatch = {
			id: nullByteId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Null byte should have been replaced by underscore (or removed)
		expect(patchFilePath).not.toContain('\x00');
		// The safeId should not contain null bytes after regex replace
		expect(patchFilePath).toContain('malicious_id');
	});

	// -------------------------------------------------------------------------
	// Attack Vector 4: Unicode / Encoding Attacks
	// -------------------------------------------------------------------------
	test('patch.id with Unicode homoglyphs / lookalike characters is sanitized', async () => {
		// Various Unicode tricks: Greek omicron (looks like 'o'), Cyrillic a (looks like 'a'), etc.
		const unicodeId =
			'\u0430\u043f\u043f\u043b\u0435' + // Cyrillic 'apple' — looks like 'apple'
			'\u03bf\u03c1\u03b9\u03b3\u03b9\u03bd\u03b1\u03bb'; // Greek 'origignal'
		const patch: MutationPatch = {
			id: unicodeId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Non-ASCII letters should be replaced with underscores
		expect(patchFilePath).not.toContain('\u0430'); // Cyrillic 'a'
		expect(patchFilePath).not.toContain('\u03bf'); // Greek 'o'
	});

	test('patch.id with emoji / special Unicode characters is sanitized', async () => {
		const emojiId = 'p@teh😀ches🏴󠁧󠁢󠁥󠁮󠁧󠁿id'; // emoji in ID
		const patch: MutationPatch = {
			id: emojiId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Emoji should be replaced with underscores
		expect(patchFilePath!.includes('😀')).toBe(false);
		expect(patchFilePath!.includes('🏴')).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 5: Extremely Long patch.id (Buffer Overflow / DoS)
	// -------------------------------------------------------------------------
	test('very long patch.id is sanitized and spawnSync is called with safe path', async () => {
		// 100 chars — long enough to test sanitization but within Windows MAX_PATH (~260)
		// The sanitized ID (100 chars of A) + prefix/suffix + tmpdir path must fit under ~260
		const longId = 'A'.repeat(100);
		const patch: MutationPatch = {
			id: longId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		// Should not throw — sanitization handles it
		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		// Verify spawnSync was called (git apply)
		expect(mockSpawnSync.mock.calls.length).toBeGreaterThan(0);

		// Find the git apply call
		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Path should still be within tmpdir bounds
		expect(patchFilePath!.startsWith(tempDir)).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 6: Empty string after sanitization
	// -------------------------------------------------------------------------
	test('patch.id that becomes empty after sanitization produces a valid filename', async () => {
		// ID with only non-alphanumeric characters
		const weirdId = '!@#$%^&*()+/<>?';
		const patch: MutationPatch = {
			id: weirdId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Critical: Windows path traversal must be neutralized
		expect(patchFilePath).not.toContain('..\\');
		// Path must be inside tempDir
		expect(patchFilePath!.startsWith(tempDir)).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 7: Verify spawnSync uses array form — no shell execution
	// -------------------------------------------------------------------------
	test('spawnSync is called with array form — no shell string interpolation possible', async () => {
		const patch: MutationPatch = {
			id: 'test-patch-id',
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		// Verify ALL spawnSync calls use array form
		for (const call of mockSpawnSync.mock.calls) {
			const [cmd, args] = call;
			// If cmd contains shell metacharacters AND args is a string, it would be shell form
			if (typeof args === 'string' && /[;&|`$]/.test(args)) {
				// This would indicate shell=true or string command — a vulnerability
				expect.fail(`spawnSync called with shell string form: ${cmd} ${args}`);
			}
		}

		// Specifically verify git apply uses ['apply', patchFile] array form
		const gitApplyCall = mockSpawnSync.mock.calls.find(
			(call) => Array.isArray(call[1]) && call[1][0] === 'apply',
		);
		expect(gitApplyCall).toBeDefined();
		expect(Array.isArray(gitApplyCall![1])).toBe(true);
		// patchFile must be passed as separate array element, not interpolated in shell string
		const argsArray = gitApplyCall![1] as string[];
		expect(argsArray).toContain('apply');
		expect(argsArray.some((a) => a.includes('.diff'))).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 8: Revert (git apply -R) also uses safe path
	// -------------------------------------------------------------------------
	test('revert git apply -R also uses sanitized patchFile path', async () => {
		const maliciousId = '../../../secret/file';
		const patch: MutationPatch = {
			id: maliciousId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		// Find the revert (git apply -R) call
		const revertCall = mockSpawnSync.mock.calls.find(
			(call) => Array.isArray(call[1]) && call[1].includes('-R'),
		);
		expect(revertCall).toBeDefined();

		const [, revertArgs] = revertCall!;
		const patchFilePath = (revertArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Critical: path traversal must be neutralized in revert too
		expect(patchFilePath).not.toContain('../');
		// Path must be inside tempDir
		expect(patchFilePath!.startsWith(tempDir)).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 9: Shell metacharacters in patch.id
	// -------------------------------------------------------------------------
	test('shell metacharacters in patch.id are sanitized', async () => {
		const shellMetacharId = 'id$(echo INJECTED)id`ls`id|pipe&id&bg&&||';
		const patch: MutationPatch = {
			id: shellMetacharId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Shell metacharacters should be replaced
		expect(patchFilePath).not.toContain('$');
		expect(patchFilePath).not.toContain('`');
		expect(patchFilePath).not.toContain('|');
		expect(patchFilePath).not.toContain('&');
	});

	// -------------------------------------------------------------------------
	// Attack Vector 10: Newline / control characters
	// -------------------------------------------------------------------------
	test('newline and control characters in patch.id are sanitized', async () => {
		const controlId = 'id\nwith\rnewlines\x00null\x1binject';
		const patch: MutationPatch = {
			id: controlId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Control characters should be replaced
		expect(patchFilePath).not.toContain('\n');
		expect(patchFilePath).not.toContain('\r');
		expect(patchFilePath).not.toContain('\x00');
		expect(patchFilePath).not.toContain('\x1b');
	});

	// -------------------------------------------------------------------------
	// Sanity: Normal patch.id still works correctly
	// -------------------------------------------------------------------------
	test('normal patch.id without malicious characters works correctly', async () => {
		const normalId = 'normal_patch-123';
		const patch: MutationPatch = {
			id: normalId,
			filePath: '/fake/test.ts',
			functionName: 'testFn',
			mutationType: 'type',
			patch: 'dummy patch content',
		};

		await executeMutation(patch, ['echo', 'test'], [], tempDir);

		const applyCall = mockSpawnSync.mock.calls.find(
			(call) =>
				Array.isArray(call[1]) &&
				call[1].includes('apply') &&
				!call[1].includes('-R'),
		);
		expect(applyCall).toBeDefined();

		const [, applyArgs] = applyCall!;
		const patchFilePath = (applyArgs as string[]).find((arg) =>
			arg.includes('.diff'),
		);
		expect(patchFilePath).toBeDefined();
		// Normal ID should be preserved as-is
		expect(patchFilePath).toContain('normal_patch-123');
	});
});
