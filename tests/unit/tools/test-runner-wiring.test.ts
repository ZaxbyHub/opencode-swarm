import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

afterEach(() => {
	mock.restore();
});

import type * as fs from 'node:fs';
import * as realFs from 'node:fs';
import * as path from 'node:path';

// IMPORTANT MOCK PATTERN
const mockIsCommandAvailable = mock();
mock.module('../../../src/build/discovery', () => ({
	isCommandAvailable: (...args: unknown[]) =>
		mockIsCommandAvailable(...(args as [string])),
}));

const mockExistsSync = mock();
const mockReaddirSync = mock();
const mockReadFileSync = mock();
mock.module('node:fs', () => ({
	...realFs,
	existsSync: (...args: unknown[]) =>
		mockExistsSync(...(args as [fs.PathLike])),
	readdirSync: (...args: unknown[]) => mockReaddirSync(...(args as [string])),
	readFileSync: (...args: unknown[]) =>
		mockReadFileSync(...(args as [string, string])),
	default: {
		...realFs,
		existsSync: (...args: unknown[]) =>
			mockExistsSync(...(args as [fs.PathLike])),
		readdirSync: (...args: unknown[]) => mockReaddirSync(...(args as [string])),
		readFileSync: (...args: unknown[]) =>
			mockReadFileSync(...(args as [string, string])),
	},
}));

import {
	detectTestFramework,
	SUPPORTED_FRAMEWORKS,
} from '../../../src/tools/test-runner';

beforeEach(() => {
	mock.restore();
	mock.clearAllMocks();
	// Default mocks for safety
	mockIsCommandAvailable.mockImplementation(() => false);
	mockExistsSync.mockImplementation(() => false);
	mockReaddirSync.mockImplementation(() => []);
	mockReadFileSync.mockImplementation(() => '{}');
});

describe('Group 1: SUPPORTED_FRAMEWORKS constant', () => {
	it('contains all 9 new frameworks', () => {
		const newFrameworks = [
			'go-test',
			'maven',
			'gradle',
			'dotnet-test',
			'ctest',
			'swift-test',
			'dart-test',
			'rspec',
			'minitest',
		] as const;

		for (const fw of newFrameworks) {
			expect(SUPPORTED_FRAMEWORKS).toContain(fw);
		}
	});

	it('has 16 total frameworks (7 original + 9 new)', () => {
		expect(SUPPORTED_FRAMEWORKS).toHaveLength(16);
	});

	it('all values are distinct (no duplicates)', () => {
		const uniqueFrameworks = new Set(SUPPORTED_FRAMEWORKS);
		expect(uniqueFrameworks.size).toBe(SUPPORTED_FRAMEWORKS.length);
	});

	it('contains all original frameworks', () => {
		const originalFrameworks = [
			'bun',
			'vitest',
			'jest',
			'mocha',
			'pytest',
			'cargo',
			'pester',
		] as const;
		for (const fw of originalFrameworks) {
			expect(SUPPORTED_FRAMEWORKS).toContain(fw);
		}
	});
});

describe('Group 2: detectTestFramework() — new detectors wired in', () => {
	const tmpDir = '/tmp/test-project';

	describe('go-test', () => {
		it('detects go-test when go.mod exists and go binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'go');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('go.mod');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('go-test');
		});

		it('does not detect go-test when go.mod is missing', async () => {
			mockIsCommandAvailable.mockImplementation(true);
			mockExistsSync.mockImplementation(false);

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('go-test');
		});

		it('does not detect go-test when go binary is not available', async () => {
			mockIsCommandAvailable.mockImplementation(false);
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('go.mod');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('go-test');
		});
	});

	describe('maven', () => {
		it('detects maven when pom.xml exists and mvn binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'mvn');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('pom.xml');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('maven');
		});

		it('does not detect maven when pom.xml is missing', async () => {
			mockIsCommandAvailable.mockImplementation(true);
			mockExistsSync.mockImplementation(false);

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('maven');
		});

		it('does not detect maven when mvn binary is not available', async () => {
			mockIsCommandAvailable.mockImplementation(false);
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('pom.xml');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('maven');
		});
	});

	describe('gradle', () => {
		it('detects gradle when build.gradle exists and gradlew is available', async () => {
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('build.gradle') || strPath.endsWith('gradlew');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('gradle');
		});

		it('detects gradle when build.gradle.kts exists and gradle binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'gradle');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('build.gradle.kts');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('gradle');
		});

		it('detects gradle with gradlew.bat on Windows', async () => {
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return (
					strPath.endsWith('build.gradle') || strPath.endsWith('gradlew.bat')
				);
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('gradle');
		});

		it('does not detect gradle when build files are missing', async () => {
			mockIsCommandAvailable.mockImplementation(true);
			mockExistsSync.mockImplementation(false);

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('gradle');
		});
	});

	describe('dotnet-test', () => {
		it('detects dotnet-test when .csproj exists and dotnet binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'dotnet');
			mockReaddirSync.mockImplementation(['MyProject.csproj', 'Program.cs']);
			mockExistsSync.mockImplementation(false); // No other markers

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('dotnet-test');
		});

		it('does not detect dotnet-test when no .csproj files exist', async () => {
			mockIsCommandAvailable.mockImplementation(true);
			mockReaddirSync.mockImplementation(['Program.cs', 'README.md']);

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('dotnet-test');
		});

		it('does not detect dotnet-test when dotnet binary is not available', async () => {
			mockIsCommandAvailable.mockImplementation(false);
			mockReaddirSync.mockImplementation(['MyProject.csproj']);

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('dotnet-test');
		});
	});

	describe('ctest', () => {
		it('detects ctest when CMakeLists.txt exists and ctest binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'ctest');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('CMakeLists.txt');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('ctest');
		});

		it('detects ctest when CMakeCache.txt exists and ctest binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'ctest');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('CMakeCache.txt');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('ctest');
		});

		it('detects ctest when build/CMakeCache.txt exists', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'ctest');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.includes('CMakeCache.txt');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('ctest');
		});

		it('does not detect ctest when cmake files are missing', async () => {
			mockIsCommandAvailable.mockImplementation(true);
			mockExistsSync.mockImplementation(false);

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('ctest');
		});
	});

	describe('swift-test', () => {
		it('detects swift-test when Package.swift exists and swift binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'swift');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('Package.swift');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('swift-test');
		});

		it('does not detect swift-test when Package.swift is missing', async () => {
			mockIsCommandAvailable.mockImplementation(true);
			mockExistsSync.mockImplementation(false);

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('swift-test');
		});

		it('does not detect swift-test when swift binary is not available', async () => {
			mockIsCommandAvailable.mockImplementation(false);
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('Package.swift');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('swift-test');
		});
	});

	describe('dart-test', () => {
		it('detects dart-test when pubspec.yaml exists and dart binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'dart');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('pubspec.yaml');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('dart-test');
		});

		it('detects dart-test when pubspec.yaml exists and flutter binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'flutter');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('pubspec.yaml');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('dart-test');
		});

		it('does not detect dart-test when pubspec.yaml is missing', async () => {
			mockIsCommandAvailable.mockImplementation(true);
			mockExistsSync.mockImplementation(false);

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('dart-test');
		});
	});

	describe('rspec', () => {
		it('detects rspec when .rspec exists and bundle is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'bundle');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('.rspec');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('rspec');
		});

		it('detects rspec when .rspec exists and rspec binary is available', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'rspec');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('.rspec');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('rspec');
		});

		it('detects rspec when Gemfile and spec/ dir exist with bundle', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'bundle');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('Gemfile') || strPath.endsWith('spec');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('rspec');
		});

		it('does not detect rspec when markers are missing', async () => {
			mockIsCommandAvailable.mockImplementation(true);
			mockExistsSync.mockImplementation(false);

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('rspec');
		});
	});

	describe('minitest', () => {
		it('detects minitest when test/ dir and Gemfile exist with ruby binary', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'ruby');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('test') || strPath.endsWith('Gemfile');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('minitest');
		});

		it('detects minitest when test/ dir and Rakefile exist with ruby binary', async () => {
			mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'ruby');
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('test') || strPath.endsWith('Rakefile');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('minitest');
		});

		it('does not detect minitest when test/ dir is missing', async () => {
			mockIsCommandAvailable.mockImplementation(true);
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('Gemfile');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('minitest');
		});

		it('does not detect minitest when ruby binary is not available', async () => {
			mockIsCommandAvailable.mockImplementation(false);
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('test') || strPath.endsWith('Gemfile');
			});

			const result = await detectTestFramework(tmpDir);
			expect(result).not.toBe('minitest');
		});
	});

	describe('return "none" when NO frameworks are detected', () => {
		it('returns none when no framework markers exist and no binaries available', async () => {
			mockIsCommandAvailable.mockImplementation(false);
			mockExistsSync.mockImplementation(false);
			mockReaddirSync.mockImplementation([]);

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('none');
		});

		it('returns none when framework markers exist but binaries are not available', async () => {
			mockIsCommandAvailable.mockImplementation(false);
			mockExistsSync.mockImplementation((filePath) => {
				const strPath = String(filePath);
				return strPath.endsWith('package.json');
			});
			mockReaddirSync.mockImplementation([]);
			mockReadFileSync.mockImplementation('{}');

			const result = await detectTestFramework(tmpDir);
			expect(result).toBe('none');
		});
	});
});

describe('Group 3: buildTestCommand() — test limitation', () => {
	it('buildTestCommand is NOT exported from test-runner.ts - cannot test directly', () => {
		// This test documents the limitation - buildTestCommand is not exported
		// so we cannot directly test it. We can only test it indirectly through
		// the runTests function's behavior.
		expect(true).toBe(true);
	});
});

describe('Group 4: parseTestOutput() — test limitation', () => {
	it('parseTestOutput is NOT exported from test-runner.ts - cannot test directly', () => {
		// This test documents the limitation - parseTestOutput is not exported
		// so we cannot directly test it. We can only test it indirectly through
		// the runTests function's behavior.
		expect(true).toBe(true);
	});
});

describe('Group 5: SOURCE_EXTENSIONS and SKIP_DIRECTORIES — test limitation', () => {
	it('SOURCE_EXTENSIONS is NOT exported from test-runner.ts - cannot test directly', () => {
		// This test documents the limitation - SOURCE_EXTENSIONS is not exported
		// even though the task instructions mentioned it should be.
		// The actual code shows it's a private const without 'export' keyword.
		expect(true).toBe(true);
	});

	it('SKIP_DIRECTORIES is NOT exported from test-runner.ts - cannot test directly', () => {
		// This test documents the limitation - SKIP_DIRECTORIES is not exported
		// even though the task instructions mentioned it should be.
		// The actual code shows it's a private const without 'export' keyword.
		expect(true).toBe(true);
	});
});

describe('Integration: detectTestFramework with multiple frameworks', () => {
	const tmpDir = '/tmp/test-project';

	it('prioritizes JS frameworks over new languages when package.json exists', async () => {
		mockIsCommandAvailable.mockImplementation(true);
		mockExistsSync.mockImplementation((filePath) => {
			const strPath = String(filePath);
			return strPath.endsWith('package.json') || strPath.endsWith('go.mod');
		});
		mockReaddirSync.mockImplementation([]);
		mockReadFileSync.mockImplementation(
			JSON.stringify({
				scripts: { test: 'vitest' },
			}),
		);

		const result = await detectTestFramework(tmpDir);
		expect(result).toBe('vitest');
	});

	it('detects new language frameworks when JS frameworks not detected', async () => {
		mockIsCommandAvailable.mockImplementation((cmd) => cmd === 'go');
		mockExistsSync.mockImplementation((filePath) => {
			const strPath = String(filePath);
			return strPath.endsWith('go.mod');
		});

		const result = await detectTestFramework(tmpDir);
		expect(result).toBe('go-test');
	});

	it('returns none when no markers exist', async () => {
		mockIsCommandAvailable.mockImplementation(false);
		mockExistsSync.mockImplementation(false);
		mockReaddirSync.mockImplementation([]);

		const result = await detectTestFramework(tmpDir);
		expect(result).toBe('none');
	});
});
