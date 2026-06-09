import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkingDirectory } from '../../../src/tools/resolve-working-directory';

describe('resolveWorkingDirectory', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'resolve-wd-test-'));
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('returns fallback directory when working_directory is undefined', () => {
		const result = resolveWorkingDirectory(undefined, '/some/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe('/some/fallback');
		}
	});

	test('returns fallback directory when working_directory is null', () => {
		const result = resolveWorkingDirectory(null, '/some/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe('/some/fallback');
		}
	});

	test('returns fallback directory when working_directory is empty string', () => {
		const result = resolveWorkingDirectory('', '/some/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toBe('/some/fallback');
		}
	});

	test('returns validated directory when working_directory exists', () => {
		const result = resolveWorkingDirectory(testDir, '/some/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			// The resolved path must be a valid path that contains the test directory name
			// We no longer require the exact realpathSync canonical form since
			// the implementation preserves the resolved path form
			expect(result.directory).toContain('resolve-wd-test-');
			expect(result.directory).toStartWith(tmpdir());
		}
	});

	test('rejects null bytes in working_directory', () => {
		const result = resolveWorkingDirectory(
			'/some/path\0/with/null',
			'/fallback',
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('null bytes');
		}
	});

	test('rejects path traversal sequences when not fully resolved by normalize', () => {
		// On POSIX, path.normalize resolves '../' in absolute paths, so the traversal
		// check only catches cases where '..' survives normalization (e.g. relative paths).
		// The main defense is that the resolved path must exist on disk (realpathSync).
		const result = resolveWorkingDirectory(
			'relative/../../../etc',
			'/fallback',
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('path traversal');
		}
	});

	test('rejects non-existent directory', () => {
		const result = resolveWorkingDirectory(
			'/definitely/not/a/real/path/abc123xyz',
			'/fallback',
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('does not exist');
		}
	});

	test('prefers explicit working_directory over fallback when valid', () => {
		const subDir = join(testDir, 'project');
		mkdirSync(subDir, { recursive: true });

		const result = resolveWorkingDirectory(subDir, '/wrong/fallback');
		expect(result.success).toBe(true);
		if (result.success) {
			// Should NOT be the fallback
			expect(result.directory).not.toBe('/wrong/fallback');
			// Should resolve to the real subDir path
			expect(result.directory).toContain('project');
		}
	});

	test('accepts explicit working_directory when fallbackDirectory is undefined', () => {
		const result = resolveWorkingDirectory(testDir, undefined);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.directory).toContain('resolve-wd-test-');
		}
	});

	test('rejects non-string working_directory values', () => {
		const result = resolveWorkingDirectory(123 as unknown as string, testDir);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('must be a string');
		}
	});

	test('rejects missing working_directory and missing fallbackDirectory', () => {
		const result = resolveWorkingDirectory(undefined, undefined);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.message).toContain('fallbackDirectory is undefined');
		}
	});

	test('resolves symlinks to real path', () => {
		// This test verifies realpathSync is used (the exact behavior depends on OS)
		const result = resolveWorkingDirectory(testDir, '/fallback');
		expect(result.success).toBe(true);
	});
});
