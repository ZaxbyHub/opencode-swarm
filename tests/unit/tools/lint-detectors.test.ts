import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realFs from 'node:fs';
import { detectAdditionalLinter } from '../../../src/tools/lint';

// Mock node:fs
const mockExistsSync = mock();
const mockReadFileSync = mock();
const mockReaddirSync = mock();

mock.module('node:fs', () => ({
	...realFs,
	existsSync: (...args: unknown[]) => mockExistsSync(...args),
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
	readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}));

// Mock isCommandAvailable from build/discovery
const mockIsCommandAvailable = mock();

mock.module('../../../src/build/discovery', () => ({
	isCommandAvailable: (...args: unknown[]) => mockIsCommandAvailable(...args),
}));

describe('detectAdditionalLinter - Linter Detectors', () => {
	const testCwd = '/test/project';

	beforeEach(() => {
		mock.reset();
		// Default: no command available
		mockIsCommandAvailable.mockImplementation(() => false);
		// Default: no files exist
		mockExistsSync.mockImplementation(() => false);
		mockReaddirSync.mockImplementation(() => []);
	});

	describe('detectKtlint (via detectAdditionalLinter returning "ktlint")', () => {
		it('returns "ktlint" when build.gradle.kts exists + ktlint available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ktlint',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('build.gradle.kts'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('ktlint');
		});

		it('returns "ktlint" when build.gradle (Groovy DSL) exists + ktlint available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ktlint',
			);
			mockExistsSync.mockImplementation((p: string) => {
				return (
					typeof p === 'string' &&
					p.endsWith('build.gradle') &&
					!p.endsWith('.kts')
				);
			});
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('ktlint');
		});

		it('returns "ktlint" when root dir has .kt file + ktlint available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ktlint',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['Main.kt', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('ktlint');
		});

		it('returns "ktlint" when root dir has .kts file + ktlint available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ktlint',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['script.kts', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('ktlint');
		});

		it('returns null when only .editorconfig exists (no other Kotlin marker)', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ktlint',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.includes('.editorconfig'),
			);
			mockReaddirSync.mockImplementation(['.editorconfig']);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});

		it('returns null when Kotlin markers exist but ktlint not available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'other-tool',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('build.gradle.kts'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});
	});

	describe('detectCheckstyle (via detectAdditionalLinter returning "checkstyle")', () => {
		it('returns "checkstyle" when pom.xml + mvn available (Maven path)', () => {
			mockIsCommandAvailable.mockImplementation((cmd: string) => cmd === 'mvn');
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('pom.xml'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('checkstyle');
		});

		it('returns "checkstyle" when build.gradle + gradlew exists (Gradle path)', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'other-tool',
			);
			mockExistsSync.mockImplementation((p: string) => {
				return (
					typeof p === 'string' &&
					(p.endsWith('build.gradle') || p.endsWith('gradlew'))
				);
			});
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('checkstyle');
		});

		it('returns "checkstyle" when build.gradle.kts + gradle available (Gradle path)', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'gradle',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('build.gradle.kts'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('checkstyle');
		});

		it('returns null when only pom.xml exists but mvn not available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'other-tool',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('pom.xml'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});

		it('returns null when only Gradle files but neither gradlew nor gradle available', () => {
			mockIsCommandAvailable.mockImplementation((cmd: string) => cmd === 'mvn');
			mockExistsSync.mockImplementation((p: string) => {
				return (
					typeof p === 'string' &&
					(p.endsWith('build.gradle') || p.endsWith('build.gradle.kts'))
				);
			});
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});
	});

	describe('detectCppcheck (via detectAdditionalLinter returning "cppcheck")', () => {
		it('returns "cppcheck" when CMakeLists.txt exists + cppcheck available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('CMakeLists.txt'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('cppcheck');
		});

		it('returns "cppcheck" when root has .cpp file + cppcheck available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['main.cpp', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('cppcheck');
		});

		it('returns "cppcheck" when root has .c file + cppcheck available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['main.c', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('cppcheck');
		});

		it('returns "cppcheck" when root has .h file + cppcheck available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['header.h', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('cppcheck');
		});

		it('returns "cppcheck" when root has .cc file + cppcheck available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['source.cc', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('cppcheck');
		});

		it('returns "cppcheck" when root has .cxx file + cppcheck available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['source.cxx', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('cppcheck');
		});

		it('returns "cppcheck" when root has .hpp file + cppcheck available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['header.hpp', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('cppcheck');
		});

		it('returns "cppcheck" when src/ dir has .c file + cppcheck available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation((p: string) => {
				return (
					typeof p === 'string' &&
					(p === testCwd || p.includes('/src') || p.includes('\\src'))
				);
			});
			mockReaddirSync.mockImplementation((p: string) => {
				if (
					typeof p === 'string' &&
					(p.includes('/src') || p.includes('\\src'))
				) {
					return ['main.c', 'main.cpp'];
				}
				return [];
			});

			expect(detectAdditionalLinter(testCwd)).toBe('cppcheck');
		});

		it('returns "cppcheck" when src/ dir has .cpp file + cppcheck available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation((p: string) => {
				return (
					typeof p === 'string' &&
					(p === testCwd || p.includes('/src') || p.includes('\\src'))
				);
			});
			mockReaddirSync.mockImplementation((p: string) => {
				if (
					typeof p === 'string' &&
					(p.includes('/src') || p.includes('\\src'))
				) {
					return ['main.cpp'];
				}
				return [];
			});

			expect(detectAdditionalLinter(testCwd)).toBe('cppcheck');
		});

		it('returns null when no C/C++ markers', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cppcheck',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['README.md', '.gitignore']);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});

		it('returns null when C/C++ markers exist but cppcheck not available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'other-tool',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['main.c']);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});
	});

	describe('detectRubocop (via detectAdditionalLinter returning "rubocop")', () => {
		it('returns "rubocop" when Gemfile + rubocop available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'rubocop',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('Gemfile'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('rubocop');
		});

		it('returns "rubocop" when gems.rb + rubocop available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'rubocop',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('gems.rb'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('rubocop');
		});

		it('returns "rubocop" when .rubocop.yml + bundle available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'bundle',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('.rubocop.yml'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('rubocop');
		});

		it('returns "rubocop" when .rubocop.yml + rubocop available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'rubocop',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('.rubocop.yml'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('rubocop');
		});

		it('returns null when none of the Ruby markers exist', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'rubocop',
			);
			mockExistsSync.mockImplementation(false);
			mockReaddirSync.mockImplementation(['README.md', '.gitignore']);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});

		it('returns null when Ruby markers exist but neither rubocop nor bundle available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'other-tool',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('Gemfile'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});
	});

	describe('detectDotnetFormat (via detectAdditionalLinter returning "dotnet-format")', () => {
		it('returns "dotnet-format" when MyApp.csproj exists in root + dotnet available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'dotnet',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['MyApp.csproj', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('dotnet-format');
		});

		it('returns "dotnet-format" when MySolution.sln exists in root + dotnet available', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'dotnet',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['MySolution.sln', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe('dotnet-format');
		});

		it('returns null when no .csproj/.sln in root', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'dotnet',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['README.md', 'Program.cs']);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});

		it('returns null when .csproj exists but dotnet not available', () => {
			mockIsCommandAvailable.mockImplementation(false);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(['MyApp.csproj', 'README.md']);

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});
	});

	describe('Detector ordering - earlier detectors take priority', () => {
		it('returns "ruff" when both Python and Kotlin markers exist (ruff has higher priority)', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ruff' || cmd === 'ktlint',
			);
			mockExistsSync.mockImplementation((p: string) => {
				return (
					typeof p === 'string' && (p.endsWith('ruff.toml') || p === testCwd)
				);
			});
			mockReaddirSync.mockImplementation(['main.kt']);

			expect(detectAdditionalLinter(testCwd)).toBe('ruff');
		});
	});

	describe('Return all 10 possible linter names', () => {
		it('returns "ruff" for Python ruff', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ruff',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('ruff.toml'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('ruff');
		});

		it('returns "clippy" for Rust clippy', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'cargo',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('Cargo.toml'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('clippy');
		});

		it('returns "golangci-lint" for Go golangci-lint', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'golangci-lint',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('go.mod'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('golangci-lint');
		});

		it('returns "swiftlint" for Swift swiftlint', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'swiftlint',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('Package.swift'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('swiftlint');
		});

		it('returns "dart-analyze" for Dart/Flutter dart-analyze', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'dart',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('pubspec.yaml'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('dart-analyze');
		});

		it('returns "dart-analyze" for Flutter dart-analyze', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'flutter',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p.endsWith('pubspec.yaml'),
			);
			mockReaddirSync.mockImplementation([]);

			expect(detectAdditionalLinter(testCwd)).toBe('dart-analyze');
		});
	});

	describe('Error handling', () => {
		it('returns null when readdirSync throws an error', () => {
			mockIsCommandAvailable.mockImplementation(
				(cmd: string) => cmd === 'ktlint',
			);
			mockExistsSync.mockImplementation(
				(p: string) => typeof p === 'string' && p === testCwd,
			);
			mockReaddirSync.mockImplementation(() => {
				throw new Error('Permission denied');
			});

			expect(detectAdditionalLinter(testCwd)).toBe(null);
		});
	});
});
