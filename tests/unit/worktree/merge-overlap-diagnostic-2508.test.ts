import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attemptMergeBackFromDirty } from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GIT_TIMEOUT_MS = 10_000;
const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

/** Primary repo + lane worktree whose commit overlaps a dirty primary path. */
function createOverlapFixture(name: string): {
	root: string;
	lanePath: string;
	branch: string;
} {
	const root = canonicalMkdtemp(`2508-overlap-${name}-`);
	tempRoots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
	git(root, 'add', 'a.txt');
	git(root, 'commit', '-m', 'base');

	const lanePath = `${root}-lane`;
	const branch = `swarm/lane/session/${name}`;
	git(root, 'worktree', 'add', '-b', branch, lanePath, 'main');
	fs.writeFileSync(path.join(lanePath, 'a.txt'), 'lane-edit\n');
	git(lanePath, 'add', 'a.txt');
	git(lanePath, 'commit', '-m', 'lane edit');
	return { root, lanePath, branch };
}

describe('#2508 typed overlap diagnostic on settlement merge-back', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			try {
				fs.rmSync(`${root}-lane`, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
			try {
				git(root, 'worktree', 'prune');
			} catch {
				/* best-effort */
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('overlap partial carries SETTLEMENT_OVERLAP_BLOCKED code and an imperative recovery hint', async () => {
		const { root, lanePath, branch } = createOverlapFixture('code');
		// The user's unconsumed work: uncommitted change to the SAME path the
		// lane modified — the exact condition the overlap gate blocks on.
		fs.writeFileSync(path.join(root, 'a.txt'), 'user-edit\n');

		const result = await attemptMergeBackFromDirty(
			lanePath,
			branch,
			root,
			'merge',
		);

		expect(result.partial).toBe(true);
		if (!result.partial) return;
		expect(result.stage).toBe('pre-merge-overlap');
		expect(result.code).toBe('SETTLEMENT_OVERLAP_BLOCKED');
		expect(result.recoveryHint).toBeDefined();
		expect(result.recoveryHint ?? '').toMatch(/^ACTION:/);
		expect(result.recoveryHint ?? '').toMatch(/a\.txt/);
		expect(result.conflictFiles).toContain('a.txt');
	});

	test('overlap block preserves the user bytes and the lane (gate unchanged)', async () => {
		const { root, lanePath, branch } = createOverlapFixture('preserve');
		fs.writeFileSync(path.join(root, 'a.txt'), 'user-edit\n');

		const result = await attemptMergeBackFromDirty(
			lanePath,
			branch,
			root,
			'merge',
		);

		expect(result.partial).toBe(true);
		expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe(
			'user-edit\n',
		);
		// HEAD must not have advanced: the merge never ran.
		expect(git(root, 'log', '--oneline')).not.toMatch(/lane edit/);
		// The lane worktree is preserved for recovery.
		expect(fs.existsSync(lanePath)).toBe(true);
	});

	test('clean settlement does not carry the overlap diagnostic', async () => {
		const { root, lanePath, branch } = createOverlapFixture('clean');
		const result = await attemptMergeBackFromDirty(
			lanePath,
			branch,
			root,
			'merge',
		);
		expect(result.merged).toBe(true);
	});
});
