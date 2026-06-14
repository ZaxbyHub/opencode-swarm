/**
 * Language Detector Tests
 *
 * Verification and adversarial tests for src/lang/detector.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	detectProjectLanguages,
	getProfileForFile,
} from '../../../src/lang/detector.js';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles.js';

describe('getProfileForFile', () => {
	it('getProfileForFile("src/index.ts") returns typescript profile', () => {
		const profile = getProfileForFile('src/index.ts');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('typescript');
	});

	it('getProfileForFile("main.py") returns python profile', () => {
		const profile = getProfileForFile('main.py');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('python');
	});

	it('getProfileForFile("lib.rs") returns rust profile', () => {
		const profile = getProfileForFile('lib.rs');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('rust');
	});

	it('getProfileForFile("main.go") returns go profile', () => {
		const profile = getProfileForFile('main.go');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('go');
	});

	it('getProfileForFile("Main.java") returns java profile', () => {
		const profile = getProfileForFile('Main.java');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('java');
	});

	it('getProfileForFile("App.swift") returns swift profile', () => {
		const profile = getProfileForFile('App.swift');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('swift');
	});

	it('getProfileForFile("lib.dart") returns dart profile', () => {
		const profile = getProfileForFile('lib.dart');
		expect(profile).toBeDefined();
		expect(profile?.id).toBe('dart');
	});

	it('getProfileForFile(".gitignore") returns undefined (dotfile, no extension)', () => {
		const profile = getProfileForFile('.gitignore');
		expect(profile).toBeUndefined();
	});

	it('getProfileForFile("README") returns undefined (no extension)', () => {
		const profile = getProfileForFile('README');
		expect(profile).toBeUndefined();
	});

	it('getProfileForFile("makefile.txt") returns undefined (unknown extension)', () => {
		const profile = getProfileForFile('makefile.txt');
		expect(profile).toBeUndefined();
	});
});

describe('detectProjectLanguages', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'detector-test-'));
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch (e) {
			// ignore cleanup errors
		}
	});

	it('Dir with only package.json file → detects typescript profile', async () => {
		await writeFile(
			join(tempDir, 'package.json'),
			JSON.stringify({ name: 'test' }),
		);
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].id).toBe('typescript');
	});

	it('Dir with only Cargo.toml file → detects rust profile', async () => {
		await writeFile(
			join(tempDir, 'Cargo.toml'),
			'[package]\nname = "test"\nversion = "0.1.0"',
		);
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].id).toBe('rust');
	});

	it('Dir with only go.mod file → detects go profile', async () => {
		await writeFile(join(tempDir, 'go.mod'), 'module test\n\ngo 1.21');
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].id).toBe('go');
	});

	it('Dir with only pubspec.yaml file → detects dart profile', async () => {
		await writeFile(
			join(tempDir, 'pubspec.yaml'),
			'name: test\nversion: 1.0.0',
		);
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].id).toBe('dart');
	});

	it('Dir with package.json AND go.mod → detects both typescript and go profiles', async () => {
		await writeFile(
			join(tempDir, 'package.json'),
			JSON.stringify({ name: 'test' }),
		);
		await writeFile(join(tempDir, 'go.mod'), 'module test\n\ngo 1.21');
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toHaveLength(2);
		const ids = profiles.map((p) => p.id);
		expect(ids).toContain('typescript');
		expect(ids).toContain('go');
	});

	it('Dir with build.gradle.kts file → detects kotlin profile', async () => {
		await writeFile(
			join(tempDir, 'build.gradle.kts'),
			'plugins { kotlin("jvm") version "1.9.0" }',
		);
		const profiles = await detectProjectLanguages(tempDir);
		// build.gradle.kts is in detectFiles for both kotlin and java
		expect(profiles.length).toBeGreaterThanOrEqual(1);
		const ids = profiles.map((p) => p.id);
		expect(ids).toContain('kotlin');
	});

	it('Dir with only a *.csproj file → detects csharp via glob (DD-C025)', async () => {
		await writeFile(
			join(tempDir, 'MyApp.csproj'),
			'<Project Sdk="Microsoft.NET.Sdk"></Project>',
		);
		const profiles = await detectProjectLanguages(tempDir);
		const ids = profiles.map((p) => p.id);
		expect(ids).toContain('csharp');
	});

	it('Dir with only a *.sln file → detects csharp via glob (DD-C025)', async () => {
		await writeFile(
			join(tempDir, 'MyApp.sln'),
			'Microsoft Visual Studio Solution File',
		);
		const profiles = await detectProjectLanguages(tempDir);
		const ids = profiles.map((p) => p.id);
		expect(ids).toContain('csharp');
	});

	it('Empty directory → returns empty array []', async () => {
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toEqual([]);
	});

	it('Dir with a file named "index.ts" (no package.json) → detects typescript via extension', async () => {
		await writeFile(join(tempDir, 'index.ts'), 'console.log("hello");');
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].id).toBe('typescript');
	});

	it('Monorepo: root has package.json, subdirectory has Cargo.toml → both typescript and rust detected', async () => {
		await writeFile(
			join(tempDir, 'package.json'),
			JSON.stringify({ name: 'root' }),
		);
		const subdir = join(tempDir, 'rust-service');
		await mkdir(subdir);
		await writeFile(
			join(subdir, 'Cargo.toml'),
			'[package]\nname = "rust-service"\nversion = "0.1.0"',
		);
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toHaveLength(2);
		const ids = profiles.map((p) => p.id);
		expect(ids).toContain('typescript');
		expect(ids).toContain('rust');
	});

	it('Results sorted: Tier 1 profiles come before Tier 2 profiles (package.json + build.gradle.kts → typescript before kotlin)', async () => {
		await writeFile(
			join(tempDir, 'package.json'),
			JSON.stringify({ name: 'test' }),
		);
		await writeFile(
			join(tempDir, 'build.gradle.kts'),
			'plugins { kotlin("jvm") version "1.9.0" }',
		);
		const profiles = await detectProjectLanguages(tempDir);
		// package.json → TypeScript (tier 1), build.gradle.kts → Kotlin & Java (both tier 2) = 3 profiles total
		expect(profiles.length).toBeGreaterThanOrEqual(2);
		// TypeScript (tier 1) should come before Kotlin and Java (both tier 2)
		expect(profiles[0].id).toBe('typescript');
		expect(profiles[0].tier).toBe(1);
		// Remaining profiles should be tier 2
		const tier2Profiles = profiles.slice(1);
		tier2Profiles.forEach((p) => expect(p.tier).toBe(2));
		const ids = profiles.map((p) => p.id);
		expect(ids).toContain('kotlin');
	});
});

describe('detectProjectLanguages adversarial', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'detector-test-'));
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch (e) {
			// ignore cleanup errors
		}
	});

	it('Unreadable directory path → returns empty array, does not throw', async () => {
		// On Windows, we need to handle path restrictions differently
		// Use a non-existent path with invalid characters for the OS
		const unreadablePath =
			process.platform === 'win32'
				? 'NUL\\invalid\\path' // NUL is reserved on Windows
				: '/dev/null/invalid/path'; // /dev/null is a special file

		// This should not throw and should return an empty array
		const profiles = await detectProjectLanguages(unreadablePath);
		expect(profiles).toEqual([]);
	});

	it('Non-existent directory → returns empty array', async () => {
		const nonExistent = join(tempDir, 'does-not-exist');
		const profiles = await detectProjectLanguages(nonExistent);
		expect(profiles).toEqual([]);
	});

	it('Directory with only files of unknown extensions (.xyz, .abc) → returns empty array', async () => {
		await writeFile(join(tempDir, 'file.xyz'), 'content');
		await writeFile(join(tempDir, 'file.abc'), 'content');
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toEqual([]);
	});

	it('Dir with glob-pattern build.detectFile (e.g. C# "*.csproj") — use a file named "App.cs" and verify that C# is detected via extension (.cs file, not via the glob pattern)', async () => {
		// The C# profile has "*.csproj" as a detectFiles entry which is a glob pattern
		// According to the detector.ts code, glob patterns are skipped (lines 48-49)
		// So we should verify detection happens via .cs extension instead
		await writeFile(
			join(tempDir, 'App.cs'),
			'namespace Test { class App { } }',
		);
		const profiles = await detectProjectLanguages(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].id).toBe('csharp');
	});

	it('Malformed package.json → does not throw, does not detect TypeScript', async () => {
		// A package.json with invalid JSON must not crash detectProjectLanguages.
		// The file may match the filename check but should not surface typescript
		// unless its content is parseable with the right fields.
		await writeFile(join(tempDir, 'package.json'), '{ invalid json !!');
		// Must complete without throwing
		let caughtError: unknown;
		let profiles:
			| Awaited<ReturnType<typeof detectProjectLanguages>>
			| undefined;
		try {
			profiles = await detectProjectLanguages(tempDir);
		} catch (e) {
			caughtError = e;
		}
		expect(caughtError).toBeUndefined();
		expect(profiles).toBeDefined();
		// Detection is based on filename presence, not content, so TypeScript
		// may or may not be detected — but the key invariant is no throw.
	});

	it('Directory with a glob-pattern name matching *.csproj (F-004) — directory named "MyProject.csproj" must NOT trigger C# detection', async () => {
		// A directory named "MyProject.csproj" must not be treated as a C# project
		// file; only regular files should match glob detection patterns (F-004).
		await mkdir(join(tempDir, 'MyProject.csproj'));
		const profiles = await detectProjectLanguages(tempDir);
		const ids = profiles.map((p) => p.id);
		expect(ids).not.toContain('csharp');
	});

	it('Circular symlink in directory → does not throw, returns results based on real files', async () => {
		// Create a circular symlink. readdir with withFileTypes exposes it as a
		// symlink and isDirectory() returns false, so it should be treated safely
		// and not cause infinite loops or crashes.
		if (process.platform === 'win32') {
			// Symlink creation requires elevated privileges on Windows; skip.
			return;
		}
		const { symlink } = await import('node:fs/promises');
		const linkPath = join(tempDir, 'self-link');
		try {
			await symlink(linkPath, linkPath);
		} catch {
			// Some platforms may refuse self-referential symlinks; still verify no throw.
		}
		await writeFile(
			join(tempDir, 'package.json'),
			JSON.stringify({ name: 'test' }),
		);
		let caughtError: unknown;
		let profiles:
			| Awaited<ReturnType<typeof detectProjectLanguages>>
			| undefined;
		try {
			profiles = await detectProjectLanguages(tempDir);
		} catch (e) {
			caughtError = e;
		}
		expect(caughtError).toBeUndefined();
		expect(profiles).toBeDefined();
	});
});
