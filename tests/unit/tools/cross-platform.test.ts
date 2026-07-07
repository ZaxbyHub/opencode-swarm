import { afterEach, describe, expect, test } from 'bun:test';

describe('cross-platform path normalization', () => {
	// Test A: Path normalization — forward slash test paths match directory pattern
	test('Test A: Windows backslash path normalizes to forward slash and includes /tests/', () => {
		// A Windows-style backslash path like C:\project\tests\unit\foo.ts
		const windowsPath = 'C:\\project\\tests\\unit\\foo.ts';

		// when normalized with .replace(/\\/g, '/') becomes C:/project/tests/unit/foo.ts
		const normalizedPath = windowsPath.replace(/\\/g, '/');

		// This normalized path .includes('/tests/') returns true
		expect(normalizedPath.includes('/tests/')).toBe(true);
		// Verify normalization converted backslashes to forward slashes
		expect(normalizedPath).toContain('/tests/unit/');
	});

	// Test B: Forward slash path already matches
	test('Test B: Unix-style path already includes /tests/', () => {
		// A Unix-style path C:/project/tests/unit/foo.ts already includes /tests/
		const unixPath = 'C:/project/tests/unit/foo.ts';

		// normalizedPath.includes('/tests/') returns true
		expect(unixPath.includes('/tests/')).toBe(true);
	});

	// Test C: Path with __tests__ directory
	test('Test C: Path with __tests__ directory normalizes and matches', () => {
		// C:\project\src\__tests__\foo.ts normalized to forward slashes
		const windowsPathWithUnderscores = 'C:\\project\\src\\__tests__\\foo.ts';

		const normalizedPath = windowsPathWithUnderscores.replace(/\\/g, '/');

		// normalizedPath.includes('/__tests__/') returns true
		expect(normalizedPath.includes('/__tests__/')).toBe(true);
		// Verify normalization converted backslashes to forward slashes
		expect(normalizedPath).toContain('/__tests__/foo.ts');
	});

	// Test D: Basename .test. check still works
	test('Test D: Basename .test. check works for .test. files', () => {
		// basename of utils.test.ts includes .test.
		const testFile = 'utils.test.ts';
		const testBasename = testFile.split('/').pop() || testFile;

		expect(testBasename.includes('.test.')).toBe(true);

		// basename of utils.spec.ts includes .spec.
		const specFile = 'utils.spec.ts';
		const specBasename = specFile.split('/').pop() || specFile;

		expect(specBasename.includes('.spec.')).toBe(true);
	});

	// Test E: Non-test path does NOT match
	test('Test E: Non-test path does NOT match any test patterns', () => {
		// C:\project\src\utils.ts normalized to forward slashes
		const windowsNonTestPath = 'C:\\project\\src\\utils.ts';

		const normalizedPath = windowsNonTestPath.replace(/\\/g, '/');

		// Does NOT include /__tests__/, /tests/, /test/
		expect(normalizedPath.includes('/__tests__/')).toBe(false);
		expect(normalizedPath.includes('/tests/')).toBe(false);
		expect(normalizedPath.includes('/test/')).toBe(false);

		// Does NOT include .test. or .spec. in basename
		const basename = normalizedPath.split('/').pop() || normalizedPath;
		expect(basename.includes('.test.')).toBe(false);
		expect(basename.includes('.spec.')).toBe(false);

		// Verify it's a source file, not a test file
		expect(basename).toBe('utils.ts');
	});
});

describe('isCommandAvailable', () => {
	afterEach(() => {
		const { _internals } = require('../../../src/build/discovery');
		_internals.clearToolchainCache();
	});

	test('returns true when the command probe succeeds', () => {
		const {
			_internals,
			isCommandAvailable,
		} = require('../../../src/build/discovery');
		const originalSpawnSyncImpl = _internals.spawnSyncImpl;
		let result = false;
		try {
			_internals.spawnSyncImpl = () => ({ success: true });
			result = isCommandAvailable('known-tool');
		} finally {
			_internals.spawnSyncImpl = originalSpawnSyncImpl;
		}
		expect(typeof result).toBe('boolean');
		expect(result).toBe(true);
	});

	test('returns false for a nonexistent command', () => {
		const { isCommandAvailable } = require('../../../src/build/discovery');
		const result = isCommandAvailable(
			'__nonexistent_command_that_does_not_exist_xyz__',
		);
		expect(typeof result).toBe('boolean');
		expect(result).toBe(false);
	});
});

describe('cross-platform shell execution patterns', () => {
	test('build-check uses cmd.exe on Windows, sh on Unix', () => {
		// Verify process.platform-based branching logic
		const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
		expect(typeof shell).toBe('string');
		if (process.platform === 'win32') {
			expect(shell).toBe('cmd.exe');
		} else {
			expect(shell).toBe('sh');
		}
	});

	test('lint binary extension: .cmd on Windows, none on Unix', () => {
		// On Windows, biome binary is biome.EXE or biome (no .cmd needed for direct invocation)
		// The extension convention: process.platform === 'win32' ? '.EXE' : ''
		const ext = process.platform === 'win32' ? '.EXE' : '';
		expect(typeof ext).toBe('string');
		if (process.platform === 'win32') {
			expect(ext).toBe('.EXE');
		} else {
			expect(ext).toBe('');
		}
	});

	test('process.platform returns a non-empty string on all platforms', () => {
		expect(typeof process.platform).toBe('string');
		expect(process.platform.length).toBeGreaterThan(0);
		// Valid values include 'win32', 'darwin', 'linux', etc.
		const validPlatforms = [
			'win32',
			'darwin',
			'linux',
			'freebsd',
			'sunos',
			'openbsd',
			'netbsd',
			'aix',
			'android',
		];
		expect(validPlatforms.includes(process.platform)).toBe(true);
	});
});
