import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as javaInternals } from '../../../src/lang/backends/java';
import {
	_internals,
	detectTestFramework,
	resolveMavenModuleDir,
	test_runner,
} from '../../../src/tools/test-runner';
import { _internals as batchInternals } from '../../../src/utils/windows-batch';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalBunSpawn = _internals.bunSpawn;
const originalIsCommandAvailable = _internals.isCommandAvailable;
const originalExistsSync = _internals.existsSync;
const originalReaddirSync = _internals.readdirSync;
const originalIsExecutableFile = javaInternals.isExecutableFile;
const originalComSpec = batchInternals.comSpec;
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value: platform });
}

let spawnCalls: Array<{ cmd: string[]; opts: { cwd?: string } }> = [];

function mockBunSpawn(
	cmd: string[],
	opts: { cwd?: string },
): ReturnType<typeof _internals.bunSpawn> {
	spawnCalls.push({ cmd, opts });
	return {
		stdout: new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
		exited: Promise.resolve(0),
		exitCode: 0,
		kill: () => {},
	} as unknown as ReturnType<typeof _internals.bunSpawn>;
}

const createTempDir = () => canonicalMkdtemp('test-runner-maven-nested-');

function createFile(dir: string, filePath: string, content = ''): void {
	const fullPath = path.join(dir, filePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content);
}

describe('nested Maven module detection and execution', () => {
	let tempDir: string;
	const tempDirs: string[] = [];

	beforeEach(() => {
		tempDir = createTempDir();
		tempDirs.push(tempDir);
		spawnCalls = [];
		_internals.bunSpawn = mockBunSpawn;
		_internals.isCommandAvailable = () => true;
	});

	afterEach(() => {
		_internals.bunSpawn = originalBunSpawn;
		_internals.isCommandAvailable = originalIsCommandAvailable;
		_internals.existsSync = originalExistsSync;
		_internals.readdirSync = originalReaddirSync;
		javaInternals.isExecutableFile = originalIsExecutableFile;
		batchInternals.comSpec = originalComSpec;
		setPlatform(originalPlatform);
		for (const dir of tempDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
		tempDirs.length = 0;
	});

	describe('end-to-end default dispatch', () => {
		let priorAllowFullSuite: string | undefined;

		beforeEach(() => {
			priorAllowFullSuite = process.env.SWARM_ALLOW_FULL_SUITE;
			process.env.SWARM_ALLOW_FULL_SUITE = '1';
		});

		afterEach(() => {
			if (priorAllowFullSuite === undefined)
				delete process.env.SWARM_ALLOW_FULL_SUITE;
			else process.env.SWARM_ALLOW_FULL_SUITE = priorAllowFullSuite;
		});

		test('scope:all stays at root when root pom.xml exists (aggregator reactor)', async () => {
			createFile(tempDir, 'pom.xml', '<project/>');
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(
				tempDir,
				'backend/src/test/java/FooTest.java',
				'class FooTest {}',
			);

			await test_runner.execute({ scope: 'all' }, { directory: tempDir });

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual(['mvn', 'test']);
			expect(spawnCalls[0].opts.cwd).toBe(tempDir);
		});

		test('scope:all file-less runs mvn test from the nested module dir', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			await test_runner.execute({ scope: 'all' }, { directory: tempDir });

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual(['mvn', 'test']);
			expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
		});

		test('scope:all prefers an executable ./mvnw when mvn is not on PATH (POSIX)', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(tempDir, 'backend/mvnw', '#!/bin/sh\n');
			_internals.isCommandAvailable = () => false;
			setPlatform('linux');
			javaInternals.isExecutableFile = () => true;

			await test_runner.execute({ scope: 'all' }, { directory: tempDir });

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual(['./mvnw', 'test']);
			expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
		});

		test('scope:all forwards targets as -Dtest in the module dir', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			await test_runner.execute(
				{ scope: 'all', targets: ['FooTest'] },
				{ directory: tempDir },
			);

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual(['mvn', 'test', '-Dtest=FooTest']);
			expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
		});
	});

	describe('convention-scope derived targets (#3072)', () => {
		test('Java test file without targets derives -Dtest in the module dir', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(
				tempDir,
				'backend/src/test/java/FooTest.java',
				'class FooTest {}',
			);

			await test_runner.execute(
				{ scope: 'convention', files: ['backend/src/test/java/FooTest.java'] },
				{ directory: tempDir },
			);

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].cmd).toEqual(['mvn', 'test', '-Dtest=FooTest']);
			expect(spawnCalls[0].opts.cwd).toBe(path.join(tempDir, 'backend'));
		});
	});

	describe('scope:target root resolution', () => {
		test('native target execution stays rooted at the project root', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(tempDir, 'go.mod', 'module example\n\ngo 1.21');
			createFile(
				tempDir,
				'pkg/foo_test.go',
				'package pkg\nfunc TestFoo(t *testing.T) {}',
			);

			await test_runner.execute(
				{
					scope: 'target',
					native_target: {
						framework: 'go-test',
						name: 'TestFoo',
						path: 'pkg',
					},
				},
				{ directory: tempDir },
			);

			expect(spawnCalls.length).toBe(1);
			expect(spawnCalls[0].opts.cwd).toBe(tempDir);
		});
	});

	describe('resolveMavenModuleDir', () => {
		test('walks up from a Java test file through a two-level nested pom', () => {
			createFile(tempDir, 'services/backend/pom.xml', '<project/>');
			createFile(tempDir, 'services/backend/src/test/java/FooTest.java', '');

			const result = resolveMavenModuleDir(tempDir, [
				'services/backend/src/test/java/FooTest.java',
			]);

			expect(result).toBe(path.join(tempDir, 'services/backend'));
		});

		test('one-level probe with no files returns the module dir', () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = resolveMavenModuleDir(tempDir);

			expect(result).toBe(path.join(tempDir, 'backend'));
		});

		test('returns null when no nested pom exists', () => {
			const result = resolveMavenModuleDir(tempDir);

			expect(result).toBeNull();
		});

		test('ignores a pom.xml above the project root', () => {
			const leakRoot = canonicalMkdtemp('leak-');
			tempDirs.push(leakRoot);
			const projDir = path.join(leakRoot, 'proj');
			fs.mkdirSync(projDir, { recursive: true });
			createFile(projDir, 'src/test/java/FooTest.java', '');
			fs.writeFileSync(path.join(leakRoot, 'pom.xml'), '<project/>');

			const result = resolveMavenModuleDir(projDir, [
				'src/test/java/FooTest.java',
			]);

			expect(result).toBeNull();
		});

		test('drops outside-root file paths and returns null when no in-root file remains', () => {
			const otherDir = createTempDir();
			tempDirs.push(otherDir);
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(otherDir, 'src/test/java/FooTest.java', '');

			const result = resolveMavenModuleDir(tempDir, [
				path.join(otherDir, 'src/test/java/FooTest.java'),
			]);

			expect(result).toBeNull();
		});

		test('deterministic tie-break picks the first directory alphabetically', () => {
			createFile(tempDir, 'zeta/pom.xml', '<project/>');
			createFile(tempDir, 'alpha/pom.xml', '<project/>');

			const result = resolveMavenModuleDir(tempDir);

			expect(result).toBe(path.join(tempDir, 'alpha'));
		});

		// F-3b: detectJavaMaven runs before detectGradle/detectDotnetTest and
		// resolveMavenModuleDir; root pom returns early so readdirSync never probes root.
		test('root pom wins before the dotnet detector (readdir never probes root)', async () => {
			createFile(tempDir, 'pom.xml', '<project/>');
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const readdirArgs: string[] = [];
			const origReaddir = _internals.readdirSync;
			_internals.readdirSync = ((p: fs.PathLike, options?: unknown) => {
				readdirArgs.push(p.toString());
				return origReaddir(p as any, options as any);
			}) as unknown as typeof _internals.readdirSync;

			try {
				const result = await detectTestFramework(tempDir);
				expect(result).toBe('maven');
				// Probe root (tempDir) never read: detectJavaMaven returns early.
				expect(readdirArgs).not.toContain(path.resolve(tempDir));
			} finally {
				_internals.readdirSync = origReaddir;
			}
		});

		test('root pom keeps scope:all spawn cwd at root with nested backend/pom.xml', async () => {
			createFile(tempDir, 'pom.xml', '<project/>');
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const priorEnv = process.env.SWARM_ALLOW_FULL_SUITE;
			process.env.SWARM_ALLOW_FULL_SUITE = '1';
			try {
				await test_runner.execute({ scope: 'all' }, { directory: tempDir });
				expect(spawnCalls.length).toBe(1);
				expect(spawnCalls[0].opts.cwd).toBe(tempDir);
			} finally {
				if (priorEnv === undefined) delete process.env.SWARM_ALLOW_FULL_SUITE;
				else process.env.SWARM_ALLOW_FULL_SUITE = priorEnv;
			}
		});
	});

	describe('detectTestFramework nested fallback', () => {
		test('falls back to maven when mvn is on PATH and no mvnw exists', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await detectTestFramework(tempDir);

			expect(result).toBe('maven');
		});

		test('POSIX: accepts an executable mvnw without mvn, rejects a non-executable one', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(tempDir, 'backend/mvnw', '#!/bin/sh\n');
			_internals.isCommandAvailable = () => false;
			setPlatform('linux');

			javaInternals.isExecutableFile = () => true;
			expect(await detectTestFramework(tempDir)).toBe('maven');
			javaInternals.isExecutableFile = () => false;
			expect(await detectTestFramework(tempDir)).toBe('none');
		});

		// FB-F3c: the detector consults the shared runnable-wrapper predicate, so a
		// lone mvnw.cmd is only usable on win32 (via the cmd.exe launcher).
		test('lone mvnw.cmd module is detected without mvn on PATH only on win32', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(tempDir, 'backend/mvnw.cmd', '@echo off\r\n');
			createFile(tempDir, 'sys/cmd.exe', '');
			batchInternals.comSpec = () => path.join(tempDir, 'sys', 'cmd.exe');
			_internals.isCommandAvailable = () => false;

			setPlatform('win32');
			expect(await detectTestFramework(tempDir)).toBe('maven');
			setPlatform('linux');
			expect(await detectTestFramework(tempDir)).toBe('none');
		});

		test('win32: a POSIX-only mvnw is not a usable wrapper', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');
			createFile(tempDir, 'backend/mvnw', '#!/bin/sh\n');
			_internals.isCommandAvailable = () => false;
			javaInternals.isExecutableFile = () => true;
			setPlatform('win32');

			expect(await detectTestFramework(tempDir)).toBe('none');
		});
	});

	// W-GATE: a root pom.xml disables the nested fallback in detection too, so
	// detection and the execute cwd override cannot disagree.
	describe('root pom.xml gates the nested fallback', () => {
		beforeEach(() => {
			createFile(tempDir, 'pom.xml', '<project/>');
			_internals.isCommandAvailable = () => false;
			setPlatform('linux');
			javaInternals.isExecutableFile = () => true;
		});

		test('root pom + api/mvnw without mvn: detect none, execute spawns nothing', async () => {
			createFile(tempDir, 'api/pom.xml', '<project/>');
			createFile(tempDir, 'api/mvnw', '#!/bin/sh\n');
			expect(await detectTestFramework(tempDir)).toBe('none');

			// Legacy detection only: the dispatch path's ROOT detection consults the
			// real PATH for mvn (host-dependent); the nested fallback under test is
			// the legacy detector's, which uses the stubbed isCommandAvailable.
			const prior = process.env.SWARM_ALLOW_FULL_SUITE;
			const priorBackend = process.env.SWARM_LANG_BACKEND;
			process.env.SWARM_ALLOW_FULL_SUITE = '1';
			process.env.SWARM_LANG_BACKEND = 'legacy';
			try {
				const parsed = JSON.parse(
					await test_runner.execute({ scope: 'all' }, { directory: tempDir }),
				);
				expect(parsed.framework).toBe('none');
				expect(parsed.error).toBe('No test framework detected');
				expect(spawnCalls.length).toBe(0);
			} finally {
				if (prior === undefined) delete process.env.SWARM_ALLOW_FULL_SUITE;
				else process.env.SWARM_ALLOW_FULL_SUITE = prior;
				if (priorBackend === undefined) delete process.env.SWARM_LANG_BACKEND;
				else process.env.SWARM_LANG_BACKEND = priorBackend;
			}
		});

		test('root pom + core/mvnw with files in core: detect none', async () => {
			createFile(tempDir, 'core/pom.xml', '<project/>');
			createFile(tempDir, 'core/mvnw', '#!/bin/sh\n');
			createFile(tempDir, 'core/src/test/java/FooTest.java', '');

			expect(
				await detectTestFramework(tempDir, ['core/src/test/java/FooTest.java']),
			).toBe('none');
		});
	});

	describe('file-less scope guards with nested Maven detection', () => {
		test('scope=convention with no files and no targets returns the explicit guard error', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await test_runner.execute(
				{ scope: 'convention' },
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('require a non-empty files array');
			expect(spawnCalls.length).toBe(0);
		});

		test('scope=convention with targets only does not crash and returns structured error for maven', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await test_runner.execute(
				{ scope: 'convention', targets: ['SomeTest'] },
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.framework).toBe('none');
			expect(parsed.error).toContain('require a non-empty files array');
			expect(spawnCalls.length).toBe(0);
		});

		test('scope=graph with targets only does not crash and returns structured error for maven', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await test_runner.execute(
				{ scope: 'graph', targets: ['SomeTest'] },
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.framework).toBe('none');
			expect(parsed.error).toContain('require a non-empty files array');
			expect(spawnCalls.length).toBe(0);
		});

		test('scope=impact with targets only does not crash and returns structured error for maven', async () => {
			createFile(tempDir, 'backend/pom.xml', '<project/>');

			const result = await test_runner.execute(
				{ scope: 'impact', targets: ['SomeTest'] },
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.framework).toBe('none');
			expect(parsed.error).toContain('require a non-empty files array');
			expect(spawnCalls.length).toBe(0);
		});
	});
});
