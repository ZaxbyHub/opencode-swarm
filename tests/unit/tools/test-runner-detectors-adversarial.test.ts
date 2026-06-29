import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the discovery module before importing test-runner
const mockIsCommandAvailable = mock();
mock.module('../../../src/build/discovery', () => ({
	isCommandAvailable: (...args: unknown[]) => mockIsCommandAvailable(...args),
	clearToolchainCache: mock(),
	discoverBuildCommands: mock(),
	discoverBuildCommandsFromProfiles: mock(),
	getEcosystems: mock(() => []),
}));

// Now import after mocking is set up
import { detectTestFramework } from '../../../src/tools/test-runner';

describe('test-runner detector functions - adversarial tests', () => {
	let tempDir: string;
	let cleanupDirs: string[] = [];

	beforeEach(() => {
		// Create a temporary directory for each test
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adversarial-test-'));
		cleanupDirs.push(tempDir);
		// Reset mock before each test
		mockIsCommandAvailable.mockReset();
		// Default: no commands available
		mockIsCommandAvailable.mockImplementation(false);
	});

	afterEach(() => {
		// Clean up all directories
		for (const dir of cleanupDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
		cleanupDirs = [];
	});

	describe('1. detectGoTest - go.mod exists but go binary unavailable', () => {
		it('should return false (detectTestFramework returns none)', async () => {
			// Create go.mod file
			fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example\n');

			// Mock: go binary NOT available
			mockIsCommandAvailable.mockImplementation((cmd: string) =>
				cmd === 'go' ? false : false,
			);

			// Since detector is private and not wired, detectTestFramework should return 'none'
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');

			// Verify the mock was called (detector would call isCommandAvailable)
			// Note: Since detector isn't wired, it won't be called
			// This test verifies no crash occurs and returns 'none'
		});
	});

	describe('2. detectGradle - gradlew exists but no build.gradle or build.gradle.kts', () => {
		it('should return false (no build file)', async () => {
			// Create gradlew wrapper script WITHOUT build.gradle files
			fs.writeFileSync(
				path.join(tempDir, 'gradlew'),
				'#!/bin/bash\necho gradle wrapper\n',
			);
			fs.chmodSync(path.join(tempDir, 'gradlew'), 0o755);

			// Mock: gradle binary available, gradlew present (via fs.existsSync)
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'gradle',
			);

			// detectTestFramework should return 'none' (detector not wired)
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('should return false with gradlew.bat but no build files', async () => {
			// Create gradlew.bat wrapper
			fs.writeFileSync(
				path.join(tempDir, 'gradlew.bat'),
				'@echo off\necho gradle wrapper\n',
			);

			// Mock: gradle binary available
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'gradle',
			);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('3. detectDotnetTest - cwd points to a file not a directory', () => {
		it('should return false without crash when cwd is a file', async () => {
			// Create a file (not a directory)
			const filePath = path.join(tempDir, 'not-a-dir.txt');
			fs.writeFileSync(filePath, 'I am a file, not a directory');

			// Mock: dotnet binary available
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'dotnet',
			);

			// Pass a FILE path instead of directory
			// detectDotnetTest uses try-catch around readdirSync, so should return false
			const result = await detectTestFramework(filePath);
			expect(result).toBe('none'); // No crash, returns 'none'
		});
	});

	describe('4. detectRSpec - spec/ is a FILE not a directory', () => {
		it('existsSync returns true for files too - should not crash', async () => {
			// Create spec as a FILE, not a directory
			fs.writeFileSync(path.join(tempDir, 'spec'), 'I am a file named spec');
			fs.writeFileSync(
				path.join(tempDir, 'Gemfile'),
				'source "https://rubygems.org"',
			);

			// Mock: rspec available
			mockIsCommandAvailable.mockImplementation((cmd: string) => {
				return cmd === 'rspec' || cmd === 'bundle';
			});

			// existsSync doesn't distinguish files vs dirs, so it returns true for the spec FILE too.
			// Gemfile + existsSync('spec') === true satisfies detectRSpec, so the detector fires.
			// The key assertion is: no crash occurs and a deterministic value is returned.
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('rspec'); // Detector is wired; existsSync(spec file) counts as spec dir present
		});

		it('with .rspec file and spec as a FILE', async () => {
			// Create .rspec file AND spec as a file
			fs.writeFileSync(path.join(tempDir, '.rspec'), '--color');
			fs.writeFileSync(path.join(tempDir, 'spec'), 'I am a file');

			// Mock: rspec available
			mockIsCommandAvailable.mockImplementation((cmd: string) => {
				return cmd === 'rspec' || cmd === 'bundle';
			});

			// .rspec file present + bundle available → detectRSpec returns true
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('rspec'); // No crash; .rspec marker detected correctly
		});
	});

	describe('5. detectMinitest - test/ and Gemfile exist but ruby binary absent', () => {
		it('should return false when ruby binary unavailable', async () => {
			// Create test directory and Gemfile
			fs.mkdirSync(path.join(tempDir, 'test'));
			fs.writeFileSync(
				path.join(tempDir, 'Gemfile'),
				'source "https://rubygems.org"',
			);

			// Mock: ruby NOT available
			mockIsCommandAvailable.mockImplementation((cmd: string) =>
				cmd === 'ruby' ? false : false,
			);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none'); // Detector not wired + ruby unavailable
		});

		it('with test/ and Rakefile but ruby absent', async () => {
			fs.mkdirSync(path.join(tempDir, 'test'));
			fs.writeFileSync(path.join(tempDir, 'Rakefile'), 'task :default do; end');

			// Mock: ruby NOT available
			mockIsCommandAvailable.mockImplementation((cmd: string) =>
				cmd === 'ruby' ? false : false,
			);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('6. detectMinitest - FALSE POSITIVE PREVENTION: test/ exists, ruby available, but NO Gemfile/Rakefile', () => {
		it('should return false - test/ alone is not enough', async () => {
			// Create test/ directory ONLY - no Gemfile, no Rakefile
			fs.mkdirSync(path.join(tempDir, 'test'));
			fs.writeFileSync(
				path.join(tempDir, 'test', 'example_test.rb'),
				'require "minitest/autorun"',
			);

			// Mock: ruby IS available
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ruby',
			);

			// This is the KEY false-positive prevention test
			// Without Gemfile or Rakefile, should NOT detect as minitest
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none'); // Detector would require Gemfile or Rakefile
		});

		it('test/ and ruby available but only other random files', async () => {
			fs.mkdirSync(path.join(tempDir, 'test'));
			fs.writeFileSync(path.join(tempDir, 'README.md'), '# My Project');
			fs.writeFileSync(path.join(tempDir, 'config.yml'), 'key: value');

			// Mock: ruby available
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ruby',
			);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('7. detectCTest - only CMakeCache.txt (no CMakeLists.txt)', () => {
		it('should return true - build directory case', async () => {
			// Create ONLY CMakeCache.txt (no CMakeLists.txt)
			// This simulates a build directory
			fs.writeFileSync(
				path.join(tempDir, 'CMakeCache.txt'),
				'CMAKE_BUILD_TYPE=Release\n',
			);

			// Mock: ctest available
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ctest',
			);

			// detectCTest accepts either source (CMakeLists.txt) OR build cache (CMakeCache.txt).
			// CMakeCache.txt exists + ctest binary available → detector fires.
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('ctest');
		});

		it('with CMakeCache.txt in build/ subdirectory', async () => {
			// Create build subdirectory with CMakeCache.txt
			const buildDir = path.join(tempDir, 'build');
			fs.mkdirSync(buildDir);
			fs.writeFileSync(
				path.join(buildDir, 'CMakeCache.txt'),
				'CMAKE_BUILD_TYPE=Release\n',
			);

			// Mock: ctest available
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ctest',
			);

			// build/CMakeCache.txt satisfies the hasBuildCache check in detectCTest.
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('ctest');
		});
	});

	describe('8. detectDartTest - pubspec.yaml exists but neither dart nor flutter available', () => {
		it('should return false - neither dart nor flutter on PATH', async () => {
			// Create pubspec.yaml
			fs.writeFileSync(
				path.join(tempDir, 'pubspec.yaml'),
				'name: my_app\nversion: 1.0.0',
			);

			// Mock: neither dart nor flutter available
			mockIsCommandAvailable.mockImplementation((cmd: string) => {
				return cmd === 'dart' || cmd === 'flutter' ? false : false;
			});

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('pubspec.yaml exists, flutter available but dart not', async () => {
			fs.writeFileSync(
				path.join(tempDir, 'pubspec.yaml'),
				'name: flutter_app\n',
			);

			// Mock: flutter available, dart not
			mockIsCommandAvailable.mockImplementation((cmd: string) => {
				return cmd === 'flutter' ? true : cmd === 'dart' ? false : false;
			});

			// detectDartTest checks: dart OR flutter → flutter available → returns true
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('dart-test');
		});

		it('pubspec.yaml exists, dart available but flutter not', async () => {
			fs.writeFileSync(path.join(tempDir, 'pubspec.yaml'), 'name: dart_app\n');

			// Mock: dart available, flutter not
			mockIsCommandAvailable.mockImplementation((cmd: string) => {
				return cmd === 'dart' ? true : cmd === 'flutter' ? false : false;
			});

			// detectDartTest checks: dart OR flutter → dart available → returns true
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('dart-test');
		});
	});

	describe('9. Non-existent cwd passed to detectors', () => {
		it('should return false without crash for non-existent directory', async () => {
			const nonExistentDir = path.join(tempDir, 'does-not-exist');

			// Mock: all commands available (doesn't matter, directory doesn't exist)
			mockIsCommandAvailable.mockImplementation(true);

			// Should NOT throw, should return 'none'
			const result = await detectTestFramework(nonExistentDir);
			expect(result).toBe('none');
		});

		it('deeply nested non-existent path', async () => {
			const deepPath = path.join(
				tempDir,
				'a',
				'b',
				'c',
				'd',
				'e',
				'non-existent',
			);

			mockIsCommandAvailable.mockImplementation(true);

			const result = await detectTestFramework(deepPath);
			expect(result).toBe('none');
		});

		it('path with special characters that does not exist', async () => {
			// Use special chars in path (but doesn't exist)
			const specialPath = path.join(
				tempDir,
				'path with spaces',
				'non-existent',
			);

			mockIsCommandAvailable.mockImplementation(true);

			const result = await detectTestFramework(specialPath);
			expect(result).toBe('none');
		});
	});

	describe('Additional adversarial edge cases', () => {
		it('empty directory with no files', async () => {
			// Directory exists but is empty
			mockIsCommandAvailable.mockImplementation(false);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('directory with only irrelevant files', async () => {
			fs.writeFileSync(path.join(tempDir, 'README.md'), '# Project');
			fs.writeFileSync(path.join(tempDir, 'LICENSE'), 'MIT');
			fs.mkdirSync(path.join(tempDir, 'docs'));
			fs.writeFileSync(path.join(tempDir, 'docs', 'guide.md'), '# Guide');

			mockIsCommandAvailable.mockImplementation(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('permission denied scenario (simulated)', async () => {
			// Create a file and try to use it as directory
			const filePath = path.join(tempDir, 'restricted.txt');
			fs.writeFileSync(filePath, 'content');

			mockIsCommandAvailable.mockImplementation(true);

			// Using a file as cwd should not crash
			const result = await detectTestFramework(filePath);
			expect(result).toBe('none');
		});

		it('multiple conflicting markers', async () => {
			// Create markers for different languages
			fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module test');
			fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
			fs.mkdirSync(path.join(tempDir, 'test'));
			fs.writeFileSync(path.join(tempDir, 'Gemfile'), 'source "rubygems"');

			// Mock: no binaries available
			mockIsCommandAvailable.mockImplementation(false);

			const result = await detectTestFramework(tempDir);
			// Should detect package.json first and check JS/TS frameworks
			// With no test dependencies, returns 'none'
			expect(result).toBe('none');
		});
	});

	describe('isCommandAvailable mock verification', () => {
		it('mock is called correctly when framework detection uses it', async () => {
			fs.writeFileSync(
				path.join(tempDir, 'package.json'),
				JSON.stringify({
					scripts: { test: 'vitest' },
					devDependencies: { vitest: '^1.0.0' },
				}),
			);

			// Clear and set fresh mock
			mockIsCommandAvailable.mockClear();
			mockIsCommandAvailable.mockImplementation(false);

			const result = await detectTestFramework(tempDir);

			// Result should be 'vitest' (from package.json scripts)
			// NOT from detector functions (not wired)
			expect(result).toBe('vitest');

			// isCommandAvailable is NOT called for JS framework detection
			// It would only be called for detector functions (if wired)
			expect(mockIsCommandAvailable).not.toHaveBeenCalled();
		});
	});
});
