import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const script = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/repro-check.sh',
);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) safeRmRecursive(root);
});

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 5_000,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

test('compares the fetched receipt bytes and reports a divergent digest', () => {
	const root = canonicalMkdtemp('published-anchor-3576-');
	roots.push(root);
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.email', 'trace@example.invalid');
	git(root, 'config', 'user.name', 'Trace fixture');
	fs.writeFileSync(
		path.join(root, 'check.sh'),
		'#!/usr/bin/env bash\nexit 1\n',
	);
	git(root, 'add', '--', 'check.sh');
	git(root, 'commit', '-qm', 'base');

	const slug = 'issue-3576';
	const trace = path.join(root, '.agents', 'issue-traces', slug);
	const shimDir = path.join(root, 'fake-bin');
	const launcher = path.join(root, 'launch-fixture.sh');
	fs.mkdirSync(shimDir);
	fs.writeFileSync(
		launcher,
		'#!/usr/bin/env bash\nexport PATH="./fake-bin:$PATH"\nexec bash "$@"\n',
	);
	const gh = path.join(shimDir, 'gh');
	fs.writeFileSync(
		gh,
		[
			'#!/usr/bin/env bash',
			'set -eu',
			'test "$#" -eq 4',
			'test "$1" = api',
			'test "$2" = repos/example/project/issues/comments/12345',
			'test "$3" = --jq',
			'test "$4" = .body',
			'printf "called\\n" >> fixture-gh.calls',
			'cat fixture-comment.md',
			'',
		].join('\n'),
	);
	fs.chmodSync(gh, 0o755);

	function run(...args: string[]) {
		const result = Bun.spawnSync({
			cmd: bashCommand(launcher, script, ...args),
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 15_000,
		});
		return {
			code: result.exitCode,
			stdout: result.stdout.toString(),
			diagnostic: result.stdout.toString() + result.stderr.toString(),
		};
	}

	const checkpoint = run(
		'checkpoint',
		'--slug',
		slug,
		'--id',
		'C1',
		'--argv',
		'bash check.sh',
		'--expect',
		'-',
		'--base',
		git(root, 'rev-parse', 'HEAD'),
		'check.sh',
	);
	expect(checkpoint.code, checkpoint.diagnostic).toBe(0);
	fs.writeFileSync(
		path.join(trace, 'state.md'),
		[
			`# Trace State: ${slug}`,
			'protocol: 3.0.0',
			`checkpoint-tree-id: ${git(root, 'rev-parse', 'HEAD^{tree}')}`,
			'',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(trace, '02-reproduction.md'),
		[
			'## Acceptance checks',
			'| AC | class | check | argv | expect | pre-fix | post-fix | notes |',
			'|---|---|---|---|---|---|---|---|',
			'| AC1 | DISCRIMINATING | C1 | bash check.sh | - | RED | GREEN | fixture |',
			'',
		].join('\n'),
	);

	const anchor = run('anchor', '--slug', slug);
	expect(anchor.code, anchor.diagnostic).toBe(0);
	const receipt = anchor.stdout.trim();
	const manifest = /\bmanifest=([0-9a-f]{40})\b/.exec(receipt)?.[1];
	if (!manifest) throw new Error(`Missing manifest digest: ${receipt}`);
	const wrongManifest = (manifest[0] === '0' ? '1' : '0') + manifest.slice(1);
	const changedReceipt = receipt.replace(manifest, wrongManifest);
	const comment = path.join(root, 'fixture-comment.md');
	const calls = path.join(root, 'fixture-gh.calls');
	const args = [
		'verify-anchor',
		'--slug',
		slug,
		'--receipt',
		receipt,
		'--published',
		'https://github.com/example/project/issues/3576#issuecomment-12345',
	];

	fs.writeFileSync(comment, `${receipt}\n`);
	const matching = run(...args);
	expect(matching.code, matching.diagnostic).toBe(0);
	expect(fs.readFileSync(calls, 'utf8')).toBe('called\n');

	fs.writeFileSync(comment, `${changedReceipt}\n`);
	const mismatch = run(...args);
	expect(mismatch.code, mismatch.diagnostic).not.toBe(0);
	expect(mismatch.diagnostic).toContain(manifest);
	expect(mismatch.diagnostic).toContain(wrongManifest);
	expect(fs.readFileSync(calls, 'utf8')).toBe('called\ncalled\n');
}, 30_000);
