/**
 * Issue #2094 — regression coverage for the TypeScript-owned tmpdir gate.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	evaluateTmpdirAddedLines,
	parseUnifiedZeroAddedLines,
	main as runDirectMain,
} from '../../../scripts/check-test-tmpdir';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TS_GATE = path.resolve(process.cwd(), 'scripts', 'check-test-tmpdir.ts');
const SH_SHIM = path.resolve(process.cwd(), 'scripts', 'check-test-tmpdir.sh');
const tempRoots: string[] = [];
const RAW_TMPDIR_CALL = ['tmpdir', '()'].join('');
const PROJECT_TMP_ASSIGNMENT = ["const baseDir = '", "tmp';"].join('');

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
	const repoDir = canonicalMkdtemp('tmpdir-gate-2094-');
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

describe('check-test-tmpdir — pure decision coverage', () => {
	test('parses unified=0 diff hunk line numbers correctly', () => {
		const added = parseUnifiedZeroAddedLines(
			[
				'diff --git a/tests/fixture.test.ts b/tests/fixture.test.ts',
				'+++ b/tests/fixture.test.ts',
				'@@ -0,0 +3,2 @@',
				`+const tmp = ${RAW_TMPDIR_CALL};`,
				`+${PROJECT_TMP_ASSIGNMENT}`,
			].join('\n'),
		);
		expect(added).toEqual([
			{
				file: 'tests/fixture.test.ts',
				line: 3,
				content: `const tmp = ${RAW_TMPDIR_CALL};`,
			},
			{
				file: 'tests/fixture.test.ts',
				line: 4,
				content: PROJECT_TMP_ASSIGNMENT,
			},
		]);
	});

	test('flags raw tmpdir and project-relative temp roots independently', () => {
		const result = evaluateTmpdirAddedLines([
			{
				file: 'tests/fixture.test.ts',
				line: 7,
				content: `const tmp = ${RAW_TMPDIR_CALL};`,
			},
			{
				file: 'tests/fixture.test.ts',
				line: 8,
				content: PROJECT_TMP_ASSIGNMENT,
			},
		]);
		expect(result.violations).toBe(2);
		expect(result.messages.join('\n')).toContain(
			`raw ${RAW_TMPDIR_CALL} call not wrapped in realpathSync`,
		);
		expect(result.messages.join('\n')).toContain(
			'adds a project-relative test temp root',
		);
	});

	test('allows canonicalized tmpdir usage on the same line', () => {
		const result = evaluateTmpdirAddedLines([
			{
				file: 'tests/fixture.test.ts',
				line: 4,
				content: `const tmp = fs.realpathSync(${RAW_TMPDIR_CALL});`,
			},
		]);
		expect(result.violations).toBe(0);
	});
});

describe('check-test-tmpdir — end to end', () => {
	test(`new raw ${RAW_TMPDIR_CALL} usage is blocking`, () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { tmpdir } from 'node:os';",
				`const tmp = ${RAW_TMPDIR_CALL};`,
			].join('\n'),
		);
		commit(repo, 'add tmpdir violation');

		const result = runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain(
			`raw ${RAW_TMPDIR_CALL} call not wrapped in realpathSync`,
		);
	});

	test('canonicalized tmpdir usage passes', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import * as fs from 'node:fs';",
				"import { tmpdir } from 'node:os';",
				`const tmp = fs.realpathSync(${RAW_TMPDIR_CALL});`,
			].join('\n'),
		);
		commit(repo, 'add canonical tmpdir use');

		const result = runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'All new/changed test temp roots are external and canonicalized.',
		);
	});

	test('repo-root resolution and shell shim stay aligned', async () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { tmpdir } from 'node:os';",
				`const tmp = ${RAW_TMPDIR_CALL};`,
			].join('\n'),
		);
		write(repo, 'src/nested/keep.ts', 'export const keep = 1;\n');
		commit(repo, 'add tmpdir violation');

		const fromRoot = runScript(repo);
		const fromSubdir = runScript(path.join(repo, 'src', 'nested'));
		const shim = runShim(repo);
		expect(fromSubdir.stdout).toBe(fromRoot.stdout);
		expect(fromSubdir.exitCode).toBe(fromRoot.exitCode);
		expect(shim.stdout).toBe(fromRoot.stdout);
		expect(shim.exitCode).toBe(fromRoot.exitCode);
		expect(await runDirectMain(repo)).toBe(fromRoot.exitCode);
	});

	test('the shim carries no tmpdir policy logic', () => {
		const shimSource = fs.readFileSync(SH_SHIM, 'utf-8');
		const body = shimSource
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		expect(body).not.toContain(RAW_TMPDIR_CALL);
		expect(body).not.toContain('canonicalMkdtemp');
		expect(body).toContain('check-test-tmpdir.ts');
	});
});
