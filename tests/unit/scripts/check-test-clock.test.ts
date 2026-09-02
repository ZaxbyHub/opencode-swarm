/**
 * Issue #2094 — regression coverage for the TypeScript-owned test-clock gate.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	diffAddsRawClockLine,
	evaluateClockFile,
	fileHasClockHelper,
	parseAddedLines,
	main as runDirectMain,
} from '../../../scripts/check-test-clock';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TS_GATE = path.resolve(process.cwd(), 'scripts', 'check-test-clock.ts');
const SH_SHIM = path.resolve(process.cwd(), 'scripts', 'check-test-clock.sh');
const tempRoots: string[] = [];

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function spawn(cmd: string[], cwd: string): SpawnResult {
	const proc = Bun.spawnSync({
		cmd,
		cwd,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function runScript(repoDir: string): SpawnResult {
	return spawn([process.execPath, 'run', TS_GATE], repoDir);
}

function runShim(repoDir: string): SpawnResult {
	return spawn(bashCommand(SH_SHIM), repoDir);
}

function git(repoDir: string, ...args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd: repoDir,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	if (proc.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed in ${repoDir}: ${proc.stderr.toString()}`,
		);
	}
}

function write(repoDir: string, relPath: string, content: string): void {
	const full = path.join(repoDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

function commit(repoDir: string, message: string): void {
	git(repoDir, 'add', '-A');
	git(repoDir, 'commit', '-q', '-m', message);
}

function makeRepo(): string {
	const repoDir = canonicalMkdtemp('clock-gate-2094-');
	git(repoDir, 'init', '-q', '-b', 'main');
	git(repoDir, 'config', 'user.email', 'test@example.com');
	git(repoDir, 'config', 'user.name', 'Test');
	write(repoDir, 'README.md', 'base\n');
	commit(repoDir, 'init');
	git(repoDir, 'branch', 'origin/main');
	tempRoots.push(repoDir);
	return repoDir;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
});

describe('check-test-clock — pure decision coverage', () => {
	test('helper detection requires import or call, not a bare comment mention', () => {
		expect(fileHasClockHelper('// TODO: use freezeClock someday\n')).toBe(
			false,
		);
		expect(
			fileHasClockHelper(
				"import { withFrozenClock } from '../../helpers/test-clock.js';\n",
			),
		).toBe(true);
		expect(fileHasClockHelper('withFrozenClock(() => {});\n')).toBe(true);
	});

	test('added-line parsing ignores headers and finds new raw clock lines', () => {
		const addedLines = parseAddedLines(
			[
				'diff --git a/tests/fixture.test.ts b/tests/fixture.test.ts',
				'+++ b/tests/fixture.test.ts',
				'@@ -0,0 +1,2 @@',
				'+const now = Date.now();',
				'+const fixed = new Date("2024-01-01");',
			].join('\n'),
		);
		expect(addedLines).toEqual([
			'const now = Date.now();',
			'const fixed = new Date("2024-01-01");',
		]);
		expect(diffAddsRawClockLine(addedLines)).toBe(true);
	});

	test('evaluateClockFile blocks only when a diff adds raw clock usage without helper coverage', () => {
		const blocking = evaluateClockFile({
			file: 'tests/fixture.test.ts',
			content: 'const now = Date.now();\n',
			inDiff: true,
			addedLines: ['const now = Date.now();'],
		});
		expect(blocking.blockingViolations.join('\n')).toContain(
			'does not import or call the freezeClock helper',
		);

		const preExisting = evaluateClockFile({
			file: 'tests/fixture.test.ts',
			content: 'const now = Date.now();\n',
			inDiff: true,
			addedLines: ['const value = 1;'],
		});
		expect(preExisting.preExistingViolations).toEqual([
			'tests/fixture.test.ts',
		]);
	});
});

describe('check-test-clock — end to end', () => {
	test('new raw Date.now() usage without helper is blocking', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  Date.now();',
				'});',
			].join('\n'),
		);
		commit(repo, 'add clock violation');

		const result = runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('freezeClock helper');
	});

	test('withFrozenClock call site satisfies the gate', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses frozen time", () => {',
				'  withFrozenClock(() => Date.now());',
				'});',
			].join('\n'),
		);
		commit(repo, 'add frozen clock usage');

		const result = runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('All test-clock checks passed.');
	});

	test('pre-existing raw clock usage touched for unrelated reasons stays non-blocking', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  Date.now();',
				'});',
			].join('\n'),
		);
		commit(repo, 'seed clock violation');
		git(repo, 'branch', '-f', 'origin/main');

		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'// unrelated edit',
				'test("uses real time", () => {',
				'  Date.now();',
				'});',
			].join('\n'),
		);
		commit(repo, 'touch file without new clock line');

		const result = runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'Pre-existing violations (non-blocking warnings): 1',
		);
	});

	test('repo-root resolution and shell shim stay aligned', async () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  Date.now();',
				'});',
			].join('\n'),
		);
		write(repo, 'src/nested/keep.ts', 'export const keep = 1;\n');
		commit(repo, 'add clock violation');

		const fromRoot = runScript(repo);
		const fromSubdir = runScript(path.join(repo, 'src', 'nested'));
		const shim = runShim(repo);
		expect(fromSubdir.stdout).toBe(fromRoot.stdout);
		expect(fromSubdir.exitCode).toBe(fromRoot.exitCode);
		expect(shim.stdout).toBe(fromRoot.stdout);
		expect(shim.exitCode).toBe(fromRoot.exitCode);
		expect(await runDirectMain(repo)).toBe(fromRoot.exitCode);
	});

	test('the shim carries no raw-clock policy logic', () => {
		const shimSource = fs.readFileSync(SH_SHIM, 'utf-8');
		const body = shimSource
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		expect(body).not.toContain('Date.now');
		expect(body).not.toContain('freezeClock');
		expect(body).toContain('check-test-clock.ts');
	});
});
