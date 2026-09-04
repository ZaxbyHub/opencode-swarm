/**
 * Parity tests for trace-init.sh and trace-check.sh.
 * Verifies that tree-id computation matches between the two scripts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TRACE_INIT_SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-init.sh',
);

const TRACE_CHECK_SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
);

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runScript(
	cwd: string,
	args: string[],
	env: Record<string, string | undefined> = process.env,
): SpawnResult {
	const proc = Bun.spawnSync({
		cmd: bashCommand(TRACE_INIT_SCRIPT, ...args),
		cwd,
		env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function runCheckScript(cwd: string, args: string[]): SpawnResult {
	const proc = Bun.spawnSync({
		cmd: bashCommand(TRACE_CHECK_SCRIPT, ...args),
		cwd,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function git(repoDir: string, ...args: string[]): string {
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
	return proc.stdout.toString();
}

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	}
});

function track(dir: string): string {
	tempRoots.push(dir);
	return dir;
}

function makeRepo(prefix: string): string {
	const repoDir = canonicalMkdtemp(prefix);
	git(repoDir, 'init', '-q', '-b', 'main');
	git(repoDir, 'config', 'user.email', 'test@example.com');
	git(repoDir, 'config', 'user.name', 'Test');
	fs.writeFileSync(path.join(repoDir, 'README.md'), 'hi\n');
	git(repoDir, 'add', '-A');
	git(repoDir, 'commit', '-q', '-m', 'init');
	return repoDir;
}

describe('trace-init.sh / trace-check.sh parity', () => {
	test('phase-0 identity drops a tracked path under .agents/issue-traces (parity with trace-check tree-id)', async () => {
		const repo = track(makeRepo('trace-init-parity-'));

		// Create .agents/issue-traces/legacy/old.md and COMMIT it (tracked in HEAD).
		fs.mkdirSync(path.join(repo, '.agents/issue-traces/legacy'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(repo, '.agents/issue-traces/legacy/old.md'),
			'old content\n',
		);
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'add legacy trace');

		// Create untracked non-ignored file src/b.txt.
		fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
		fs.writeFileSync(path.join(repo, 'src/b.txt'), 'untracked\n');

		// Run trace-init.sh
		const initResult = runScript(repo, ['some-slug']);
		expect(initResult.exitCode).toBe(0);

		// Read phase0-tree-id from state.md
		const stateFile = path.join(
			repo,
			'.agents/issue-traces/some-slug/state.md',
		);
		const state = fs.readFileSync(stateFile, 'utf-8');
		const match = state.match(/^phase0-tree-id: ([0-9a-f]{40})$/m);
		expect(match).not.toBeNull();
		const phase0TreeId = match?.[1];
		expect(phase0TreeId).toBeDefined();

		// Run trace-check.sh tree-id
		const checkResult = runCheckScript(repo, ['tree-id']);
		expect(checkResult.exitCode).toBe(0);
		const traceCheckTreeId = checkResult.stdout.toString().trim();

		// Verify both scripts report the same tree-id.
		expect(traceCheckTreeId).toBe(phase0TreeId);

		// Verify neither equals git rev-parse HEAD^{tree} (because src/b.txt is untracked).
		const headTree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
		expect(phase0TreeId).not.toBe(headTree);
		expect(traceCheckTreeId).not.toBe(headTree);
	}, 20_000);
});
