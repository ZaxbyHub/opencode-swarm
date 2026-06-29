/**
 * Adversarial security tests for detectTestFramework in src/tools/test-runner.ts
 * Testing Task 3.3: 9 new test framework detectors and their wiring
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';
import { detectTestFramework } from '../../../src/tools/test-runner';

// Mock isCommandAvailable using module mock
const mockIsCommandAvailable = mock();
mock.module('../../../src/build/discovery', () => ({
	isCommandAvailable: (...args: unknown[]) =>
		mockIsCommandAvailable(...(args as [string])),
}));

import * as fs from 'node:fs';
import * as path from 'node:path';

// Use spyOn instead of vi.mock for fs.existsSync so the spy can be properly
// restored in afterEach and does not contaminate other test files in the same process.
let fsExistsSyncSpy: ReturnType<typeof spyOn<typeof fs, 'existsSync'>>;

describe('detectTestFramework - Adversarial Security Tests', () => {
	beforeEach(() => {
		mock.restore();
		mock.clearAllMocks();
		mockIsCommandAvailable.mockImplementation(() => false);
		// Spy on existsSync per-test so it's automatically restored in afterEach
		fsExistsSyncSpy = spyOn(fs, 'existsSync').mockImplementation(() => false);
	});

	afterEach(() => {
		mock.restore();
		// Restore the real existsSync so other test files are not affected
		fsExistsSyncSpy.mockRestore();
	});

	describe('1. Path traversal in cwd argument', () => {
		it('should handle path traversal "../../etc/passwd" safely', async () => {
			const result = await detectTestFramework('../../etc/passwd');
			expect(result).toBe('none');
			// Should not crash or throw
		});

		it('should handle deep path traversal "../../../root" safely', async () => {
			const result = await detectTestFramework('../../../root');
			expect(result).toBe('none');
		});

		it('should handle null-byte injection "\\x00null-byte" safely', async () => {
			const nullBytePath = '\x00null-byte';
			const result = await detectTestFramework(nullBytePath);
			expect(result).toBe('none');
		});

		it('should handle Windows system path "C:\\Windows\\System32" safely', async () => {
			const result = await detectTestFramework('C:\\Windows\\System32');
			expect(result).toBe('none');
		});

		it('should handle UNC path "\\\\server\\share" safely', async () => {
			const result = await detectTestFramework('\\\\server\\share');
			expect(result).toBe('none');
		});

		it('should handle URL-encoded path traversal "%2e%2e" safely', async () => {
			const result = await detectTestFramework('%2e%2e');
			expect(result).toBe('none');
		});

		it('should handle Unicode dot traversal (U+FF0E) safely', async () => {
			const unicodePath = '\uff0e\uff0e'; // Fullwidth dots
			const result = await detectTestFramework(unicodePath);
			expect(result).toBe('none');
		});

		it('should handle mixed encoding traversal safely', async () => {
			const mixedPath = '.%2e'; // Mixed . and %2e
			const result = await detectTestFramework(mixedPath);
			expect(result).toBe('none');
		});
	});

	describe('2. Injection attempts in cwd', () => {
		it('should handle shell command injection "$(rm -rf /)" safely', async () => {
			const result = await detectTestFramework('$(rm -rf /)');
			expect(result).toBe('none');
		});

		it('should handle backtick command injection "`whoami`" safely', async () => {
			const result = await detectTestFramework('`whoami`');
			expect(result).toBe('none');
		});

		it('should handle semicolon injection "; ls -la" safely', async () => {
			const result = await detectTestFramework('; ls -la');
			expect(result).toBe('none');
		});

		it('should handle pipe injection "| cat /etc/passwd" safely', async () => {
			const result = await detectTestFramework('| cat /etc/passwd');
			expect(result).toBe('none');
		});

		it('should handle AND injection "&& cat /etc/shadow" safely', async () => {
			const result = await detectTestFramework('&& cat /etc/shadow');
			expect(result).toBe('none');
		});

		it('should handle OR injection "|| echo hacked" safely', async () => {
			const result = await detectTestFramework('|| echo hacked');
			expect(result).toBe('none');
		});

		it('should handle newline injection "\\ncat /etc/passwd" safely', async () => {
			const result = await detectTestFramework('\ncat /etc/passwd');
			expect(result).toBe('none');
		});

		it('should handle carriage return injection "\\rcat /etc/passwd" safely', async () => {
			const result = await detectTestFramework('\rcat /etc/passwd');
			expect(result).toBe('none');
		});

		it('should handle tab injection "\\tcat /etc/passwd" safely', async () => {
			const result = await detectTestFramework('\tcat /etc/passwd');
			expect(result).toBe('none');
		});
	});

	describe('3. Oversized/malformed cwd', () => {
		it('should handle oversized string (10000 chars) safely', async () => {
			const hugePath = 'a'.repeat(10000);
			const result = await detectTestFramework(hugePath);
			expect(result).toBe('none');
		});

		it('should handle empty string safely', async () => {
			const result = await detectTestFramework('');
			// Empty string should default to process.cwd() and not crash
			expect(result).toBe('none');
		});

		it('should throw TypeError when cwd is null (path.join cannot handle non-string)', async () => {
			// detectTestFramework does not guard against non-string cwd; path.join throws
			await expect(
				detectTestFramework(null as unknown as string),
			).rejects.toThrow(TypeError);
		});

		it('should throw TypeError when cwd is undefined (path.join cannot handle non-string)', async () => {
			// detectTestFramework does not guard against non-string cwd; path.join throws
			await expect(detectTestFramework(undefined)).rejects.toThrow(TypeError);
		});

		it('should handle whitespace-only string safely', async () => {
			const result = await detectTestFramework('   \t\n  ');
			expect(result).toBe('none');
		});

		it('should handle string with only special characters safely', async () => {
			const result = await detectTestFramework('!@#$%^&*()_+{}[]:";<>?,./');
			expect(result).toBe('none');
		});
	});

	describe('4. Detection priority — no cross-framework false positives', () => {
		it('should return go-test when both go.mod and pom.xml exist', async () => {
			// Mock go test detection
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'go' || cmd === 'mvn',
			);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				// Return true for both go.mod and pom.xml
				return pathStr.endsWith('go.mod') || pathStr.endsWith('pom.xml');
			});

			const result = await detectTestFramework('/fake/cwd');
			// Go is checked first in the priority order (line 403)
			expect(result).toBe('go-test');
		});

		it('should return maven when only pom.xml exists (no go.mod)', async () => {
			mockIsCommandAvailable.mockImplementation((cmd: string) => cmd === 'mvn');
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('pom.xml');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('maven');
		});

		it('should return gradle when build.gradle exists', async () => {
			mockIsCommandAvailable.mockReturnValue(true);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('build.gradle');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('gradle');
		});

		it('should respect priority: go > maven > gradle', async () => {
			mockIsCommandAvailable.mockReturnValue(true);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				// All three exist
				return (
					pathStr.endsWith('go.mod') ||
					pathStr.endsWith('pom.xml') ||
					pathStr.endsWith('build.gradle')
				);
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('go-test');
		});

		it('should respect priority: maven > gradle > dotnet-test', async () => {
			mockIsCommandAvailable.mockReturnValue(true);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return (
					pathStr.endsWith('pom.xml') ||
					pathStr.endsWith('build.gradle') ||
					pathStr.endsWith('.csproj')
				);
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('maven');
		});
	});

	describe('5. Binary check bypass', () => {
		it('should return none when go.mod exists but go binary is not available', async () => {
			mockIsCommandAvailable.mockReturnValue(false); // No binaries available
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('go.mod');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('none');
		});

		it('should return none when pom.xml exists but mvn binary is not available', async () => {
			mockIsCommandAvailable.mockReturnValue(false);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('pom.xml');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('none');
		});

		it('should return none when build.gradle exists but gradle/gradlew not available', async () => {
			mockIsCommandAvailable.mockReturnValue(false);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('build.gradle');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('none');
		});

		it('should return none when .csproj exists but dotnet binary is not available', async () => {
			mockIsCommandAvailable.mockReturnValue(false);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('.csproj') || pathStr === '/fake/cwd';
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('none');
		});

		it('should return none when CMakeLists.txt exists but ctest binary is not available', async () => {
			mockIsCommandAvailable.mockReturnValue(false);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('CMakeLists.txt');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('none');
		});

		it('should return none when Package.swift exists but swift binary is not available', async () => {
			mockIsCommandAvailable.mockReturnValue(false);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('Package.swift');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('none');
		});

		it('should return none when pubspec.yaml exists but dart/flutter binaries are not available', async () => {
			mockIsCommandAvailable.mockReturnValue(false);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('pubspec.yaml');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('none');
		});

		it('should return none when .rspec exists but rspec/bundle binaries are not available', async () => {
			mockIsCommandAvailable.mockReturnValue(false);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr.endsWith('.rspec');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('none');
		});

		it('should return none when test dir exists but ruby binary is not available', async () => {
			mockIsCommandAvailable.mockReturnValue(false);
			fsExistsSyncSpy.mockImplementation((p) => {
				const pathStr = String(p);
				return pathStr === 'test' || pathStr.endsWith('Gemfile');
			});

			const result = await detectTestFramework('/fake/cwd');
			expect(result).toBe('none');
		});
	});

	describe('6. Additional edge cases for robustness', () => {
		it('should handle simultaneous path traversal and injection attempts', async () => {
			const result = await detectTestFramework('../../..; rm -rf /');
			expect(result).toBe('none');
		});

		it('should handle paths with null bytes mixed with valid-looking paths', async () => {
			const result = await detectTestFramework('some/path\x00/real/path');
			expect(result).toBe('none');
		});

		it('should handle extremely long path with traversal attempts', async () => {
			const longPath = 'a'.repeat(100) + '/../../' + 'b'.repeat(100);
			const result = await detectTestFramework(longPath);
			expect(result).toBe('none');
		});

		it('should handle Unicode control characters in path', async () => {
			const result = await detectTestFramework('\u0001\u0002\u0003path');
			expect(result).toBe('none');
		});

		it('should handle mixed forward and backslashes in path', async () => {
			const result = await detectTestFramework('some/path\\to/..\\folder');
			expect(result).toBe('none');
		});

		it('should handle repeated path separators safely', async () => {
			const result = await detectTestFramework(
				'some///path\\\\\\\\to\\\\folder',
			);
			expect(result).toBe('none');
		});

		it('should throw error when fs.existsSync throws from detectors without try-catch', async () => {
			mockIsCommandAvailable.mockImplementation(() => {
				throw new Error('Simulated error');
			});
			fsExistsSyncSpy.mockImplementation(() => {
				throw new Error('Simulated error');
			});

			// Note: Most detectors (go-test, maven, gradle, etc.) do NOT have try-catch around
			// existsSync calls, so they will throw. Only detectDotnetTest has error handling.
			await expect(detectTestFramework('/fake/cwd')).rejects.toThrow();
		});

		it('should not crash when mock behavior is inconsistent', async () => {
			let callCount = 0;
			mockIsCommandAvailable.mockImplementation(() => callCount++ % 2 === 0);
			fsExistsSyncSpy.mockImplementation((p) => {
				const idx = callCount++;
				const pathStr = String(p);
				// Only return true for paths that don't match any framework marker
				const frameworkMarkers = [
					'go.mod',
					'pom.xml',
					'build.gradle',
					'build.gradle.kts',
					'.csproj',
					'CMakeLists.txt',
					'CMakeCache.txt',
					'Package.swift',
					'pubspec.yaml',
					'.rspec',
					'Gemfile',
					'Rakefile',
					'pester.config.ps1',
					'pester.config.ps1.json',
					'tests.ps1',
					'test',
					'package.json',
					'Cargo.toml',
					'pyproject.toml',
					'setup.cfg',
					'requirements.txt',
					'bun.lockb',
					'bun.lock',
					'gradlew',
					'gradlew.bat',
					'spec',
				];
				const isFrameworkMarker = frameworkMarkers.some((marker) =>
					pathStr.endsWith(marker),
				);
				return !isFrameworkMarker && idx % 2 === 0;
			});

			const result = await detectTestFramework('/fake/cwd');
			// With no framework markers and alternating mocks, should return 'none'
			expect(result).toBe('none');
		});
	});
});
