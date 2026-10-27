import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	attemptMergeBackFromDirty,
	_internals as mergeInternals,
	mergeLaneBranch,
} from '../../../src/worktree/merge';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Regression for the squash-refusal data-loss fix (#3409 / PR #3420): a
// REFUSED `git merge --squash --no-commit` writes nothing, so the restore must
// not run `checkout HEAD --` over the user's own bytes. A CONFLICTED squash
// still leaves unmerged entries and must still be restored. No test here reads
// the clock, so no clock helper is needed.

type Files = Record<string, string>;
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
function put(dir: string, files: Files): void {
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	}
}
function read(root: string, rel: string): string {
	return fs.readFileSync(path.join(root, rel), 'utf8');
}
/** Real repo: `base` on main, `lane` committed on a lane branch, optional `target` commit on main. */
function fixture(spec: { base: Files; lane: Files; target?: Files }) {
	const root = canonicalMkdtemp('settlement-squash-refusal-3409-');
	roots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'tests@example.invalid');
	git(root, 'config', 'user.name', 'Tests');
	git(root, 'config', 'core.autocrlf', 'false');
	put(root, { 'base.txt': 'base\n', ...spec.base });
	git(root, 'add', '.');
	git(root, 'commit', '-m', 'base');
	const lane = path.join(root, '.swarm', 'worktrees', 'lane');
	fs.mkdirSync(path.dirname(lane), { recursive: true });
	const branch = 'swarm/lane/ref-test';
	git(root, 'worktree', 'add', '-b', branch, lane);
	put(lane, spec.lane);
	git(lane, 'add', '.');
	git(lane, 'commit', '-m', 'lane');
	if (spec.target) {
		put(root, spec.target);
		git(root, 'add', '--', ...Object.keys(spec.target));
		git(root, 'commit', '-m', 'target');
	}
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
/** Route every git call to the real spawn unless `hook` returns a replacement. */
function seam(hook: (argv: string[]) => Spawned | undefined): void {
	mergeInternals.bunSpawn = (argv, options) =>
		hook(argv) ?? realSpawn(argv, options);
}
const isSquash = (argv: string[]) =>
	argv.includes('merge') && argv.includes('--squash');
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
const MARKERS = /^(<{7}|={7}|>{7})/m;
const INCOMPLETE = 'restore of pre-merge state incomplete';

describe('squash refusal must not overwrite user bytes #3409', () => {
	test('refused squash on a tracked incoming path keeps the concurrent writer bytes', async () => {
		const { root, lane, branch } = fixture({
			base: { 'second.txt': 'base second\n' },
			lane: { 'second.txt': 'lane second\n', 'first.txt': 'first\n' },
		});
		const head = git(root, 'rev-parse', 'HEAD');
		let injected = false;
		seam((argv) => {
			// The writer lands after the overlap preflight but before the snapshot
			// hashes the incoming paths, so the snapshot records the user's bytes,
			// the refused squash changes nothing, and the restore touches nothing.
			if (!injected && argv.includes('ls-files') && argv.includes('-s')) {
				injected = true;
				fs.writeFileSync(path.join(root, 'second.txt'), 'user bytes\n');
			}
			return undefined;
		});
		const result = await attemptMergeBackFromDirty(lane, branch, root, 'merge');
		expect(injected).toBe(true);
		expect(result).toMatchObject({ failed: true, stage: 'merge' });
		const message = 'message' in result ? result.message : '';
		// git names the tracked path it refused to overwrite (second.txt).
		expect(message).toContain('would be overwritten by merge');
		expect(message).toContain('second.txt');
		expect(message).not.toContain(INCOMPLETE);
		expect(read(root, 'second.txt')).toBe('user bytes\n');
		expect(read(root, 'second.txt')).not.toMatch(MARKERS);
		expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(false);
		expect(porcelain(root)).toBe('M second.txt');
		expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
		expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
	});

	// The writer lands AFTER the pre-squash snapshot (first.txt was `absent`), so
	// the restore sees a changed lane-added path. It may only unlink it when the
	// bytes are exactly the lane blob.
	test.each([
		['bytes differing from', 'user bytes\n', true],
		['bytes identical to', 'first\n', false],
	] as const)('refused squash with a concurrent file at a lane-added path (%s the lane blob)', async (_label, bytes, kept) => {
		const { root, lane, branch } = fixture({
			base: {},
			lane: { 'first.txt': 'first\n' },
		});
		let injected = false;
		seam((argv) => {
			if (!injected && isSquash(argv)) {
				injected = true;
				fs.writeFileSync(path.join(root, 'first.txt'), bytes);
			}
			return undefined;
		});
		const result = await attemptMergeBackFromDirty(lane, branch, root, 'merge');
		expect(injected).toBe(true);
		// Still a refused squash either way.
		expect(result).toMatchObject({ failed: true, stage: 'merge' });
		expect(result).not.toHaveProperty('merged');
		const message = 'message' in result ? result.message : '';
		expect(message).toContain(
			'untracked working tree files would be overwritten',
		);
		expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
		if (kept) {
			// The user's bytes are kept and the message names the path the restore
			// could not prove to be lane output.
			expect(message).toContain(
				`${INCOMPLETE}, partial merge state may remain: not restored: left in place (not the exact lane bytes): first.txt`,
			);
			expect(read(root, 'first.txt')).toBe(bytes);
			expect(porcelain(root)).toBe('?? first.txt');
		} else {
			// Accepted behavior: bytes equal to the lane blob are removed. No user
			// data is lost because the identical bytes live on the lane branch.
			expect(message).not.toContain(INCOMPLETE);
			expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(false);
			expect(git(root, 'show', `${branch}:first.txt`)).toBe('first');
			expect(porcelain(root)).toBe('');
		}
	});

	test('a genuinely conflicted squash is still restored to the pre-merge state', async () => {
		const { root, lane, branch } = fixture({
			base: { 'second.txt': 'base second\n' },
			lane: { 'second.txt': 'lane second\n', 'first.txt': 'first\n' },
			target: { 'second.txt': 'target second\n' },
		});
		const result = await attemptMergeBackFromDirty(lane, branch, root, 'merge');
		expect(result).toMatchObject({ partial: true, stage: 'merge' });
		const message = 'message' in result ? result.message : '';
		expect(message).toContain('CONFLICT');
		expect(message).not.toContain(INCOMPLETE);
		expect(git(root, 'ls-files', '-u')).toBe('');
		expect(read(root, 'second.txt')).toBe(
			git(root, 'show', 'HEAD:second.txt') + '\n',
		);
		expect(read(root, 'second.txt')).not.toMatch(MARKERS);
		expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(false);
		expect(porcelain(root)).toBe('');
		expect(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(false);
	});
});

describe('restore failure branches surface the failing operation #3409', () => {
	const conflicted = () =>
		fixture({
			base: { 'second.txt': 'base second\n' },
			lane: { 'second.txt': 'lane second\n', 'first.txt': 'first\n' },
			target: { 'second.txt': 'target second\n' },
		});
	const suffix = (operation: string) =>
		`; ${INCOMPLETE}, partial merge state may remain: ${operation}`;
	const has =
		(...tokens: string[]) =>
		(argv: string[]) =>
			tokens.every((t) => argv.includes(t));
	// The git call each named step makes.
	const steps = {
		'index listing': has('ls-files', '-s'),
		'HEAD listing': has('ls-tree', 'HEAD'),
		'index reset': has('reset', 'HEAD'),
		checkout: has('checkout'),
		'lane listing': has('ls-tree', 'swarm/lane/ref-test'),
		'hash-object': has('hash-object'),
		'unmerged listing after restore': has('ls-files', '-u'),
	};
	/** Fail (or fake) a git call only AFTER the squash ran, i.e. inside the restore. */
	const inRestore = (
		matches: (argv: string[]) => boolean,
		reply: () => Spawned,
	) => {
		let squashed = false;
		seam((argv) => {
			if (isSquash(argv)) squashed = true;
			return squashed && matches(argv) ? reply() : undefined;
		});
	};
	// [unmerged left, conflict markers left, lane-added file left] per failing step.
	const stops: Record<string, [boolean, boolean, boolean]> = {
		'index listing': [true, true, true],
		'hash-object': [true, true, true],
		'HEAD listing': [true, true, true],
		'index reset': [true, true, true],
		checkout: [false, true, true],
		// A failed lane listing is reported; tracked files still restore and lane-added files are kept.
		'lane listing': [false, false, true],
		// Last step: everything was restored, only the final check failed.
		'unmerged listing after restore': [false, false, false],
	};

	// Rows: [step, expected detail, exit code, stdout]. Exit 1 carries the detail
	// as stderr; exit 7 has empty output so the restore falls back to "git exited
	// 7"; exit 0 with one oid for the two files the restore hashes is a length
	// mismatch.
	const D = 'injected failure';
	test.each([
		['index listing', D, 1, ''],
		['HEAD listing', D, 1, ''],
		['index reset', D, 1, ''],
		['checkout', D, 1, ''],
		['checkout', 'git exited 7', 7, ''],
		['lane listing', D, 1, ''],
		['hash-object', D, 1, ''],
		['hash-object', 'unexpected output length', 0, 'deadbeef\n'],
		['unmerged listing after restore', D, 1, ''],
	] as const)('%s (%s) is reported by name and stops the restore', async (operation, detail, code, out) => {
		const { root, branch } = conflicted();
		inRestore(steps[operation], () =>
			fakeProc(code, out, code === 1 ? detail : ''),
		);
		const result = await mergeLaneBranch(root, branch, 'squash-unstaged');
		if (!('conflict' in result)) throw new Error('expected a conflict result');
		expect(result.message).toContain('CONFLICT');
		expect(result.message).toContain(`${operation}: ${detail}`);
		// Other operations' names never leak into this message.
		for (const other of Object.keys(stops))
			if (other !== operation)
				expect(result.message).not.toContain(`${other}:`);
		const [unmerged, markers, first] = stops[operation];
		expect(git(root, 'ls-files', '-u') !== '').toBe(unmerged);
		if (markers) expect(read(root, 'second.txt')).toMatch(MARKERS);
		else expect(read(root, 'second.txt')).toBe('target second\n');
		expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(first);
	});

	// The snapshot is fail-closed: if the pre-merge state cannot be recorded the
	// squash must not run at all, so nothing is staged, merged or overwritten.
	test.each([
		['index listing', steps['index listing'], 1, '', 'injected index failure'],
		['hash-object', steps['hash-object'], 1, '', 'injected hash failure'],
		[
			'hash-object',
			steps['hash-object'],
			0,
			'a\nb\n',
			'unexpected output length',
		],
	] as const)('snapshot %s failure refuses the squash and touches nothing', async (operation, matches, code, out, detail) => {
		const { root, branch } = conflicted();
		fs.writeFileSync(path.join(root, 'base.txt'), 'user base\n');
		let squashRan = false;
		seam((argv) => {
			if (isSquash(argv)) squashRan = true;
			return matches(argv) ? fakeProc(code, out, detail) : undefined;
		});
		const result = await mergeLaneBranch(root, branch, 'squash-unstaged');
		expect(result).not.toHaveProperty('conflict');
		expect(result).not.toHaveProperty('merged');
		expect('error' in result && result.error).toBe(
			`could not record pre-merge state before squash of ${branch}: ${operation}: ${detail}`,
		);
		expect(squashRan).toBe(false);
		expect(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(false);
		expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
		expect(git(root, 'ls-files', '-u')).toBe('');
		expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(false);
		expect(read(root, 'second.txt')).toBe('target second\n');
		expect(read(root, 'base.txt')).toBe('user base\n');
	});
});

describe('restore reports what it cannot prove it restored #3409', () => {
	// Non-conflict, non-refusal failure: the restore compares against the snapshot.
	test.each([
		['the exact lane bytes', 'first\n', true],
		['bytes that are not the lane blob', 'partial\n', false],
	] as const)('a non-refusal squash failure that wrote a lane-added file with %s', async (_label, written, removed) => {
		const { root, lane, branch } = fixture({
			base: { 'second.txt': 'base second\n' },
			lane: { 'second.txt': 'lane second\n', 'first.txt': 'first\n' },
		});
		let injected = false;
		seam((argv) => {
			if (!isSquash(argv)) return undefined;
			injected = true;
			fs.writeFileSync(path.join(root, 'first.txt'), written);
			return fakeProc(
				2,
				'',
				"error: unable to unlink old 'second.txt': Invalid argument\nMerge with strategy ort failed.",
			);
		});
		const result = await attemptMergeBackFromDirty(lane, branch, root, 'merge');
		expect(injected).toBe(true);
		expect(result).toMatchObject({ failed: true, stage: 'merge' });
		expect(result).not.toHaveProperty('merged');
		expect(result).not.toHaveProperty('partial');
		const message = 'message' in result ? result.message : '';
		expect(message).toContain("unable to unlink old 'second.txt'");
		expect(git(root, 'ls-files', '-u')).toBe('');
		expect(read(root, 'second.txt')).toBe('base second\n');
		if (removed) {
			// Exactly the lane blob: removed (recoverable from the lane branch)
			// and nothing is left to report.
			expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(false);
			expect(message).not.toContain(INCOMPLETE);
		} else {
			expect(read(root, 'first.txt')).toBe('partial\n');
			expect(message).toContain(
				`; ${INCOMPLETE}, partial merge state may remain: not restored: left in place (not the exact lane bytes): first.txt`,
			);
		}
	});

	test('an unmerged entry outside the incoming paths is reported by name', async () => {
		const body = (mid: string) => `l1\nl2\nl3\n${mid}\nl5\nl6\nl7\nl8\n`;
		const { root, branch } = fixture({
			base: { 'a.txt': body('l4') },
			lane: { 'a.txt': body('lane edit') },
		});
		// Target renames a.txt -> b.txt with a competing edit: the content
		// conflict lands on b.txt, which is NOT an incoming path (a.txt is).
		fs.renameSync(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
		fs.writeFileSync(path.join(root, 'b.txt'), body('target edit'));
		git(root, 'add', '-A', '--', 'a.txt', 'b.txt');
		git(root, 'commit', '-m', 'target rename');
		const result = await mergeLaneBranch(root, branch, 'squash-unstaged');
		if (!('conflict' in result)) throw new Error('expected a conflict result');
		expect(result.message).toContain('CONFLICT');
		expect(result.message).toContain(INCOMPLETE);
		expect(result.message.endsWith('unmerged: b.txt')).toBe(true);
		// Honest report: the unmerged entry really is still there.
		expect(git(root, 'ls-files', '-u')).toContain('b.txt');
	});

	test('a directory in HEAD named by an incoming path is never checked out over a sibling user edit', async () => {
		// The lane adds a FILE `x`; the target meanwhile gained a DIRECTORY `x/`,
		// so the only incoming path `x` is a tree entry in HEAD.
		const { root, branch } = fixture({
			base: {},
			lane: { x: 'lane file x\n' },
			target: { 'x/other': 'other\n' },
		});
		// A user edit to a tracked file that is NOT incoming.
		fs.writeFileSync(path.join(root, 'x', 'other'), 'user other\n');
		const result = await mergeLaneBranch(root, branch, 'squash-unstaged');
		if (!('conflict' in result)) throw new Error('expected a conflict result');
		expect(result.message).toContain('CONFLICT');
		expect(result.message).toContain(INCOMPLETE);
		// Checking out the HEAD tree entry `x` would restore x/other from HEAD.
		expect(read(root, 'x/other')).toBe('user other\n');
	});
});

describe('restore and unstage use literal pathspecs #3409', () => {
	test('conflicted tracked src/[id].ts is restored without touching sibling src/i.ts', async () => {
		const { root, branch } = fixture({
			base: { 'src/[id].ts': 'id base\n', 'src/i.ts': 'i base\n' },
			lane: { 'src/[id].ts': 'id lane\n', 'src/new.ts': 'new\n' },
			target: { 'src/[id].ts': 'id target\n' },
		});
		fs.writeFileSync(path.join(root, 'src', 'i.ts'), 'user i\n');
		const result = await mergeLaneBranch(root, branch, 'squash-unstaged');
		if (!('conflict' in result)) throw new Error('expected a conflict result');
		expect(result.message).not.toContain(INCOMPLETE);
		expect(read(root, 'src/[id].ts')).toBe('id target\n');
		expect(read(root, 'src/i.ts')).toBe('user i\n');
		expect(fs.existsSync(path.join(root, 'src', 'new.ts'))).toBe(false);
		expect(git(root, 'ls-files', '-u')).toBe('');
		expect(porcelain(root)).toBe('M src/i.ts');
	});

	test('conflicted lane-added src/[id].ts is removed without touching sibling src/i.ts', async () => {
		const { root, branch } = fixture({
			base: { 'src/i.ts': 'i base\n', 'src/c.ts': 'c base\n' },
			lane: { 'src/[id].ts': 'id lane\n', 'src/c.ts': 'c lane\n' },
			target: { 'src/c.ts': 'c target\n' },
		});
		fs.writeFileSync(path.join(root, 'src', 'i.ts'), 'user i\n');
		const result = await mergeLaneBranch(root, branch, 'squash-unstaged');
		if (!('conflict' in result)) throw new Error('expected a conflict result');
		expect(result.message).not.toContain(INCOMPLETE);
		expect(fs.existsSync(path.join(root, 'src', '[id].ts'))).toBe(false);
		expect(read(root, 'src/c.ts')).toBe('c target\n');
		expect(read(root, 'src/i.ts')).toBe('user i\n');
		expect(git(root, 'ls-files', '-u')).toBe('');
		expect(porcelain(root)).toBe('M src/i.ts');
	});

	test('restore reset leaves a sibling src/i.ts staged by a concurrent writer staged and reports it', async () => {
		const { root, branch } = fixture({
			base: { 'src/[id].ts': 'id base\n', 'src/i.ts': 'i base\n' },
			lane: { 'src/[id].ts': 'id lane\n' },
			target: { 'src/[id].ts': 'id target\n' },
		});
		// git itself refuses a true merge over a staged sibling, so the writer
		// can only stage between the conflicted squash and the restore: at the
		// restore's own index listing, which is the first `ls-files -s` after the
		// squash. src/i.ts is not an incoming path, so the restore never resets it;
		// its index change is reported as a change outside the incoming paths
		// (honest, not repaired).
		let squashed = false;
		let injected = false;
		seam((argv) => {
			if (isSquash(argv)) squashed = true;
			if (squashed && !injected && argv.includes('ls-files')) {
				injected = true;
				fs.writeFileSync(path.join(root, 'src', 'i.ts'), 'user staged i\n');
				git(root, 'add', '--', 'src/i.ts');
			}
			return undefined;
		});
		const result = await mergeLaneBranch(root, branch, 'squash-unstaged');
		expect(injected).toBe(true);
		if (!('conflict' in result)) throw new Error('expected a conflict result');
		expect(
			result.message.endsWith(
				`${INCOMPLETE}, partial merge state may remain: not restored: changed outside the incoming paths: src/i.ts`,
			),
		).toBe(true);
		// The incoming path itself was still fully restored.
		expect(read(root, 'src/[id].ts')).toBe('id target\n');
		expect(git(root, 'ls-files', '-u')).toBe('');
		expect(git(root, 'diff', '--cached', '--name-only')).toBe('src/i.ts');
		expect(git(root, 'show', ':src/i.ts')).toBe('user staged i');
		expect(read(root, 'src/i.ts')).toBe('user staged i\n');
	});

	// A staged sibling blocks a true (target-advanced) merge in git itself, so the
	// success path with a user-staged file is only reachable fast-forwardable.
	test('clean squash of src/[id].ts leaves the user-staged sibling src/i.ts staged', async () => {
		const { root, branch } = fixture({
			base: { 'src/i.ts': 'i base\n' },
			lane: { 'src/[id].ts': 'id lane\n' },
		});
		fs.writeFileSync(path.join(root, 'src', 'i.ts'), 'user staged i\n');
		git(root, 'add', '--', 'src/i.ts');
		const result = await mergeLaneBranch(root, branch, 'squash-unstaged');
		expect(result).toEqual({ merged: true, strategy: 'squash-unstaged' });
		expect(read(root, 'src/[id].ts')).toBe('id lane\n');
		// Lane work lands unstaged; the user's staged edit is the ONLY staged path.
		expect(git(root, 'diff', '--cached', '--name-only')).toBe('src/i.ts');
		expect(git(root, 'show', ':src/i.ts')).toBe('user staged i');
		expect(
			git(root, 'ls-files', '--others', '--exclude-standard', '--', 'src'),
		).toBe('src/[id].ts');
	});
});
