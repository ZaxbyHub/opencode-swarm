/**
 * Epic v2 C3 — the committed landing with an explicit message
 * (`DirtyMergeOptions.landingCommitMessage` → `mergeLaneBranch`):
 *   - with a message the lane lands as a `--no-ff` merge commit carrying it,
 *     non-interactively — a protocol commit: `--no-edit`, `--no-verify`
 *     (repository commit hooks, even rejecting ones, are skipped; they run
 *     when the user commits the epic's squash at close), commit signing
 *     disabled (a configured-but-broken signing program is never invoked),
 *     stdin closed (MINOR 8, review E4);
 *   - a landing that conflicts is a landing failure, rolled back
 *     (`git merge --abort`) to the pre-merge state;
 *   - without a message the argv is byte-identical to the plain landing
 *     (`git merge --no-edit <branch>`), for the default and for Lean's
 *     `commitLanding: true`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	attemptMergeBackFromDirty,
	mergeLaneBranch,
} from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const MESSAGE = 'swarm(task 1.1): land it\n\nSwarm-Plan: 0123456789abcdef';
const realBunSpawn = _internals.bunSpawn;
let dir: string;

function git(args: string[], cwd = dir): string {
	const r = spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_DEVICE },
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
	return r.stdout;
}

function hook(name: string, body: string): void {
	const file = path.join(dir, '.git', 'hooks', name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	fs.chmodSync(file, 0o755);
}

function makeLane(): void {
	git(['checkout', '-q', '-b', 'lane']);
	fs.writeFileSync(path.join(dir, 'lane.txt'), 'lane\n');
	git(['add', 'lane.txt']);
	git(['commit', '-q', '-m', 'lane work']);
	git(['checkout', '-q', '-']);
}

beforeEach(() => {
	dir = canonicalMkdtemp('merge-epic-landing-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.com']);
	git(['config', 'user.name', 'Test User']);
	fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
	git(['add', '.']);
	git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed']);
	makeLane();
});

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('mergeLaneBranch with an Epic landing message', () => {
	// Hook scripts need a POSIX shell; Git for Windows ships one, but the
	// executable-bit semantics differ, so the hook cases run on POSIX only.
	test.skipIf(process.platform === 'win32')(
		'lands a --no-ff merge commit with the message; hooks are skipped; signing is never attempted',
		async () => {
			const head = git(['rev-parse', 'HEAD']).trim();
			// Signing configured with a program that would fail (and could
			// prompt): the landing must not invoke it.
			git(['config', 'commit.gpgsign', 'true']);
			git(['config', 'gpg.program', path.join(dir, 'no-such-gpg')]);
			const ran = path.join(dir, 'hook-ran');
			// commitlint-style hooks that would reject a `swarm(` subject.
			hook('commit-msg', `touch "${ran}"\nexit 1`);
			hook('pre-merge-commit', `touch "${ran}"\nexit 1`);
			const result = await mergeLaneBranch(dir, 'lane', 'merge', MESSAGE);
			expect(result).toMatchObject({ merged: true });
			expect(fs.existsSync(ran)).toBe(false);
			expect(
				git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' '),
			).toHaveLength(3);
			expect(git(['rev-parse', 'HEAD^1']).trim()).toBe(head);
			expect(git(['log', '-1', '--format=%B'])).toStartWith(MESSAGE);
			expect(git(['log', '-1', '--format=%G?']).trim()).toBe('N');
		},
	);

	test('a conflicting landing fails and is rolled back to the pre-merge state', async () => {
		fs.writeFileSync(path.join(dir, 'lane.txt'), 'main side\n');
		git(['add', 'lane.txt']);
		git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'main side']);
		const head = git(['rev-parse', 'HEAD']).trim();
		const result = await mergeLaneBranch(dir, 'lane', 'merge', MESSAGE);
		expect('merged' in result).toBe(false);
		expect(git(['rev-parse', 'HEAD']).trim()).toBe(head);
		expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
		expect(git(['status', '--porcelain']).trim()).toBe('');
	});

	test('without a message the argv is the plain landing (default and Lean commitLanding)', async () => {
		const seen: string[][] = [];
		_internals.bunSpawn = ((cmd: string[], opts: never) => {
			seen.push(cmd.slice(1));
			return realBunSpawn(cmd, opts);
		}) as typeof realBunSpawn;
		await mergeLaneBranch(dir, 'lane', 'merge');
		expect(seen.filter((argv) => argv.includes('merge'))).toEqual([
			['merge', '--no-edit', 'lane'],
		]);
		git(['reset', '-q', '--hard', 'HEAD~1']);
		seen.length = 0;
		// Lean: commitLanding without a message — the message option is the
		// only thing that changes the landing argv.
		const lanePath = path.join(dir, '..', `${path.basename(dir)}-wt`);
		git(['worktree', 'add', '-q', '-b', 'lane2', lanePath, 'HEAD']);
		fs.writeFileSync(path.join(lanePath, 'two.txt'), 'two\n');
		try {
			const merged = await attemptMergeBackFromDirty(
				lanePath,
				'lane2',
				dir,
				'merge',
				{ commitLanding: true },
			);
			expect(merged).toMatchObject({ merged: true, strategy: 'merge' });
			expect(
				seen.filter((argv) => argv[0] === 'merge' || argv[2] === 'merge'),
			).toEqual([['merge', '--no-edit', 'lane2']]);
		} finally {
			git(['worktree', 'remove', '--force', lanePath]);
		}
	});
});
