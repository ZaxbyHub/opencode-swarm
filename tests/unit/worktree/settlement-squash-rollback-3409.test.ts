import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	attemptMergeBackFromDirty,
	_internals as mergeInternals,
} from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Regression for the squash-rollback restore (#3409 / PR #3420). When git's own
// rollback of a failed `merge --squash --no-commit` also fails, a TRACKED
// incoming path can be left deleted or holding the lane bytes while its index
// entry is unchanged. The restore must repair exactly those two states from HEAD
// and must report (never overwrite) any other working-tree edit. No test here
// reads the clock, so no clock helper is needed.

const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: 60000,
		maxBuffer: 65536,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, LC_ALL: 'C' },
	}).trim();
}
function put(dir: string, files: Record<string, string>): void {
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	}
}
function read(root: string, rel: string): string {
	return fs.readFileSync(path.join(root, rel), 'utf8');
}
const BASE = { 'a.txt': 'a base\n', 'z.txt': 'z base\n' };
const LANE = { 'a.txt': 'a lane\n', 'z.txt': 'z lane\n' };
/** Real repo: `main` holds BASE, a lane branch commits LANE over both tracked files. */
function fixture() {
	const root = canonicalMkdtemp('settlement-squash-rollback-3409-');
	roots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'tests@example.invalid');
	git(root, 'config', 'user.name', 'Tests');
	git(root, 'config', 'core.autocrlf', 'false');
	put(root, { 'base.txt': 'base\n', ...BASE });
	git(root, 'add', '.');
	git(root, 'commit', '-m', 'base');
	const lane = path.join(root, '.swarm', 'worktrees', 'lane');
	fs.mkdirSync(path.dirname(lane), { recursive: true });
	const branch = 'swarm/lane/rollback-test';
	git(root, 'worktree', 'add', '-b', branch, lane);
	put(lane, LANE);
	git(lane, 'add', '.');
	git(lane, 'commit', '-m', 'lane');
	return { root, lane, branch };
}
const realSpawn = mergeInternals.bunSpawn;
type Spawned = ReturnType<typeof realSpawn>;
afterEach(() => {
	mergeInternals.bunSpawn = realSpawn;
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function fakeProc(exitCode: number, stdout: string, stderr: string): Spawned {
	return {
		stdout: { text: async () => stdout },
		stderr: { text: async () => stderr },
		exited: Promise.resolve(exitCode),
		exitCode,
		kill: () => {},
	} as unknown as Spawned;
}
/** Run `onSquash` when the squash argv is seen; `reply` replaces the real squash. */
function seam(onSquash: () => void, reply?: () => Spawned): void {
	mergeInternals.bunSpawn = (argv, options) => {
		if (argv.includes('merge') && argv.includes('--squash')) {
			onSquash();
			if (reply) return reply();
		}
		return realSpawn(argv, options);
	};
}
const rollbackFailed = () => fakeProc(128, '', 'fatal: read-tree failed');
function porcelain(root: string): string {
	return git(
		root,
		'status',
		'--porcelain',
		'--untracked-files=all',
		'--',
		'.',
		':(exclude).swarm',
	);
}
const INCOMPLETE = 'restore of pre-merge state incomplete';
const KEPT = 'left in place (working tree changed without an index change)';

async function run(f: ReturnType<typeof fixture>) {
	const result = await attemptMergeBackFromDirty(
		f.lane,
		f.branch,
		f.root,
		'merge',
	);
	expect(result).toMatchObject({ failed: true, stage: 'merge' });
	expect(result).not.toHaveProperty('merged');
	return 'message' in result ? result.message : '';
}

describe('squash rollback failure leaves a tracked path recoverable #3409', () => {
	test('a tracked incoming file deleted by the failed rollback is restored from HEAD', async () => {
		const f = fixture();
		const head = git(f.root, 'rev-parse', 'HEAD');
		let squashed = false;
		seam(() => {
			squashed = true;
			fs.unlinkSync(path.join(f.root, 'a.txt'));
		}, rollbackFailed);
		const message = await run(f);
		expect(squashed).toBe(true);
		expect(message).toContain('read-tree failed');
		expect(message).not.toContain(INCOMPLETE);
		expect(read(f.root, 'a.txt')).toBe(BASE['a.txt']);
		expect(read(f.root, 'z.txt')).toBe(BASE['z.txt']);
		expect(porcelain(f.root)).toBe('');
		expect(git(f.root, 'diff', '--cached', '--name-only')).toBe('');
		expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
	});

	test('a tracked incoming file left holding the exact lane bytes is restored from HEAD', async () => {
		const f = fixture();
		let squashed = false;
		seam(() => {
			squashed = true;
			fs.writeFileSync(path.join(f.root, 'a.txt'), LANE['a.txt']);
		}, rollbackFailed);
		const message = await run(f);
		expect(squashed).toBe(true);
		expect(message).toContain('read-tree failed');
		expect(message).not.toContain(INCOMPLETE);
		expect(message).not.toContain(KEPT);
		expect(read(f.root, 'a.txt')).toBe(BASE['a.txt']);
		expect(porcelain(f.root)).toBe('');
	});

	test('both tracked files left half-rolled-back (one deleted, one lane bytes) are restored', async () => {
		const f = fixture();
		seam(() => {
			fs.unlinkSync(path.join(f.root, 'a.txt'));
			fs.writeFileSync(path.join(f.root, 'z.txt'), LANE['z.txt']);
		}, rollbackFailed);
		const message = await run(f);
		expect(message).not.toContain(INCOMPLETE);
		expect(read(f.root, 'a.txt')).toBe(BASE['a.txt']);
		expect(read(f.root, 'z.txt')).toBe(BASE['z.txt']);
		expect(porcelain(f.root)).toBe('');
	});
});

describe('a working-tree edit that is not git rollback debris is kept and reported #3409', () => {
	test('a user edit written after the snapshot to a tracked path survives a real git refusal and is reported', async () => {
		const f = fixture();
		let squashed = false;
		// Real git runs and refuses (local changes would be overwritten); it writes
		// nothing, so the user's bytes are the only change since the snapshot.
		seam(() => {
			squashed = true;
			fs.writeFileSync(path.join(f.root, 'z.txt'), 'user z\n');
		});
		const message = await run(f);
		expect(squashed).toBe(true);
		expect(message).toContain('would be overwritten by merge');
		expect(
			message.endsWith(
				`; ${INCOMPLETE}, partial merge state may remain: not restored: ${KEPT}: z.txt`,
			),
		).toBe(true);
		expect(read(f.root, 'z.txt')).toBe('user z\n');
		expect(read(f.root, 'a.txt')).toBe(BASE['a.txt']);
		expect(porcelain(f.root)).toBe('M z.txt');
		expect(git(f.root, 'diff', '--cached', '--name-only')).toBe('');
	});

	test('a user edit is kept and reported while the rollback debris beside it is still repaired', async () => {
		const f = fixture();
		seam(() => {
			fs.unlinkSync(path.join(f.root, 'a.txt'));
			fs.writeFileSync(path.join(f.root, 'z.txt'), 'user z\n');
		}, rollbackFailed);
		const message = await run(f);
		// Only z.txt is named: a.txt was repaired and must not be reported.
		expect(
			message.endsWith(
				`; ${INCOMPLETE}, partial merge state may remain: not restored: ${KEPT}: z.txt`,
			),
		).toBe(true);
		expect(read(f.root, 'z.txt')).toBe('user z\n');
		expect(read(f.root, 'a.txt')).toBe(BASE['a.txt']);
		expect(porcelain(f.root)).toBe('M z.txt');
	});

	test('a directory that replaced a tracked incoming file is never checked out over', async () => {
		const f = fixture();
		seam(() => {
			fs.unlinkSync(path.join(f.root, 'a.txt'));
			fs.mkdirSync(path.join(f.root, 'a.txt'));
			fs.writeFileSync(path.join(f.root, 'a.txt', 'child'), 'user child\n');
		}, rollbackFailed);
		const message = await run(f);
		expect(message).toContain(`${KEPT}: a.txt`);
		expect(fs.statSync(path.join(f.root, 'a.txt')).isDirectory()).toBe(true);
		expect(read(f.root, 'a.txt/child')).toBe('user child\n');
	});

	test('a user edit that merely resembles the lane file by prefix is not mistaken for the lane blob', async () => {
		const f = fixture();
		seam(() => {
			fs.writeFileSync(path.join(f.root, 'a.txt'), `${LANE['a.txt']}more\n`);
		}, rollbackFailed);
		const message = await run(f);
		expect(message).toContain(`${KEPT}: a.txt`);
		expect(read(f.root, 'a.txt')).toBe(`${LANE['a.txt']}more\n`);
	});
});

const OUTSIDE =
	'working tree outside the incoming paths changed during the failed squash';

/** Commit `name` on main with `text`, so it is tracked and outside the lane's paths. */
function commitOutside(root: string, name: string, text: string): void {
	put(root, { [name]: text });
	git(root, 'add', name);
	git(root, 'commit', '-m', `add ${name}`);
}

describe('unstaged files outside the incoming paths are reported when the failed squash changes them #3409', () => {
	test('an unstaged user-edited outside file rewritten by the failed rollback is reported, not restored', async () => {
		const f = fixture();
		commitOutside(f.root, 'other.txt', 'other base\n');
		fs.writeFileSync(path.join(f.root, 'other.txt'), 'user other edit\n');
		let squashed = false;
		seam(() => {
			squashed = true;
			fs.writeFileSync(
				path.join(f.root, 'other.txt'),
				'rewritten by rollback\n',
			);
		}, rollbackFailed);
		const message = await run(f);
		expect(squashed).toBe(true);
		expect(message).toContain('read-tree failed');
		expect(message).toContain(`${OUTSIDE}: other.txt`);
		// Reported only: neither the user's edit nor HEAD's bytes are put back.
		expect(read(f.root, 'other.txt')).toBe('rewritten by rollback\n');
		expect(read(f.root, 'a.txt')).toBe(BASE['a.txt']);
	});

	test('a clean outside file damaged by the failed rollback is reported and left damaged', async () => {
		const f = fixture();
		commitOutside(f.root, 'clean-out.txt', 'clean base\n');
		expect(git(f.root, 'diff', '--name-only')).toBe('');
		let squashed = false;
		seam(() => {
			squashed = true;
			fs.writeFileSync(path.join(f.root, 'clean-out.txt'), 'damaged\n');
		}, rollbackFailed);
		const message = await run(f);
		expect(squashed).toBe(true);
		expect(message).toContain(`${OUTSIDE}: clean-out.txt`);
		expect(read(f.root, 'clean-out.txt')).toBe('damaged\n');
	});

	test('an unstaged outside file the failed squash never touched is not reported', async () => {
		const f = fixture();
		commitOutside(f.root, 'other.txt', 'other base\n');
		fs.writeFileSync(path.join(f.root, 'other.txt'), 'user other edit\n');
		let squashed = false;
		seam(() => {
			squashed = true;
		}, rollbackFailed);
		const message = await run(f);
		expect(squashed).toBe(true);
		expect(message).toContain('read-tree failed');
		expect(message).not.toContain('changed during the failed squash');
		expect(read(f.root, 'other.txt')).toBe('user other edit\n');
	});

	test('a real git refusal beside an untouched unstaged outside edit reports no outside change', async () => {
		const f = fixture();
		commitOutside(f.root, 'other.txt', 'other base\n');
		fs.writeFileSync(path.join(f.root, 'other.txt'), 'user other edit\n');
		let squashed = false;
		// Real git refuses on z.txt and writes nothing, so other.txt is untouched.
		seam(() => {
			squashed = true;
			fs.writeFileSync(path.join(f.root, 'z.txt'), 'user z\n');
		});
		const message = await run(f);
		expect(squashed).toBe(true);
		expect(message).toContain('would be overwritten by merge');
		expect(message).toContain(`${KEPT}: z.txt`);
		expect(message).not.toContain('changed during the failed squash');
		expect(read(f.root, 'other.txt')).toBe('user other edit\n');
		expect(read(f.root, 'z.txt')).toBe('user z\n');
	});

	test('a staged rename whose source is outside the incoming paths reports the source when the failed rollback recreates it', async () => {
		const f = fixture();
		commitOutside(f.root, 'other.txt', 'other base\n');
		// Staged rename: other.txt leaves the index and disk, renamed.txt appears.
		// With rename detection on, `git diff --name-only HEAD` lists only the
		// destination, so the source was never fingerprinted before the squash.
		git(f.root, 'mv', 'other.txt', 'renamed.txt');
		expect(fs.existsSync(path.join(f.root, 'other.txt'))).toBe(false);
		let squashed = false;
		seam(() => {
			squashed = true;
			// The failed rollback recreates the rename source on disk.
			fs.writeFileSync(
				path.join(f.root, 'other.txt'),
				'rewritten by rollback\n',
			);
		}, rollbackFailed);
		const message = await run(f);
		expect(squashed).toBe(true);
		expect(message).toContain('read-tree failed');
		// The real run produces the working-tree wording (not "changed outside the
		// incoming paths"): other.txt has no index entry before or after the squash,
		// so only its working-tree fingerprint (absent -> blob) differs.
		expect(message).toContain(`${OUTSIDE}: other.txt`);
		// Reported only: the recreated bytes are not removed or restored.
		expect(read(f.root, 'other.txt')).toBe('rewritten by rollback\n');
		expect(read(f.root, 'renamed.txt')).toBe('other base\n');
	});
});
