import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const script = path.resolve(
	'.opencode/skills/issue-tracer/scripts/check-published-argv.sh',
);

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	return result.stdout.toString().trim();
}

function check(cwd: string, file: string): number {
	const result = Bun.spawnSync({
		cmd: bashCommand(file),
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	expect(result.signalCode == null).toBe(true);
	expect(result.exitedDueToTimeout).not.toBe(true);
	return result.exitCode;
}

test('published argv parity — identifies proven false-green but not an unchanged discriminating driver (#3621 AC3)', () => {
	const root = canonicalMkdtemp('published-argv-witness-');
	try {
		const repo = path.join(root, 'repo');
		fs.mkdirSync(repo);
		git(repo, 'init', '-q', '-b', 'main');
		git(repo, 'config', 'user.email', 'trace@example.invalid');
		git(repo, 'config', 'user.name', 'Trace');
		fs.writeFileSync(path.join(repo, 'feature.txt'), 'broken\n');
		fs.writeFileSync(path.join(repo, 'published-pass.sh'), 'exit 0\n');
		const behavior = 'grep -qx fixed feature.txt\n';
		fs.writeFileSync(path.join(repo, 'published-discriminates.sh'), behavior);
		fs.writeFileSync(path.join(repo, 'trace.sh'), behavior);
		git(
			repo,
			'add',
			'--',
			'feature.txt',
			'published-pass.sh',
			'published-discriminates.sh',
			'trace.sh',
		);
		git(repo, 'commit', '-qm', 'base');
		const base = git(repo, 'rev-parse', 'HEAD');
		const basePass = check(repo, 'published-pass.sh');
		const baseDiscriminates = check(repo, 'published-discriminates.sh');
		const baseTrace = check(repo, 'trace.sh');
		fs.writeFileSync(path.join(repo, 'feature.txt'), 'fixed\n');
		git(repo, 'commit', '-qam', 'fix');
		const head = git(repo, 'rev-parse', 'HEAD');
		const headPass = check(repo, 'published-pass.sh');
		const headDiscriminates = check(repo, 'published-discriminates.sh');
		const headTrace = check(repo, 'trace.sh');
		expect(git(repo, 'diff', '--name-only', base, head)).toBe('feature.txt');
		expect([basePass, headPass]).toEqual([0, 0]);
		expect([baseDiscriminates, headDiscriminates]).toEqual([1, 0]);
		expect([baseTrace, headTrace]).toEqual([1, 0]);

		const issue = path.join(root, 'issue.md');
		const reproduction = path.join(root, '02-reproduction.md');
		const replay = path.join(root, 'published-replay.tsv');
		fs.writeFileSync(
			issue,
			'## Acceptance criteria\n- [ ] AC1: First behavior.\n  - class: DISCRIMINATING\n  - argv: bash published-pass.sh\n- [ ] AC2: Second behavior.\n  - class: DISCRIMINATING\n  - argv: bash published-discriminates.sh\n',
		);
		fs.writeFileSync(
			reproduction,
			'## Acceptance checks\n| AC | class | check | argv | expect | pre-fix | post-fix | notes |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| AC1 | DISCRIMINATING | C1 | bash trace.sh | broken | RED | GREEN | evidence |\n| AC2 | DISCRIMINATING | C2 | bash trace.sh | broken | RED | GREEN | evidence |\n',
		);
		fs.writeFileSync(
			replay,
			[
				'ac_id\targv\tbase_sha\tbase_exit\thead_sha\thead_exit',
				`AC1\tbash published-pass.sh\t${base}\t${basePass}\t${head}\t${headPass}`,
				`AC2\tbash published-discriminates.sh\t${base}\t${baseDiscriminates}\t${head}\t${headDiscriminates}`,
				'',
			].join('\n'),
		);
		const result = Bun.spawnSync({
			cmd: bashCommand(
				script,
				'--reproduction',
				reproduction,
				'--published-issue-body',
				issue,
				'--published-replay',
				replay,
			),
			cwd: repo,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 10_000,
		});
		const output = `${result.stdout}\n${result.stderr}`;
		expect(result.exitCode, output).toBe(1);
		const lines = output.split(/\r?\n/);
		expect(
			lines.some(
				(line) => /\bAC1\b/.test(line) && /green at both ends/i.test(line),
			),
			output,
		).toBe(true);
		expect(
			lines.some(
				(line) => /\bAC2\b/.test(line) && /green at both ends/i.test(line),
			),
			output,
		).toBe(false);
	} finally {
		safeRmRecursive(root);
	}
}, 30_000);
