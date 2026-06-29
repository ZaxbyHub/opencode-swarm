import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	detectProjectLanguages,
	getProfileForFile,
} from '../../../src/lang/detector';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';

describe('Profile-driven tool integration tests', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'tool-profiles-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('1. getProfileForFile integration with syntax-check', () => {
		it('returns Rust profile with correct grammarId for .rs files', () => {
			const profile = getProfileForFile('src/main.rs');
			expect(profile).toBeDefined();
			expect(profile?.id).toBe('rust');
			expect(profile?.treeSitter.grammarId).toBe('rust');
		});

		it('returns TypeScript profile with correct grammarId for .ts files', () => {
			const profile = getProfileForFile('src/index.ts');
			expect(profile).toBeDefined();
			expect(profile?.id).toBe('typescript');
			expect(profile?.treeSitter.grammarId).toBe('typescript');
		});

		it('returns Python profile with correct grammarId for .py files', () => {
			const profile = getProfileForFile('src/main.py');
			expect(profile).toBeDefined();
			expect(profile?.id).toBe('python');
			expect(profile?.treeSitter.grammarId).toBe('python');
		});
	});

	describe('2. detectProjectLanguages → profiles structure', () => {
		it('detects Rust project and returns profile with build, test, lint, and audit config', async () => {
			const cargoToml = `
[package]
name = "test-project"
version = "0.1.0"
edition = "2021"
`;
			await writeFile(join(tempDir, 'Cargo.toml'), cargoToml);

			const detected = await detectProjectLanguages(tempDir);
			const rustProfile = detected.find((l) => l.id === 'rust');

			expect(rustProfile).toBeDefined();
			expect(rustProfile?.build.commands.length).toBeGreaterThan(0);
			expect(
				rustProfile?.build.commands.some((cmd) =>
					cmd.cmd.includes('cargo build'),
				),
			).toBe(true);
			expect(
				rustProfile?.test.frameworks.some((fw) =>
					fw.cmd.includes('cargo test'),
				),
			).toBe(true);
			expect(rustProfile?.lint.linters.some((l) => l.name === 'clippy')).toBe(
				true,
			);
			expect(rustProfile?.audit.command).toContain('cargo');
		});

		it('detects Go project and returns profile with build commands', async () => {
			const goMod = `
module test-project

go 1.21
`;
			await writeFile(join(tempDir, 'go.mod'), goMod);

			const detected = await detectProjectLanguages(tempDir);
			const goProfile = detected.find((l) => l.id === 'go');

			expect(goProfile).toBeDefined();
			expect(goProfile?.build.commands.length).toBeGreaterThan(0);
			expect(goProfile?.test.frameworks.length).toBeGreaterThan(0);
			expect(goProfile?.lint.linters.length).toBeGreaterThan(0);
		});

		it('detects Python project and returns profile with test and lint config', async () => {
			const pyprojectToml = `
[project]
name = "test-project"
version = "0.1.0"
requires-python = ">=3.8"

[tool.pytest.ini_options]
testpaths = ["tests"]
`;
			await writeFile(join(tempDir, 'pyproject.toml'), pyprojectToml);

			const detected = await detectProjectLanguages(tempDir);
			const pythonProfile = detected.find((l) => l.id === 'python');

			expect(pythonProfile).toBeDefined();
			expect(
				pythonProfile?.test.frameworks.some((fw) => fw.cmd.includes('pytest')),
			).toBe(true);
			expect(pythonProfile?.lint.linters.some((l) => l.name === 'ruff')).toBe(
				true,
			);
			expect(pythonProfile?.audit.command).toContain('pip');
		});
	});

	describe('3. getProfileForFile for all tier extensions', () => {
		it('returns Kotlin profile for .kt files with populated fields', () => {
			const profile = getProfileForFile('src/main.kt');
			expect(profile).toBeDefined();
			expect(profile?.id).toBe('kotlin');
			expect(profile?.displayName).toBeTruthy();
			expect(profile?.displayName.length).toBeGreaterThan(0);
			expect(profile?.extensions).toContain('.kt');
		});

		it('returns C# profile for .cs files with populated fields', () => {
			const profile = getProfileForFile('src/Program.cs');
			expect(profile).toBeDefined();
			expect(profile?.id).toBe('csharp');
			expect(profile?.displayName).toBeTruthy();
			expect(profile?.displayName.length).toBeGreaterThan(0);
			expect(profile?.extensions).toContain('.cs');
		});

		it('returns C++ profile for .cpp files with populated fields', () => {
			const profile = getProfileForFile('src/main.cpp');
			expect(profile).toBeDefined();
			expect(profile?.id).toBe('cpp');
			expect(profile?.displayName).toBeTruthy();
			expect(profile?.displayName.length).toBeGreaterThan(0);
			expect(profile?.extensions).toContain('.cpp');
		});

		it('returns Swift profile for .swift files with populated fields', () => {
			const profile = getProfileForFile('src/main.swift');
			expect(profile).toBeDefined();
			expect(profile?.id).toBe('swift');
			expect(profile?.displayName).toBeTruthy();
			expect(profile?.displayName.length).toBeGreaterThan(0);
			expect(profile?.extensions).toContain('.swift');
		});

		it('returns Dart profile for .dart files with populated fields', () => {
			const profile = getProfileForFile('lib/main.dart');
			expect(profile).toBeDefined();
			expect(profile?.id).toBe('dart');
			expect(profile?.displayName).toBeTruthy();
			expect(profile?.displayName.length).toBeGreaterThan(0);
			expect(profile?.extensions).toContain('.dart');
		});

		it('returns Ruby profile for .rb files with populated fields', () => {
			const profile = getProfileForFile('src/main.rb');
			expect(profile).toBeDefined();
			expect(profile?.id).toBe('ruby');
			expect(profile?.displayName).toBeTruthy();
			expect(profile?.displayName.length).toBeGreaterThan(0);
			expect(profile?.extensions).toContain('.rb');
		});
	});

	describe('4. Profile tier field verification for new languages', () => {
		it('kotlin is tier 2', () => {
			const profile = LANGUAGE_REGISTRY.get('kotlin');
			expect(profile).toBeDefined();
			expect(profile?.tier).toBe(2);
		});

		it('dart is tier 3', () => {
			const profile = LANGUAGE_REGISTRY.get('dart');
			expect(profile).toBeDefined();
			expect(profile?.tier).toBe(3);
		});

		it('ruby is tier 3', () => {
			const profile = LANGUAGE_REGISTRY.get('ruby');
			expect(profile).toBeDefined();
			expect(profile?.tier).toBe(3);
		});

		it('TypeScript is tier 1', () => {
			const profile = LANGUAGE_REGISTRY.get('typescript');
			expect(profile).toBeDefined();
			expect(profile?.tier).toBe(1);
		});

		it('Rust is tier 1', () => {
			const profile = LANGUAGE_REGISTRY.get('rust');
			expect(profile).toBeDefined();
			expect(profile?.tier).toBe(1);
		});
	});

	describe('5. Build commands ordering', () => {
		it('Go profile has build commands ordered by priority with go command', () => {
			const profile = LANGUAGE_REGISTRY.get('go');
			expect(profile).toBeDefined();
			expect(profile?.build.commands.length).toBeGreaterThan(0);
			expect(
				profile?.build.commands.some((cmd) => cmd.cmd.includes('go')),
			).toBe(true);
		});

		it('Rust profile has cargo build command', () => {
			const profile = LANGUAGE_REGISTRY.get('rust');
			expect(profile).toBeDefined();
			expect(profile?.build.commands.length).toBeGreaterThan(0);
			expect(
				profile?.build.commands.some((cmd) => cmd.cmd.includes('cargo build')),
			).toBe(true);
		});

		it('TypeScript profile has build commands', () => {
			const profile = LANGUAGE_REGISTRY.get('typescript');
			expect(profile).toBeDefined();
			expect(profile?.build.commands.length).toBeGreaterThan(0);
		});
	});

	describe('6. Test framework detection via profile', () => {
		it('Python profile has pytest framework with detect field', () => {
			const profile = LANGUAGE_REGISTRY.get('python');
			expect(profile).toBeDefined();
			expect(profile?.test.frameworks.length).toBeGreaterThan(0);

			const pytestFw = profile?.test.frameworks.find(
				(fw) => fw.detect === 'pytest.ini' || fw.detect === 'pyproject.toml',
			);
			expect(pytestFw).toBeDefined();
			expect(pytestFw?.cmd).toContain('pytest');
		});

		it('Rust profile has cargo test framework', () => {
			const profile = LANGUAGE_REGISTRY.get('rust');
			expect(profile).toBeDefined();
			expect(profile?.test.frameworks.length).toBeGreaterThan(0);
			expect(
				profile?.test.frameworks.some((fw) => fw.cmd.includes('cargo test')),
			).toBe(true);
		});

		it('Go profile has go test framework', () => {
			const profile = LANGUAGE_REGISTRY.get('go');
			expect(profile).toBeDefined();
			expect(profile?.test.frameworks.length).toBeGreaterThan(0);
			expect(
				profile?.test.frameworks.some((fw) => fw.cmd.includes('go test')),
			).toBe(true);
		});
	});

	describe('7. Missing binary graceful degradation', () => {
		it('profile exists for a language even when binary might not be installed', () => {
			const kotlinProfile = LANGUAGE_REGISTRY.get('kotlin');
			const swiftProfile = LANGUAGE_REGISTRY.get('swift');
			const dartProfile = LANGUAGE_REGISTRY.get('dart');

			// Profiles should exist regardless of binary installation
			expect(kotlinProfile).toBeDefined();
			expect(kotlinProfile).not.toBeNull();

			expect(swiftProfile).toBeDefined();
			expect(swiftProfile).not.toBeNull();

			expect(dartProfile).toBeDefined();
			expect(dartProfile).not.toBeNull();
		});

		it('profile data is non-null regardless of binary availability', () => {
			const profiles = ['kotlin', 'swift', 'dart', 'ruby', 'csharp', 'cpp'];

			profiles.forEach((langId) => {
				const profile = LANGUAGE_REGISTRY.get(langId);
				expect(profile).toBeDefined();
				expect(profile?.id).toBe(langId);
				expect(profile?.displayName).toBeTruthy();
				expect(profile?.extensions).toBeDefined();
				expect(profile?.extensions.length).toBeGreaterThan(0);
			});
		});
	});

	describe('8. Semgrep dispatch path', () => {
		it('Ruby profile has null nativeRuleSet and experimental semgrepSupport', () => {
			const profile = LANGUAGE_REGISTRY.get('ruby');
			expect(profile).toBeDefined();
			expect(profile?.sast.nativeRuleSet).toBeNull();
			expect(profile?.sast.semgrepSupport).toBe('experimental');
		});

		it('Kotlin profile has null nativeRuleSet for Semgrep dispatch', () => {
			const profile = LANGUAGE_REGISTRY.get('kotlin');
			expect(profile).toBeDefined();
			expect(profile?.sast.nativeRuleSet).toBeNull();
			expect(profile?.sast.semgrepSupport).not.toBe('none');
		});

		it('Dart profile has null nativeRuleSet and semgrepSupport is none (Semgrep should not be used)', () => {
			const profile = LANGUAGE_REGISTRY.get('dart');
			expect(profile).toBeDefined();
			expect(profile?.sast.nativeRuleSet).toBeNull();
			expect(profile?.sast.semgrepSupport).toBe('none');
		});

		it('Swift profile has null nativeRuleSet for Semgrep dispatch', () => {
			const profile = LANGUAGE_REGISTRY.get('swift');
			expect(profile).toBeDefined();
			expect(profile?.sast.nativeRuleSet).toBeNull();
			expect(profile?.sast.semgrepSupport).not.toBe('none');
		});
	});

	describe('9. Null audit command for Tier 2+ profiles without audit tools', () => {
		it('Swift profile has null audit command (no known audit tool)', () => {
			const profile = LANGUAGE_REGISTRY.get('swift');
			expect(profile).toBeDefined();
			expect(profile?.audit.command).toBeNull();
		});

		it('Kotlin profile has null audit command', () => {
			const profile = LANGUAGE_REGISTRY.get('kotlin');
			expect(profile).toBeDefined();
			expect(profile?.audit.command).toBeNull();
		});

		it('Ruby profile has audit command (bundle-audit)', () => {
			const profile = LANGUAGE_REGISTRY.get('ruby');
			expect(profile).toBeDefined();
			expect(profile?.audit.command).toBeTruthy();
			expect(profile?.audit.command).toContain('bundle');
		});

		it('Rust profile has audit command (cargo audit)', () => {
			const profile = LANGUAGE_REGISTRY.get('rust');
			expect(profile).toBeDefined();
			expect(profile?.audit.command).toBeTruthy();
			expect(profile?.audit.command).toContain('cargo');
		});
	});

	describe('10. Profile-driven linter data', () => {
		it('Rust profile has clippy in linters', () => {
			const profile = LANGUAGE_REGISTRY.get('rust');
			expect(profile).toBeDefined();
			expect(profile?.lint.linters.some((l) => l.name === 'clippy')).toBe(true);
		});

		it('Python profile has ruff in linters', () => {
			const profile = LANGUAGE_REGISTRY.get('python');
			expect(profile).toBeDefined();
			expect(profile?.lint.linters.some((l) => l.name === 'ruff')).toBe(true);
		});

		it('TypeScript profile has biome in linters', () => {
			const profile = LANGUAGE_REGISTRY.get('typescript');
			expect(profile).toBeDefined();
			expect(profile?.lint.linters.some((l) => l.name === 'biome')).toBe(true);
		});

		it('Go profile has golangci-lint in linters', () => {
			const profile = LANGUAGE_REGISTRY.get('go');
			expect(profile).toBeDefined();
			expect(
				profile?.lint.linters.some((l) => l.name === 'golangci-lint'),
			).toBe(true);
		});

		it('C# profile has dotnet format/analyze in linters', () => {
			const profile = LANGUAGE_REGISTRY.get('csharp');
			expect(profile).toBeDefined();
			expect(profile?.lint.linters.length).toBeGreaterThan(0);
			expect(profile?.lint.linters.some((l) => l.name.includes('dotnet'))).toBe(
				true,
			);
		});

		it('Dart profile has dart analyze in linters', () => {
			const profile = LANGUAGE_REGISTRY.get('dart');
			expect(profile).toBeDefined();
			expect(profile?.lint.linters.some((l) => l.name.includes('dart'))).toBe(
				true,
			);
		});
	});
});
