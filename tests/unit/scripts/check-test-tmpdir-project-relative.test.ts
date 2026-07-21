/** Synthetic bite test for the project-relative temp-root guardrail (#1908). */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	import.meta.dir,
	'../../../scripts/check-test-tmpdir.sh',
);
const tempRoots: string[] = [];

function spawnSync(cmd: string[], cwd: string): Bun.SyncSubprocess {
	return Bun.spawnSync(cmd, {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
}

function git(cwd: string, ...args: string[]): void {
	const proc = spawnSync(['git', ...args], cwd);
	if (proc.exitCode !== 0) {
		throw new Error(proc.stderr.toString());
	}
}

function commit(cwd: string, message: string): void {
	git(cwd, 'add', '-A');
	git(cwd, 'commit', '-q', '-m', message);
}

function makeRepo(): string {
	const cwd = canonicalMkdtemp('tmpdir-guard-1908-');
	tempRoots.push(cwd);
	git(cwd, 'init', '-q', '-b', 'main');
	git(cwd, 'config', 'user.email', 'test@example.com');
	git(cwd, 'config', 'user.name', 'Test');
	fs.writeFileSync(path.join(cwd, 'README.md'), 'base\n');
	commit(cwd, 'base');
	git(cwd, 'branch', 'origin/main');
	return cwd;
}

function writeTest(cwd: string, body: string): void {
	const file = path.join(cwd, 'tests', 'fixture.test.ts');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	commit(cwd, 'fixture');
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
});

describe('check-test-tmpdir project-relative guardrail', () => {
	test('rejects the original baseDir tmp pattern and accepts canonicalMkdtemp', () => {
		const badRepo = makeRepo();
		writeTest(
			badRepo,
			[
				'const base',
				"Dir = 't",
				"mp';\n",
				'Bun.write(base',
				"Dir + '/fixture', 'x');\n",
			].join(''),
		);
		const rejected = spawnSync(bashCommand(SCRIPT), badRepo);
		expect(rejected.exitCode).toBe(1);
		expect(rejected.stdout.toString()).toContain(
			'adds a project-relative test temp root',
		);

		const goodRepo = makeRepo();
		writeTest(
			goodRepo,
			"import { canonicalMkdtemp } from '../helpers/tmpdir';\ncanonicalMkdtemp('fixture-');\n",
		);
		const accepted = spawnSync(bashCommand(SCRIPT), goodRepo);
		expect(accepted.exitCode).toBe(0);
		expect(accepted.stdout.toString()).toContain(
			'All new/changed test temp roots are external and canonicalized',
		);
	});
});
