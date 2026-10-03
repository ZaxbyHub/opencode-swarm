/**
 * Issue #3050 — Composer `vendor/bin` wrappers must never become a raw spawn
 * target on win32.
 *
 * Node's `child_process.spawn` rejects a batch file outright (EINVAL), and
 * although Bun tolerates one, that tolerance is a runtime accident rather than
 * a contract — so the argv must not depend on which runtime hosts the plugin.
 * All three PHP vendor routes therefore go through the contained cmd.exe
 * launcher, with a PHP-interpreter fallback when the launcher declines.
 *
 * These tests run on EVERY platform, not just Windows. Faking `process.platform`
 * alone is not enough: `resolveContainedWindowsBatchCommand` also requires
 * `ComSpec` to resolve to a real regular file whose canonical basename is
 * `cmd.exe` (`src/utils/windows-batch.ts:54-74`) or it returns null. So the
 * suite creates a fixture file literally named `cmd.exe` and points ComSpec at
 * it. Every launcher-shape assertion in the #3040 gradle precedent is
 * `skipIf(process.platform !== 'win32')`-gated and therefore gives Linux/macOS
 * CI no coverage at all; this suite closes that hole deliberately.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildPhpBackend } from '../../../src/lang/backends/php';
import { defaultBuildTestCommand } from '../../../src/lang/default-backend';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';
import {
	_internals as runnerInternals,
	runTests,
} from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Mirrors WINDOWS_CMD_UNSAFE_TOKEN (src/utils/windows-batch.ts:32). */
const WINDOWS_CMD_UNSAFE_TOKEN = /["%!^&|<>\r\n]/;

const phpProfile = LANGUAGE_REGISTRY.get('php');
const realPlatform = process.platform;
const realComSpec = process.env.ComSpec;
const realBunSpawn = runnerInternals.bunSpawn;
const realLangBackend = process.env.SWARM_LANG_BACKEND;

let tempDir: string;
let cmdExePath: string;

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
}

/** Write a realistic Composer layout: the proxy plus the .bat shim. */
function writeComposerFixture(dir: string, names: string[]): void {
	fs.mkdirSync(path.join(dir, 'vendor', 'bin'), { recursive: true });
	for (const name of names) {
		fs.writeFileSync(
			path.join(dir, 'vendor', 'bin', name),
			'#!/usr/bin/env php\n<?php\n',
		);
		fs.writeFileSync(
			path.join(dir, 'vendor', 'bin', `${name}.bat`),
			`@ECHO off\r\nphp "%~dp0${name}" %*\r\n`,
		);
	}
}

function fakeWin32(): void {
	Object.defineProperty(process, 'platform', { value: 'win32' });
	process.env.ComSpec = cmdExePath;
}

function fakePosix(): void {
	Object.defineProperty(process, 'platform', { value: 'linux' });
}

/**
 * `selectTestFramework` probes `Pest.php` before `phpunit.xml`, so a fixture
 * carrying both markers always selects pest. Leave exactly one detection
 * marker so each framework's own branch is the one under test.
 */
function markOnly(framework: 'phpunit' | 'pest'): void {
	if (framework === 'pest') {
		fs.rmSync(path.join(tempDir, 'phpunit.xml'), { force: true });
	} else {
		fs.rmSync(path.join(tempDir, 'Pest.php'), { force: true });
	}
}

/** Capture the argv the legacy route hands to bunSpawn. */
async function captureLegacyArgv(
	framework: string,
	scope: 'all' | 'changed',
	files: string[],
): Promise<string[]> {
	let captured: string[] = [];
	runnerInternals.bunSpawn = ((argv: string[]) => {
		captured = argv;
		return {
			stdout: emptyStream(),
			stderr: emptyStream(),
			exited: Promise.resolve(0),
			exitCode: 0,
			kill: () => {},
			killTree: async () => {},
		};
	}) as unknown as typeof runnerInternals.bunSpawn;
	try {
		await runTests(
			framework as Parameters<typeof runTests>[0],
			scope,
			files,
			false,
			5000,
			tempDir,
			false,
		);
	} finally {
		runnerInternals.bunSpawn = realBunSpawn;
	}
	return captured;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('php-vendor-bin-3050-');
	// A temp path carrying a cmd.exe metacharacter (e.g. a Windows username
	// containing '%' or '!') would make the resolver decline, silently turning
	// the strict launcher assertions into fallback assertions. Fail loudly
	// instead of passing for the wrong reason.
	if (WINDOWS_CMD_UNSAFE_TOKEN.test(tempDir)) {
		throw new Error(
			`fixture temp path contains a cmd.exe metacharacter: ${tempDir}`,
		);
	}
	cmdExePath = path.join(tempDir, 'cmd.exe');
	fs.writeFileSync(cmdExePath, 'MZ fake command interpreter\r\n');
	writeComposerFixture(tempDir, ['phpunit', 'pest']);
	fs.writeFileSync(path.join(tempDir, 'phpunit.xml'), '<phpunit/>\n');
	fs.writeFileSync(path.join(tempDir, 'Pest.php'), '<?php\n');
});

afterEach(() => {
	runnerInternals.bunSpawn = realBunSpawn;
	process.env.SWARM_LANG_BACKEND = realLangBackend;
	if (realComSpec === undefined) delete process.env.ComSpec;
	else process.env.ComSpec = realComSpec;
	Object.defineProperty(process, 'platform', { value: realPlatform });
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('#3050: win32 Composer wrappers route through the contained launcher', () => {
	for (const framework of ['phpunit', 'pest'] as const) {
		test(`${framework}: the launcher is emitted, never a bare .bat`, async () => {
			fakeWin32();
			const expectedWrapper = fs.realpathSync(
				path.join(tempDir, 'vendor', 'bin', `${framework}.bat`),
			);
			const expectedInterpreter = fs.realpathSync(cmdExePath);

			// Route 1: the default dispatch builder.
			const dispatch = defaultBuildTestCommand(
				phpProfile!,
				framework,
				['tests/Unit/FooTest.php'],
				tempDir,
				{ scope: 'changed' },
			);
			// Route 2: the test-runner's legacy switch (exported via runTests).
			process.env.SWARM_LANG_BACKEND = 'legacy';
			const legacy = await captureLegacyArgv(framework, 'changed', [
				'tests/Unit/FooTest.php',
			]);
			process.env.SWARM_LANG_BACKEND = realLangBackend;

			for (const [label, argv] of [
				['defaultBuildTestCommand', dispatch],
				['legacy runTests', legacy],
			] as const) {
				expect(argv.length, label).toBe(6);
				expect(argv[0], `${label} argv[0]`).toBe(expectedInterpreter);
				expect(argv.slice(1, 5), `${label} tail`).toEqual([
					'/d',
					'/s',
					'/v:off',
					'/c',
				]);
				expect(argv[5], `${label} call line`).toBe(
					`call "${expectedWrapper}" "tests/Unit/FooTest.php"`,
				);
				expect(
					argv.some((token) => token.toLowerCase().endsWith('.bat')),
					`${label} must not expose a bare .bat token`,
				).toBe(false);
			}
		});

		test(`${framework}: selectTestFramework emits the launcher (no file args)`, async () => {
			fakeWin32();
			markOnly(framework);
			const backend = buildPhpBackend();
			const sel = await backend.selectTestFramework?.(tempDir);
			const expectedWrapper = fs.realpathSync(
				path.join(tempDir, 'vendor', 'bin', `${framework}.bat`),
			);

			expect(sel, 'selection').not.toBeNull();
			const argv = sel!.cmd!;
			// This route carries no file arguments, so the call line has no
			// trailing `" <arg>"` token — buildWindowsBatchCommand joins only
			// the tokens it is handed.
			expect(argv.length).toBe(6);
			expect(argv[0]).toBe(fs.realpathSync(cmdExePath));
			expect(argv.slice(1, 5)).toEqual(['/d', '/s', '/v:off', '/c']);
			expect(argv[5]).toBe(`call "${expectedWrapper}"`);
		});
	}
});

describe('#3050: launcher decline falls back to the PHP interpreter', () => {
	test('a trailing-backslash argument bypasses the launcher', () => {
		fakeWin32();
		const argv = defaultBuildTestCommand(
			phpProfile!,
			'phpunit',
			['tests/Unit\\'],
			tempDir,
			{ scope: 'changed' },
		);
		// The launcher quotes every token into one cmd.exe string, so a token
		// ending in a backslash would turn its closing quote into \" and be
		// mangled. Same guard buildGradleTestCommand carries.
		expect(argv).toEqual([
			'php',
			path.join('vendor', 'bin', 'phpunit'),
			'tests/Unit\\',
		]);
	});

	test('an argument carrying a cmd.exe metacharacter bypasses the launcher', () => {
		fakeWin32();
		const argv = defaultBuildTestCommand(
			phpProfile!,
			'pest',
			['tests/A&B/FooTest.php'],
			tempDir,
			{ scope: 'changed' },
		);
		expect(argv).toEqual([
			'php',
			path.join('vendor', 'bin', 'pest'),
			'tests/A&B/FooTest.php',
		]);
	});

	test('a missing .bat shim falls back', () => {
		fakeWin32();
		fs.rmSync(path.join(tempDir, 'vendor', 'bin', 'phpunit.bat'));
		const argv = defaultBuildTestCommand(phpProfile!, 'phpunit', [], tempDir, {
			scope: 'all',
		});
		expect(argv).toEqual(['php', path.join('vendor', 'bin', 'phpunit')]);
	});
});

describe('#3050: the non-win32 path is unchanged', () => {
	for (const framework of ['phpunit', 'pest'] as const) {
		test(`${framework}: every route keeps the exact extensionless proxy`, async () => {
			fakePosix();
			markOnly(framework);

			const dispatch = defaultBuildTestCommand(
				phpProfile!,
				framework,
				['tests/Unit/FooTest.php'],
				tempDir,
				{ scope: 'changed' },
			);
			expect(dispatch).toEqual([
				path.join('vendor', 'bin', framework),
				'tests/Unit/FooTest.php',
			]);

			process.env.SWARM_LANG_BACKEND = 'legacy';
			const legacy = await captureLegacyArgv(framework, 'changed', [
				'tests/Unit/FooTest.php',
			]);
			expect(legacy).toEqual([
				path.join('vendor', 'bin', framework),
				'tests/Unit/FooTest.php',
			]);

			const sel = await buildPhpBackend().selectTestFramework?.(tempDir);
			expect(sel!.cmd).toEqual([path.join('vendor', 'bin', framework)]);
		});
	}
});

describe('#3050: the files gate is preserved on both routes', () => {
	test('scope "all" appends no file arguments', () => {
		fakePosix();
		expect(
			defaultBuildTestCommand(
				phpProfile!,
				'phpunit',
				['tests/Unit/FooTest.php'],
				tempDir,
				{ scope: 'all' },
			),
		).toEqual([path.join('vendor', 'bin', 'phpunit')]);
	});

	test('an empty file list appends nothing on a narrowed scope', () => {
		fakePosix();
		expect(
			defaultBuildTestCommand(phpProfile!, 'pest', [], tempDir, {
				scope: 'changed',
			}),
		).toEqual([path.join('vendor', 'bin', 'pest')]);
	});

	test('the legacy route keeps the same gate', async () => {
		fakePosix();
		process.env.SWARM_LANG_BACKEND = 'legacy';
		expect(
			await captureLegacyArgv('phpunit', 'all', ['tests/Unit/FooTest.php']),
		).toEqual([path.join('vendor', 'bin', 'phpunit')]);
	});
});
