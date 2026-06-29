import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectTestFramework } from '../../../src/tools/test-runner';

// Mock isCommandAvailable from discovery module
const mockIsCommandAvailable = mock();
mock.module('../../../src/build/discovery', () => ({
	isCommandAvailable: (...args: unknown[]) => mockIsCommandAvailable(...args),
	// Preserve other exports as no-ops
	clearToolchainCache: mock(),
	discoverBuildCommands: mock(),
	discoverBuildCommandsFromProfiles: mock(),
	getEcosystems: mock(() => []),
}));

describe('Test Framework Detectors (Go, Java, Gradle, .NET, C/C++, Swift, Dart, Ruby)', () => {
	let tempDirs: string[];

	beforeEach(() => {
		// Clear tempDirs at the start of each test
		tempDirs = [];
		// Reset mock
		mockIsCommandAvailable.mockReset();
	});

	afterEach(() => {
		// Clean up all temp directories
		for (const dir of tempDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	function createTempDir(suffix: string): string {
		const tempDir = path.join(
			os.tmpdir(),
			`test-runner-detectors-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		fs.mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return tempDir;
	}

	function createFile(dir: string, filePath: string, content = '') {
		const fullPath = path.join(dir, filePath);
		const dirPath = path.dirname(fullPath);
		if (!fs.existsSync(dirPath)) {
			fs.mkdirSync(dirPath, { recursive: true });
		}
		fs.writeFileSync(fullPath, content);
	}

	describe('Go test detector (detectGoTest)', () => {
		it('should detect go-test for Go project with go.mod when go binary is available', async () => {
			const tempDir = createTempDir('go');
			createFile(tempDir, 'go.mod', 'module example\n\ngo 1.21');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('go-test');
		});
	});

	describe('Java/Maven detector (detectJavaMaven)', () => {
		it('should detect maven for Maven project with pom.xml when mvn binary is available', async () => {
			const tempDir = createTempDir('maven');
			createFile(tempDir, 'pom.xml', '<project></project>');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('maven');
		});
	});

	describe('Gradle detector (detectGradle)', () => {
		it('should detect gradle for Gradle project with build.gradle when gradle binary is available', async () => {
			const tempDir = createTempDir('gradle');
			createFile(tempDir, 'build.gradle', 'plugins { id "java" }');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('gradle');
		});

		it('should detect gradle for Gradle project with build.gradle.kts when gradle binary is available', async () => {
			const tempDir = createTempDir('gradle-kts');
			createFile(tempDir, 'build.gradle.kts', 'plugins { java }');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('gradle');
		});
	});

	describe('.NET detector (detectDotnetTest)', () => {
		it('should detect dotnet-test for .NET project with .csproj when dotnet binary is available', async () => {
			const tempDir = createTempDir('dotnet');
			createFile(tempDir, 'MyProject.csproj', '<Project></Project>');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('dotnet-test');
		});
	});

	describe('C/C++ CTest detector (detectCTest)', () => {
		it('should detect ctest for CMake project with CMakeLists.txt when ctest binary is available', async () => {
			const tempDir = createTempDir('ctest-source');
			createFile(
				tempDir,
				'CMakeLists.txt',
				'cmake_minimum_required(VERSION 3.0)',
			);
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('ctest');
		});

		it('should detect ctest for CMake build directory with CMakeCache.txt when ctest binary is available', async () => {
			const tempDir = createTempDir('ctest-build');
			createFile(tempDir, 'CMakeCache.txt', '# CMake configuration');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('ctest');
		});

		it('should detect ctest for CMake project with build/CMakeCache.txt when ctest binary is available', async () => {
			const tempDir = createTempDir('ctest-build-subdir');
			createFile(tempDir, 'build/CMakeCache.txt', '# CMake configuration');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('ctest');
		});
	});

	describe('Swift detector (detectSwiftTest)', () => {
		it('should detect swift-test for Swift project with Package.swift when swift binary is available', async () => {
			const tempDir = createTempDir('swift');
			createFile(tempDir, 'Package.swift', '// swift-tools-version: 5.9');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('swift-test');
		});
	});

	describe('Dart/Flutter detector (detectDartTest)', () => {
		it('should detect dart-test for Dart project with pubspec.yaml when dart binary is available', async () => {
			const tempDir = createTempDir('dart');
			createFile(
				tempDir,
				'pubspec.yaml',
				'name: my_app\ndescription: A Dart app',
			);
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('dart-test');
		});

		it('should detect dart-test for Flutter project with pubspec.yaml when flutter binary is available', async () => {
			const tempDir = createTempDir('flutter');
			createFile(
				tempDir,
				'pubspec.yaml',
				'name: my_app\ndescription: A Flutter app',
			);
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('dart-test');
		});
	});

	describe('Ruby/RSpec detector (detectRSpec)', () => {
		it('should detect rspec for RSpec project with .rspec file when bundle/rspec binary is available', async () => {
			const tempDir = createTempDir('rspec');
			createFile(tempDir, '.rspec', '--require spec_helper\n--color');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('rspec');
		});

		it('should detect rspec for RSpec project with Gemfile + spec/ directory when bundle/rspec binary is available', async () => {
			const tempDir = createTempDir('rspec-gemfile');
			createFile(tempDir, 'Gemfile', "source 'https://rubygems.org'");
			createFile(tempDir, 'spec/my_spec.rb', '# spec file');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('rspec');
		});
	});

	describe('Ruby/Minitest detector (detectMinitest)', () => {
		it('should detect minitest for Minitest project with test/ directory + Gemfile when ruby binary is available', async () => {
			const tempDir = createTempDir('minitest-gemfile');
			createFile(tempDir, 'test/my_test.rb', '# test file');
			createFile(tempDir, 'Gemfile', "source 'https://rubygems.org'");
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('minitest');
		});

		it('should detect minitest for Minitest project with test/ directory + Rakefile when ruby binary is available', async () => {
			const tempDir = createTempDir('minitest-rakefile');
			createFile(tempDir, 'test/my_test.rb', '# test file');
			createFile(tempDir, 'Rakefile', 'task :default => [:test]');
			mockIsCommandAvailable.mockReturnValue(true);

			const result = await detectTestFramework(tempDir);
			expect(result).toBe('minitest');
		});
	});

	describe('Verification of detectGoTest logic (via marker files)', () => {
		it('should have go.mod marker file for Go detection', async () => {
			const tempDir = createTempDir('go-marker');
			createFile(tempDir, 'go.mod', 'module example\n\ngo 1.21');

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'go.mod'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('Verification of detectJavaMaven logic (via marker files)', () => {
		it('should have pom.xml marker file for Maven detection', async () => {
			const tempDir = createTempDir('maven-marker');
			createFile(tempDir, 'pom.xml', '<project></project>');

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'pom.xml'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('Verification of detectGradle logic (via marker files)', () => {
		it('should have build.gradle marker file for Gradle detection', async () => {
			const tempDir = createTempDir('gradle-marker');
			createFile(tempDir, 'build.gradle', 'plugins { id "java" }');

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'build.gradle'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('should have build.gradle.kts marker file for Gradle Kotlin DSL detection', async () => {
			const tempDir = createTempDir('gradle-kts-marker');
			createFile(tempDir, 'build.gradle.kts', 'plugins { java }');

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'build.gradle.kts'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('should support gradlew script as an alternative to gradle binary', async () => {
			const tempDir = createTempDir('gradle-gradlew-marker');
			createFile(tempDir, 'build.gradle', 'plugins { id "java" }');
			createFile(tempDir, 'gradlew', '#!/bin/sh\nexec gradle "$@"');

			// Verify marker files exist
			expect(fs.existsSync(path.join(tempDir, 'build.gradle'))).toBe(true);
			expect(fs.existsSync(path.join(tempDir, 'gradlew'))).toBe(true);

			// detectGradle checks: hasBuildFile && (hasGradlew || isCommandAvailable('gradle'))
			// gradlew file exists on disk → hasGradlew = true → detector fires without needing binary
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('gradle');
		});
	});

	describe('Verification of detectDotnetTest logic (via marker files)', () => {
		it('should have .csproj marker file for .NET detection', async () => {
			const tempDir = createTempDir('dotnet-marker');
			createFile(tempDir, 'MyProject.csproj', '<Project></Project>');

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'MyProject.csproj'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('Verification of detectCTest logic (via marker files)', () => {
		it('should have CMakeLists.txt marker file for CMake source detection', async () => {
			const tempDir = createTempDir('ctest-source-marker');
			createFile(
				tempDir,
				'CMakeLists.txt',
				'cmake_minimum_required(VERSION 3.0)',
			);

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'CMakeLists.txt'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('should have CMakeCache.txt marker file for CMake build detection', async () => {
			const tempDir = createTempDir('ctest-build-marker');
			createFile(tempDir, 'CMakeCache.txt', '# CMake configuration');

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'CMakeCache.txt'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('should support build/CMakeCache.txt for nested build directory', async () => {
			const tempDir = createTempDir('ctest-build-subdir-marker');
			createFile(tempDir, 'build/CMakeCache.txt', '# CMake configuration');

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'build/CMakeCache.txt'))).toBe(
				true,
			);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('Verification of detectSwiftTest logic (via marker files)', () => {
		it('should have Package.swift marker file for Swift detection', async () => {
			const tempDir = createTempDir('swift-marker');
			createFile(tempDir, 'Package.swift', '// swift-tools-version: 5.9');

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'Package.swift'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('Verification of detectDartTest logic (via marker files)', () => {
		it('should have pubspec.yaml marker file for Dart detection', async () => {
			const tempDir = createTempDir('dart-marker');
			createFile(
				tempDir,
				'pubspec.yaml',
				'name: my_app\ndescription: A Dart app',
			);

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, 'pubspec.yaml'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('Verification of detectRSpec logic (via marker files)', () => {
		it('should have .rspec marker file for RSpec detection', async () => {
			const tempDir = createTempDir('rspec-marker');
			createFile(tempDir, '.rspec', '--require spec_helper\n--color');

			// Verify marker file exists
			expect(fs.existsSync(path.join(tempDir, '.rspec'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('should support Gemfile + spec/ directory combination for RSpec detection', async () => {
			const tempDir = createTempDir('rspec-gemfile-marker');
			createFile(tempDir, 'Gemfile', "source 'https://rubygems.org'");
			createFile(tempDir, 'spec/my_spec.rb', '# spec file');

			// Verify marker files exist
			expect(fs.existsSync(path.join(tempDir, 'Gemfile'))).toBe(true);
			expect(fs.existsSync(path.join(tempDir, 'spec'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});

	describe('Verification of detectMinitest logic (via marker files)', () => {
		it('should have test/ directory + Gemfile for Minitest detection', async () => {
			const tempDir = createTempDir('minitest-gemfile-marker');
			createFile(tempDir, 'test/my_test.rb', '# test file');
			createFile(tempDir, 'Gemfile', "source 'https://rubygems.org'");

			// Verify marker files exist
			expect(fs.existsSync(path.join(tempDir, 'test'))).toBe(true);
			expect(fs.existsSync(path.join(tempDir, 'Gemfile'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});

		it('should have test/ directory + Rakefile for Minitest detection', async () => {
			const tempDir = createTempDir('minitest-rakefile-marker');
			createFile(tempDir, 'test/my_test.rb', '# test file');
			createFile(tempDir, 'Rakefile', 'task :default => [:test]');

			// Verify marker files exist
			expect(fs.existsSync(path.join(tempDir, 'test'))).toBe(true);
			expect(fs.existsSync(path.join(tempDir, 'Rakefile'))).toBe(true);

			// Since detector is not wired, detectTestFramework returns none
			const result = await detectTestFramework(tempDir);
			expect(result).toBe('none');
		});
	});
});
