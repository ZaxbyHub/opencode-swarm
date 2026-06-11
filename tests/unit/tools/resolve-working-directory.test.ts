import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkingDirectory } from '../../../src/tools/resolve-working-directory';

describe('resolveWorkingDirectory', () => {
	const isWindows = platform() === 'win32';
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'resolve-wd-test-'));
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test('returns fallback directory when working_directory is undefined', () => {
		const result = resolveWorkingDirectory(undefined, '/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe('/fallback');
		}
	});

	test('returns fallback directory when working_directory is null', () => {
		const result = resolveWorkingDirectory(null, '/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe('/fallback');
		}
	});

	test('returns fallback directory when working_directory is empty string', () => {
		const result = resolveWorkingDirectory('', '/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe('/fallback');
		}
	});

	test('returns validated directory when working_directory exists', () => {
		const result = resolveWorkingDirectory(testDir, '/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe(testDir);
		}
	});

	test('rejects null bytes in working_directory', () => {
		const result = resolveWorkingDirectory(
			testDir + '\0extra',
			'/fallback',
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('null bytes');
		}
	});

	test('rejects path traversal sequences when not fully resolved by normalize', () => {
		const traversalPath = testDir + (process.platform === 'win32' ? '\\..\\..\\etc' : '/../../etc');
		const result = resolveWorkingDirectory(traversalPath, '/fallback');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('path traversal');
		}
	});

	test('rejects non-existent directory', () => {
		const nonExistent = join(tmpdir(), 'this-does-not-exist-12345');
		const result = resolveWorkingDirectory(nonExistent, '/fallback');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('does not exist');
		}
	});

	test('prefers explicit working_directory over fallback when valid', () => {
		const result = resolveWorkingDirectory(testDir, '/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe(testDir);
		}
	});

	test('accepts explicit working_directory when fallbackDirectory is undefined', () => {
		const result = resolveWorkingDirectory(testDir, undefined);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe(testDir);
		}
	});

	test('rejects non-string working_directory values', () => {
		const result = resolveWorkingDirectory(123 as unknown as string, '/fallback');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('must be a string');
		}
	});

	test('rejects missing working_directory and missing fallbackDirectory', () => {
		const result = resolveWorkingDirectory(undefined, undefined);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain(
				'fallbackDirectory is missing or not a string',
			);
		}
	});

	test('rejects missing working_directory when fallbackDirectory is null', () => {
		const result = resolveWorkingDirectory(undefined, null);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain(
				'fallbackDirectory is missing or not a string',
			);
		}
	});

	test('uses working_directory when fallbackDirectory is null', () => {
		const result = resolveWorkingDirectory(testDir, null);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toContain('resolve-wd-test-');
		}
	});

	test('resolves symlinks to real path', () => {
		const result = resolveWorkingDirectory(testDir, '/fallback');
		expect(result.success).toBe(true);
	});

	test.skipIf(!isWindows)(
		'accepts backslash Windows path C:\\Users\\foo\\.swarm',
		() => {
			const result = resolveWorkingDirectory(
				'C:\\Users\\foo\\.swarm',
				'/fallback',
			);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toContain('does not exist');
			}
		},
	);

	test.skipIf(!isWindows)('rejects UNC path \\\\server\\share', () => {
		const result = resolveWorkingDirectory('\\\\server\\share', '/fallback');
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.message.includes('does not exist') ||
					result.message.includes('Windows device paths'),
			).toBe(true);
		}
	});

	test.skipIf(!isWindows)(
		'normalizes mixed separators C:/Users\\foo/.swarm',
		() => {
			const result = resolveWorkingDirectory(
				'C:/Users\\foo/.swarm',
				'/fallback',
			);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.message).toContain('does not exist');
			}
		},
	);
});
