import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Test suite for scripts/check-invariants.sh
 *
 * Tests both real-repo behavior and controlled fixture scenarios for:
 * 1. Subprocess timeout required (advisory)
 * 2. process.cwd() ban in tools/hooks
 * 3. mock.module allowlist
 */

const isWindows = process.platform === 'win32';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'check-invariants.sh');
const LIB_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'lib',
	'normalize-mock-target.sh',
);
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'scripts', 'mock-allowlist.txt');

/**
 * Helper to run check-invariants.sh from a given directory.
 * Skips on Windows where bash.exe is the WSL stub.
 */
function runCheckInvariants(cwd: string): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	if (isWindows) {
		throw new Error('bash not available on Windows');
	}
	const localScript = path.join(cwd, 'scripts', 'check-invariants.sh');
	const scriptPath = fs.existsSync(localScript) ? localScript : SCRIPT_PATH;
	const result = spawnSync('bash', [scriptPath], {
		cwd,
		encoding: 'utf-8',
		stdio: ['pipe', 'pipe', 'pipe'],
		timeout: 30000,
	});

	return {
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Set up a temp fixture dir with a copy of the scripts and controlled src/tests
 */
function setupFixtureDir(fixtureName: string): string {
	// Wrap os.tmpdir() in realpathSync so the canonical path matches what
	// production code compares against. On macOS, os.tmpdir() returns
	// /var/folders/... (symlinked to /private/var/folders/...); without
	// realpath, the fixture cwd would mismatch containment guards. Issue #1729.
	const fixtureDir = path.join(
		fs.realpathSync(os.tmpdir()),
		`check-invariants-${fixtureName}-${Date.now()}`,
	);
	fs.mkdirSync(path.join(fixtureDir, 'scripts', 'lib'), { recursive: true });
	fs.mkdirSync(path.join(fixtureDir, 'src', 'tools'), { recursive: true });
	fs.mkdirSync(path.join(fixtureDir, 'src', 'hooks'), { recursive: true });
	fs.mkdirSync(path.join(fixtureDir, 'tests'), { recursive: true });

	fs.copyFileSync(
		SCRIPT_PATH,
		path.join(fixtureDir, 'scripts', 'check-invariants.sh'),
	);
	fs.copyFileSync(
		LIB_PATH,
		path.join(fixtureDir, 'scripts', 'lib', 'normalize-mock-target.sh'),
	);
	fs.copyFileSync(
		ALLOWLIST_PATH,
		path.join(fixtureDir, 'scripts', 'mock-allowlist.txt'),
	);

	return fixtureDir;
}

describe('check-invariants.sh', () => {
	test('should pass when run on the repo', () => {
		if (isWindows) return;
		const result = runCheckInvariants(REPO_ROOT);
		expect(result.stdout).toContain('All engineering invariant checks passed');
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});

	test('should detect missing mock allowlist file', () => {
		if (isWindows) return;
		const fixtureDir = path.join(
			fs.realpathSync(os.tmpdir()),
			'check-invariants-missing-allowlist-' + Date.now(),
		);
		fs.mkdirSync(path.join(fixtureDir, 'scripts', 'lib'), { recursive: true });
		fs.mkdirSync(path.join(fixtureDir, 'src', 'tools'), { recursive: true });
		fs.mkdirSync(path.join(fixtureDir, 'src', 'hooks'), { recursive: true });
		fs.mkdirSync(path.join(fixtureDir, 'tests'), { recursive: true });

		fs.copyFileSync(
			SCRIPT_PATH,
			path.join(fixtureDir, 'scripts', 'check-invariants.sh'),
		);
		fs.copyFileSync(
			LIB_PATH,
			path.join(fixtureDir, 'scripts', 'lib', 'normalize-mock-target.sh'),
		);
		// Deliberately do NOT copy the allowlist

		const result = runCheckInvariants(fixtureDir);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain(
			'mock-allowlist.txt not found',
		);

		fs.rmSync(fixtureDir, { recursive: true, force: true });
	});

	test('should find process.cwd() violations if they exist', () => {
		if (isWindows) return;
		const result = runCheckInvariants(REPO_ROOT);
		expect(result.stdout).toContain(
			'Check 2: process.cwd() ban in tools/hooks',
		);
	});

	test('should validate mock.module targets against allowlist', () => {
		if (isWindows) return;
		const result = runCheckInvariants(REPO_ROOT);
		expect(result.stdout).toContain('Check 3: mock.module allowlist');
		if (result.exitCode === 0) {
			expect(result.stdout).toContain(
				'All engineering invariant checks passed',
			);
		}
	});

	test('should handle file-level timeout check correctly', () => {
		if (isWindows) return;
		const result = runCheckInvariants(REPO_ROOT);
		expect(result.stdout).toContain('Check 1: Subprocess timeout required');
	});

	// NOTE on the explicit timeouts below: `runCheckInvariants` spawns the real
	// script and already allows it 30s, but bun:test's own per-test default is
	// 5s. On a cold/slow filesystem the script exceeds that, so every test in
	// this file that shells out is timing-sensitive (6 of them already fail this
	// way at b0284ca, before issue #1821 touched anything). The two tests below
	// are the ones #1821 owns, so they carry an explicit budget matching the
	// spawn allowance instead of inheriting the 5s default.
	test('should run all five checks', () => {
		if (isWindows) return;
		const result = runCheckInvariants(REPO_ROOT);
		expect(result.stdout).toContain('Check 1:');
		expect(result.stdout).toContain('Check 2:');
		expect(result.stdout).toContain('Check 3:');
		expect(result.stdout).toContain('Check 4:');
		expect(result.stdout).toContain('Check 5:');
		expect(result.stdout).toContain('Summary');
	}, 30000);

	test('issue #1821: Check 5 knowledge array dedup guardrail reports a clean repo', () => {
		if (isWindows) return;
		const result = runCheckInvariants(REPO_ROOT);
		expect(result.stdout).toContain('Check 5: knowledge array dedup guardrail');
		// The guardrail ships with an EMPTY exempt list by design, so the only
		// honest steady state is zero unguarded positional caps. If this ever
		// reports a non-zero count, a call site regressed to a bare
		// `.slice(0, 20)` instead of `dedupeCapped`.
		expect(result.stdout).toContain('Unguarded positional caps: 0');
	}, 30000);

	test('issue #1666: Check 4 growth ratchet header is present', () => {
		if (isWindows) return;
		const result = runCheckInvariants(REPO_ROOT);
		// The full Check 4 header is emitted whenever the allowlist file
		// exists and a base branch resolves (REPO_ROOT always has origin/main).
		// Deep behavioral coverage of the ratchet lives in the sibling file
		// check-mock-allowlist-ratchet.test.ts (real temp git repo).
		expect(result.stdout).toContain(
			'Check 4: mock.module allowlist growth ratchet',
		);
		expect(result.stdout).toContain('issue #1666');
	});

	test('regression: bun-compat.ts is exempt from timeout warning by basename', () => {
		if (isWindows) return;
		const fixtureDir = setupFixtureDir('bun-compat');

		fs.writeFileSync(
			path.join(fixtureDir, 'src', 'bun-compat.ts'),
			'import { spawnSync } from "node:child_process";\nspawnSync("cmd", []);\n',
		);
		fs.writeFileSync(
			path.join(fixtureDir, 'src', 'not-bun-compat.ts'),
			'import { spawnSync } from "node:child_process";\nspawnSync("cmd", []);\n',
		);

		const result = runCheckInvariants(fixtureDir);
		expect(result.stdout).not.toContain(
			'WARNING: src/bun-compat.ts uses spawn/spawnSync',
		);
		expect(result.stdout).toContain('not-bun-compat.ts');

		fs.rmSync(fixtureDir, { recursive: true, force: true });
	});

	test('regression: LEGACY_EXEMPTS uses exact path match', () => {
		if (isWindows) return;
		const fixtureDir = setupFixtureDir('legacy-exempts');

		fs.writeFileSync(
			path.join(fixtureDir, 'src', 'tools', 'create-tool.ts'),
			'process.cwd();\n',
		);
		fs.writeFileSync(
			path.join(fixtureDir, 'src', 'tools', 'create-tool-helper.ts'),
			'process.cwd();\n',
		);

		const result = runCheckInvariants(fixtureDir);
		expect(result.stdout).not.toContain('src/tools/create-tool.ts');
		expect(result.stdout).toContain('src/tools/create-tool-helper.ts');

		fs.rmSync(fixtureDir, { recursive: true, force: true });
	});
});
