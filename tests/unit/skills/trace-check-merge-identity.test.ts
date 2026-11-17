import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const script = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/trace-check.sh',
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
		timeout: 10_000,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

test('merged trace binds the reviewed patch to the squash parent and detects divergence', () => {
	const root = canonicalMkdtemp('merge-identity-3576-');
	roots.push(root);
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.email', 'trace@example.invalid');
	git(root, 'config', 'user.name', 'Trace fixture');

	function commit(file: string, contents: string, title: string) {
		fs.writeFileSync(path.join(root, file), contents);
		git(root, 'add', '--', file);
		git(root, 'commit', '-qm', title);
		return git(root, 'rev-parse', 'HEAD');
	}

	const base = commit('subject.txt', 'old\n', 'base');
	git(root, 'switch', '-qc', 'reviewed');
	commit('subject.txt', 'intermediate\n', 'first reviewed commit');
	const head = commit('subject.txt', 'new\n', 'last reviewed commit');
	git(root, 'switch', '-q', 'main');
	const squashParent = commit(
		'upstream.txt',
		'unrelated\n',
		'upstream advances',
	);
	const squash = commit('subject.txt', 'new\n', 'equivalent squash');
	git(
		root,
		'remote',
		'add',
		'origin',
		'https://github.com/example/fixture.git',
	);
	git(root, 'switch', '-qc', 'divergent', squashParent);
	const wrongSquash = commit('subject.txt', 'different\n', 'different squash');

	const slug = 'issue-3576';
	const trace = path.join(root, '.agents', 'issue-traces', slug);
	fs.mkdirSync(trace, { recursive: true });
	const baseTree = git(root, 'rev-parse', `${base}^{tree}`);
	const headTree = git(root, 'rev-parse', `${head}^{tree}`);
	fs.writeFileSync(
		path.join(trace, 'state.md'),
		[
			`# Trace State: ${slug}`,
			'protocol: 3.0.0',
			'phase: closed',
			'tier: S',
			'classification: VALID',
			'base-ref: main',
			`base-sha: ${base}`,
			'freshness: synced',
			`phase0-tree-id: ${baseTree}`,
			`checkpoint-tree-id: ${baseTree}`,
			'handshake: ABSENT',
			'tools: none',
			'merge: MERGED',
			'next-action: none',
			'',
			'## Gates',
			'| gate | verdict | reviewed-commit | tree-id | artifact |',
			'|---|---|---|---|---|',
			`| merge-approval | RECORDED | ${head} | ${headTree} | 10b-merge-approval.md |`,
			'',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(trace, '10-pr-body.md'),
		[
			`PR head: ${head}`,
			'PR URL: https://github.com/example/fixture/pull/42',
			'## Acceptance Criteria -> Evidence',
			'fixture',
			'## Waivers (or none)',
			'none',
			'',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(root, 'gh'),
		'#!/usr/bin/env bash\n' +
			'[[ "$2" = repos/example/fixture/pulls/42 && "$4" = *merge_commit_sha* && "$4" = *classification* ]] || exit 9\n' +
			`printf '%s\\n' true '${head}' '${squash}' no\n`,
		{ mode: 0o755 },
	);

	function validate(mergeCommit: string) {
		fs.writeFileSync(
			path.join(trace, '10b-merge-approval.md'),
			[
				'## User approval (verbatim)',
				'fixture approval',
				'',
				'## PR head SHA',
				head,
				'',
				'## Final critic reviewed-commit',
				head,
				'',
				'## Merge commit SHA',
				mergeCommit,
				'',
			].join('\n'),
		);
		const result = Bun.spawnSync({
			cmd: [
				bashCommand(script)[0],
				'-c',
				'export PATH="$PWD:/usr/bin:/bin:$PATH"; [ "$(command -v gh)" = "$PWD/gh" ] || exit 19; exec bash "$@"',
				'bash',
				script,
				'merge',
				'--slug',
				slug,
			],
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 15_000,
		});
		return {
			code: result.exitCode,
			output: result.stdout.toString() + result.stderr.toString(),
		};
	}

	const matching = validate(squash);
	expect(matching.code, matching.output).toBe(0);
	expect(matching.output).toContain(base);
	expect(matching.output).toContain(head);
	expect(matching.output).toContain(squashParent);
	expect(matching.output).toMatch(
		/(?:patch[- ]id.*(?:equivalent|match|equal)|OK[^\n]*patch[- ]id)/i,
	);

	const divergent = validate(wrongSquash);
	expect(divergent.code, divergent.output).not.toBe(0);
	expect(divergent.output).toMatch(
		/(?:patch[- ]id.*(?:differ|mismatch|not equivalent)|FAIL[^\n]*patch[- ]id)/i,
	);
}, 30_000);
