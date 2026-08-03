/**
 * Swarm worktree-lane detection.
 *
 * These tests build REAL on-disk fixtures (a `.git` file pointing at a
 * `<main>/.git/worktrees/<name>` administrative directory) rather than mocking
 * the filesystem, because the whole point of `resolveLaneContext` is that it
 * reads exactly the files git itself writes. A mocked `readFileSync` would
 * prove only that the parser works, not that the layout assumption is right.
 * The layout was verified against a live lane on this machine:
 *
 *   E:/OpenCode/.swarm-worktrees/ses_.../1.1/.git
 *     -> "gitdir: E:/OpenCode/opencode-swarm-dev2/.git/worktrees/1.1"
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SWARM_WORKTREE_DIR_NAME } from '../../../src/config/constants';
import {
	_internals,
	resolveLaneContext,
} from '../../../src/config/lane-context';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const realAddDeferredWarning = _internals.addDeferredWarning;

let root: string;
let cleanup: () => void;

/**
 * Materialises `<root>/<project>` as a main working tree and
 * `<root>/.swarm-worktrees/<session>/<lane>` as a linked worktree of it,
 * mirroring what `provisionWorktree` produces.
 */
function makeLane(opts?: {
	withCommondir?: boolean;
	gitdirOverride?: string;
	laneDotGitIsDirectory?: boolean;
}): { lanePath: string; projectPath: string } {
	const projectPath = path.join(root, 'my-project');
	const lanePath = path.join(
		root,
		SWARM_WORKTREE_DIR_NAME,
		'ses_abc123',
		'1.1',
	);
	const adminDir = path.join(projectPath, '.git', 'worktrees', '1.1');
	fs.mkdirSync(adminDir, { recursive: true });
	fs.mkdirSync(lanePath, { recursive: true });

	if (opts?.laneDotGitIsDirectory) {
		fs.mkdirSync(path.join(lanePath, '.git'), { recursive: true });
	} else {
		// git writes forward slashes here even on Windows.
		const pointer = opts?.gitdirOverride ?? adminDir.split(path.sep).join('/');
		fs.writeFileSync(
			path.join(lanePath, '.git'),
			`gitdir: ${pointer}\n`,
			'utf-8',
		);
	}
	if (opts?.withCommondir !== false) {
		fs.writeFileSync(path.join(adminDir, 'commondir'), '../..\n', 'utf-8');
	}
	return { lanePath, projectPath };
}

beforeEach(() => {
	({ dir: root, cleanup } = createSafeTestDir('swarm-lane-ctx-'));
	_internals.clearCache();
});

afterEach(() => {
	_internals.clearCache();
	_internals.readFileSync = fs.readFileSync as typeof _internals.readFileSync;
	_internals.statSync = fs.statSync as unknown as typeof _internals.statSync;
	_internals.addDeferredWarning = realAddDeferredWarning;
	cleanup();
});

describe('resolveLaneContext — positive detection', () => {
	test('recognises a lane and resolves the parent project via commondir', () => {
		const { lanePath, projectPath } = makeLane();
		const result = resolveLaneContext(lanePath);
		expect(result).not.toBeNull();
		expect(result?.lanePath).toBe(path.resolve(lanePath));
		expect(result?.parentProjectPath).toBe(path.resolve(projectPath));
	});

	test('falls back to the documented .git/worktrees layout when commondir is absent', () => {
		const { lanePath, projectPath } = makeLane({ withCommondir: false });
		const result = resolveLaneContext(lanePath);
		expect(result?.parentProjectPath).toBe(path.resolve(projectPath));
	});

	test('accepts a relative gitdir pointer (git writes these for nested layouts)', () => {
		const { lanePath, projectPath } = makeLane();
		const adminDir = path.join(projectPath, '.git', 'worktrees', '1.1');
		const relative = path
			.relative(lanePath, adminDir)
			.split(path.sep)
			.join('/');
		fs.writeFileSync(
			path.join(lanePath, '.git'),
			`gitdir: ${relative}\n`,
			'utf-8',
		);
		_internals.clearCache();
		expect(resolveLaneContext(lanePath)?.parentProjectPath).toBe(
			path.resolve(projectPath),
		);
	});
});

describe('resolveLaneContext — negative detection (ordinary sessions unaffected)', () => {
	test('a plain project directory is not a lane', () => {
		const project = path.join(root, 'plain');
		fs.mkdirSync(path.join(project, '.git'), { recursive: true });
		expect(resolveLaneContext(project)).toBeNull();
	});

	test('a directory under .swarm-worktrees that is NOT a linked worktree is not a lane', () => {
		// Both signals are required; the marker alone must not be enough.
		const stray = path.join(root, SWARM_WORKTREE_DIR_NAME, 'ses_x', 'stray');
		fs.mkdirSync(stray, { recursive: true });
		expect(resolveLaneContext(stray)).toBeNull();
	});

	test('a real linked worktree OUTSIDE the swarm base is left alone', () => {
		// A user-created `git worktree add` must not inherit lane policy.
		const projectPath = path.join(root, 'proj2');
		const userWorktree = path.join(root, 'user-worktree');
		const adminDir = path.join(projectPath, '.git', 'worktrees', 'wt');
		fs.mkdirSync(adminDir, { recursive: true });
		fs.mkdirSync(userWorktree, { recursive: true });
		fs.writeFileSync(path.join(adminDir, 'commondir'), '../..\n', 'utf-8');
		fs.writeFileSync(
			path.join(userWorktree, '.git'),
			`gitdir: ${adminDir.split(path.sep).join('/')}\n`,
			'utf-8',
		);
		expect(resolveLaneContext(userWorktree)).toBeNull();
	});

	test('a segment that merely CONTAINS the marker does not match', () => {
		const decoy = path.join(root, `${SWARM_WORKTREE_DIR_NAME}-backup`, 'x');
		fs.mkdirSync(decoy, { recursive: true });
		expect(resolveLaneContext(decoy)).toBeNull();
	});

	test('lane .git being a directory (a main tree) is not a lane', () => {
		const { lanePath } = makeLane({ laneDotGitIsDirectory: true });
		expect(resolveLaneContext(lanePath)).toBeNull();
	});
});

describe('resolveLaneContext — never throws', () => {
	test('non-existent directory returns null', () => {
		expect(
			resolveLaneContext(
				path.join(root, SWARM_WORKTREE_DIR_NAME, 'ses', 'nope'),
			),
		).toBeNull();
	});

	test.each([
		['empty string', ''],
		['whitespace only', '   '],
		['traversal-flavoured relative path', '../../../etc'],
		['traversal under the marker', `${SWARM_WORKTREE_DIR_NAME}/../../etc`],
		['nul byte', 'lane\u0000/.swarm-worktrees'],
	])('%s returns null without throwing', (_label, input) => {
		expect(() => resolveLaneContext(input)).not.toThrow();
		expect(resolveLaneContext(input)).toBeNull();
	});

	test.each([
		['not a string', 42],
		['null', null],
		['undefined', undefined],
	])('%s returns null without throwing', (_label, input) => {
		expect(() => resolveLaneContext(input as unknown as string)).not.toThrow();
		expect(resolveLaneContext(input as unknown as string)).toBeNull();
	});

	test('an unreadable .git (permission error) degrades to null, not a throw', () => {
		const { lanePath } = makeLane();
		_internals.readFileSync = (() => {
			const err = new Error(
				'EACCES: permission denied',
			) as NodeJS.ErrnoException;
			err.code = 'EACCES';
			throw err;
		}) as typeof _internals.readFileSync;
		_internals.clearCache();
		expect(() => resolveLaneContext(lanePath)).not.toThrow();
		expect(resolveLaneContext(lanePath)).toBeNull();
	});

	test('a statSync throw degrades to null', () => {
		const { lanePath } = makeLane();
		_internals.statSync = (() => {
			throw new Error('boom');
		}) as unknown as typeof _internals.statSync;
		_internals.clearCache();
		expect(resolveLaneContext(lanePath)).toBeNull();
	});
});

describe('resolveLaneContext — malformed git metadata', () => {
	test('a .git file with no gitdir line returns null', () => {
		const { lanePath } = makeLane();
		fs.writeFileSync(path.join(lanePath, '.git'), 'garbage\n', 'utf-8');
		_internals.clearCache();
		expect(resolveLaneContext(lanePath)).toBeNull();
	});

	test('a gitdir pointing somewhere that is not .git/worktrees/<n> returns null', () => {
		const bogus = path.join(root, 'elsewhere');
		fs.mkdirSync(bogus, { recursive: true });
		const { lanePath } = makeLane({
			withCommondir: false,
			gitdirOverride: bogus.split(path.sep).join('/'),
		});
		_internals.clearCache();
		expect(resolveLaneContext(lanePath)).toBeNull();
	});

	test('a lane whose parent resolves to itself returns null', () => {
		const { lanePath } = makeLane({ withCommondir: false });
		// commondir that points back at the lane itself.
		const adminDir = path.join(root, 'my-project', '.git', 'worktrees', '1.1');
		fs.writeFileSync(
			path.join(adminDir, 'commondir'),
			path.join(lanePath, '.git').split(path.sep).join('/'),
			'utf-8',
		);
		_internals.clearCache();
		expect(resolveLaneContext(lanePath)).toBeNull();
	});
});

describe('resolveLaneContext — caching', () => {
	test('a second call does not re-read the filesystem', () => {
		const { lanePath } = makeLane();
		const first = resolveLaneContext(lanePath);
		let reads = 0;
		_internals.readFileSync = ((p: string, enc: BufferEncoding) => {
			reads += 1;
			return fs.readFileSync(p, enc);
		}) as typeof _internals.readFileSync;
		const second = resolveLaneContext(lanePath);
		expect(reads).toBe(0);
		expect(second).toEqual(first);
	});

	test('negative results are cached too', () => {
		// Must be a directory that actually reaches the git probe. A fixture that
		// short-circuits earlier would make the "0 further stats" assertion pass
		// vacuously.
		const plain = path.join(
			root,
			SWARM_WORKTREE_DIR_NAME,
			'ses_cache',
			'not-a-worktree',
		);
		fs.mkdirSync(plain, { recursive: true });
		let stats = 0;
		const counting = ((p: string) => {
			stats += 1;
			return fs.statSync(p);
		}) as unknown as typeof _internals.statSync;

		_internals.statSync = counting;
		expect(resolveLaneContext(plain)).toBeNull();
		// Sanity: the fixture really did exercise the filesystem probe (the
		// ancestor walk stats `.git` at each level), so the assertion below is
		// meaningful.
		expect(stats).toBeGreaterThan(0);

		stats = 0;
		expect(resolveLaneContext(plain)).toBeNull();
		expect(stats).toBe(0);
	});

	test('the cache is bounded and evicts FIFO (AGENTS.md invariant 8)', () => {
		// 256 is MAX_CACHED_DIRECTORIES. Insert one more than the cap and assert
		// the oldest key was evicted (it must be probed again) while a recent key
		// is still served from cache.
		const first = path.join(root, 'cache-0');
		fs.mkdirSync(first, { recursive: true });
		expect(resolveLaneContext(first)).toBeNull();
		for (let i = 1; i <= 256; i += 1) {
			resolveLaneContext(path.join(root, `cache-${i}`));
		}

		let stats = 0;
		_internals.statSync = ((p: string) => {
			stats += 1;
			return fs.statSync(p);
		}) as unknown as typeof _internals.statSync;

		// Oldest entry was evicted -> probed again.
		resolveLaneContext(first);
		expect(stats).toBeGreaterThan(0);

		// A recently inserted entry is still cached -> no probe.
		stats = 0;
		resolveLaneContext(path.join(root, 'cache-256'));
		expect(stats).toBe(0);
	});

	test('regression (MEDIUM-7): a transient I/O failure is NOT cached as "not a lane"', () => {
		// Caching an EACCES/EMFILE as a negative would silently disable lane
		// permission scoping for that directory for the whole process lifetime,
		// reinstating the hang with no way to recover short of a restart.
		const { lanePath, projectPath } = makeLane();
		const warnings: string[] = [];
		_internals.addDeferredWarning = (w: string) => {
			warnings.push(w);
		};
		_internals.statSync = (() => {
			const err = new Error(
				'EMFILE: too many open files',
			) as NodeJS.ErrnoException;
			err.code = 'EMFILE';
			throw err;
		}) as unknown as typeof _internals.statSync;

		expect(resolveLaneContext(lanePath)).toBeNull();
		// Surfaced, not silent.
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain(lanePath);

		// Recovery: the very next call, with I/O working again, must succeed.
		_internals.statSync = fs.statSync as unknown as typeof _internals.statSync;
		expect(resolveLaneContext(lanePath)?.parentProjectPath).toBe(
			path.resolve(projectPath),
		);
	});

	test('regression: a transient failure RETRIES and succeeds on the second attempt', () => {
		// applyLanePermissions runs exactly once per instance from the config
		// hook, so "we do not cache the failure, the next call can succeed" was
		// false on the production path — there is no next call. An EMFILE while
		// many lanes spawn at once therefore reverted that lane to the original
		// unbounded-prompt hang. Detection now retries in-line.
		const { lanePath, projectPath } = makeLane();
		const warnings: string[] = [];
		_internals.addDeferredWarning = (w: string) => {
			warnings.push(w);
		};
		let calls = 0;
		_internals.statSync = ((p2: string) => {
			calls += 1;
			if (calls === 1) {
				const err = new Error(
					'EMFILE: too many open files',
				) as NodeJS.ErrnoException;
				err.code = 'EMFILE';
				throw err;
			}
			return fs.statSync(p2);
		}) as unknown as typeof _internals.statSync;

		// Resolves on the retry, in the SAME call — no second caller needed.
		expect(resolveLaneContext(lanePath)?.parentProjectPath).toBe(
			path.resolve(projectPath),
		);
		expect(calls).toBeGreaterThan(1);
		// A recovered attempt must not warn.
		expect(warnings).toEqual([]);
	});

	test('regression: exhausted retries warn even for a swwt-layout lane', () => {
		// The warning used to be gated on hasWorktreeBaseSegment(), so exactly the
		// layouts the path heuristic cannot see — a worktree_dir override and the
		// Windows <tmp>/swwt fallback — got NO warning at all.
		const swwtLane = path.join(root, 'swwt', 'ses_abc', '1.1');
		fs.mkdirSync(swwtLane, { recursive: true });
		expect(swwtLane).not.toContain(SWARM_WORKTREE_DIR_NAME);

		const warnings: string[] = [];
		_internals.addDeferredWarning = (w: string) => {
			warnings.push(w);
		};
		let calls = 0;
		_internals.statSync = (() => {
			calls += 1;
			const err = new Error(
				'EACCES: permission denied',
			) as NodeJS.ErrnoException;
			err.code = 'EACCES';
			throw err;
		}) as unknown as typeof _internals.statSync;

		expect(resolveLaneContext(swwtLane)).toBeNull();
		// Retried, then gave up.
		expect(calls).toBeGreaterThan(1);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain(swwtLane);
		expect(warnings[0]).toContain('may hang');
	});

	test('an exhausted I/O failure is still NOT cached (a later call may succeed)', () => {
		const { lanePath, projectPath } = makeLane();
		_internals.addDeferredWarning = () => {};
		_internals.statSync = (() => {
			const err = new Error('EMFILE') as NodeJS.ErrnoException;
			err.code = 'EMFILE';
			throw err;
		}) as unknown as typeof _internals.statSync;
		expect(resolveLaneContext(lanePath)).toBeNull();

		_internals.statSync = fs.statSync as unknown as typeof _internals.statSync;
		expect(resolveLaneContext(lanePath)?.parentProjectPath).toBe(
			path.resolve(projectPath),
		);
	});

	test('a genuine ENOENT IS cached (it is a real answer, not an I/O failure)', () => {
		const warnings: string[] = [];
		_internals.addDeferredWarning = (w: string) => {
			warnings.push(w);
		};
		const missing = path.join(root, SWARM_WORKTREE_DIR_NAME, 'ses_e', 'gone');
		expect(resolveLaneContext(missing)).toBeNull();
		expect(warnings).toEqual([]);
	});
});
