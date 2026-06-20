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
	const result = spawnSync('bash', [SCRIPT_PATH], {
		cwd,
		encoding: 'utf-8',
		stdio: ['pipe', 'pipe', 'pipe'],
		timeout: 30000,
	});

	return {
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		exitCode: result.status || 1,
	};
}

/**
 * Set up a temp fixture dir with a copy of the scripts and controlled src/tests
 */
function setupFixtureDir(fixtureName: string): string {
	const fixtureDir = path.join(
		os.tmpdir(),
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
		expect(result.exitCode).toBe(0);
	});

	test('should detect missing mock allowlist file', () => {
		if (isWindows) return;
		const fixtureDir = path.join(
			os.tmpdir(),
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
		expect(result.stderr).toContain('mock-allowlist.txt not found');

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

	test('should run all three checks', () => {
		if (isWindows) return;
		const result = runCheckInvariants(REPO_ROOT);
		expect(result.stdout).toContain('Check 1:');
		expect(result.stdout).toContain('Check 2:');
		expect(result.stdout).toContain('Check 3:');
		expect(result.stdout).toContain('Summary');
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
		expect(result.stdout).not.toContain('bun-compat.ts');
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
