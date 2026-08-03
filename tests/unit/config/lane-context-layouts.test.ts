/**
 * Lane detection across the three worktree PROVISIONING LAYOUTS, and the
 * user-authored branches that must never be captured.
 *
 * Split out of `lane-context.test.ts` to stay under the FR-006 500-line cap.
 * Shares the on-disk fixture style of that file: real `.git` files pointing at
 * real `<main>/.git/worktrees/<name>` administrative directories, because the
 * whole point of `resolveLaneContext` is that it reads exactly what git writes.
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

describe('resolveLaneContext — regression (HIGH-1): all three provisioning layouts', () => {
	// provisionWorktree can place a lane in three different locations, and only
	// the first contains `.swarm-worktrees`. Keying detection on the path alone
	// silently missed the other two — including the Windows fallback, which
	// fires with NO user configuration and is the platform this defect was
	// reported on. Branch name is the path-independent marker.

	/** Builds a linked worktree at an arbitrary path on the given branch. */
	function makeWorktreeAt(
		lanePath: string,
		branch: string,
	): { lanePath: string; projectPath: string } {
		const projectPath = path.join(root, 'proj-layouts');
		const adminDir = path.join(
			projectPath,
			'.git',
			'worktrees',
			path.basename(lanePath),
		);
		fs.mkdirSync(adminDir, { recursive: true });
		fs.mkdirSync(lanePath, { recursive: true });
		fs.writeFileSync(path.join(adminDir, 'commondir'), '../..\n', 'utf-8');
		fs.writeFileSync(
			path.join(adminDir, 'HEAD'),
			`ref: refs/heads/${branch}\n`,
			'utf-8',
		);
		fs.writeFileSync(
			path.join(lanePath, '.git'),
			`gitdir: ${adminDir.split(path.sep).join('/')}\n`,
			'utf-8',
		);
		return { lanePath, projectPath };
	}

	test('layout 2: a worktree_dir override lane (no .swarm-worktrees segment) is detected', () => {
		// resolveWorktreeBaseDir(directory, worktreeDir) resolves to an arbitrary
		// configured path.
		const { lanePath, projectPath } = makeWorktreeAt(
			path.join(root, 'custom-wt', 'ses_x', '2.1'),
			'swarm/lane/ses_x/2.1',
		);
		expect(lanePath).not.toContain(SWARM_WORKTREE_DIR_NAME);
		expect(resolveLaneContext(lanePath)?.parentProjectPath).toBe(
			path.resolve(projectPath),
		);
	});

	test('layout 3: the Windows path-budget fallback (<tmp>/swwt/...) is detected', () => {
		// shortenWorktreePath() returns path.join(os.tmpdir(), 'swwt', ses, lane).
		const { lanePath, projectPath } = makeWorktreeAt(
			path.join(root, 'swwt', 'ses_y', '3.1'),
			'swarm/lane/ses_y/3.1',
		);
		expect(lanePath).not.toContain(SWARM_WORKTREE_DIR_NAME);
		expect(resolveLaneContext(lanePath)?.parentProjectPath).toBe(
			path.resolve(projectPath),
		);
	});

	test("the legacy-lane branch style ('swarm-lane/...') is also recognised", () => {
		const { lanePath } = makeWorktreeAt(
			path.join(root, 'legacy-wt', '4.1'),
			'swarm-lane/ses_z/4.1',
		);
		expect(resolveLaneContext(lanePath)).not.toBeNull();
	});

	test('a linked worktree on a NON-swarm branch outside the base is still ignored', () => {
		const { lanePath } = makeWorktreeAt(
			path.join(root, 'user-wt', 'feature'),
			'feature/my-work',
		);
		expect(resolveLaneContext(lanePath)).toBeNull();
	});

	test('a decoy branch that merely contains "swarm/" mid-name is ignored', () => {
		const { lanePath } = makeWorktreeAt(
			path.join(root, 'decoy-wt', 'x'),
			'feature/not-swarm/thing',
		);
		expect(resolveLaneContext(lanePath)).toBeNull();
	});

	test('regression (HIGH-1 r3): a user worktree INSIDE .swarm-worktrees is NOT a lane', () => {
		// Reproduced with real git:
		//   git worktree add -b my-feature ../.swarm-worktrees/manual-user-wt
		// The old path fallback matched "any path containing a .swarm-worktrees
		// segment", so this ordinary interactive session was classified as a lane
		// and had an unrecoverable deny-by-default injected. The path signal now
		// requires the FULL provisioned shape
		// `<base>/.swarm-worktrees/<ses_...>/<id>`.
		const { lanePath } = makeWorktreeAt(
			path.join(root, SWARM_WORKTREE_DIR_NAME, 'manual-user-wt'),
			'my-feature',
		);
		expect(lanePath).toContain(SWARM_WORKTREE_DIR_NAME);
		expect(resolveLaneContext(lanePath)).toBeNull();
	});

	test.each([
		// A non-swarm branch at the right DEPTH but a bad session segment.
		['notasession', '1.1'],
		['SES_abc', '1.1'],
		['ses-abc', '1.1'],
	])('regression (HIGH-1 r3): .swarm-worktrees/%s/%s is NOT a lane', (sessionSeg, id) => {
		const { lanePath } = makeWorktreeAt(
			path.join(root, SWARM_WORKTREE_DIR_NAME, sessionSeg, id),
			'my-feature',
		);
		expect(resolveLaneContext(lanePath)).toBeNull();
	});

	test('a DETACHED-HEAD lane at the full provisioned shape still resolves', () => {
		// The path fallback must survive the narrowing — it is the only signal
		// for a lane whose HEAD carries a bare SHA.
		const { lanePath, projectPath } = makeWorktreeAt(
			path.join(root, SWARM_WORKTREE_DIR_NAME, 'ses_abc123', '1.1'),
			'swarm/lane/ses_abc123/1.1',
		);
		const adminDir = path.join(
			root,
			'proj-layouts',
			'.git',
			'worktrees',
			'1.1',
		);
		fs.writeFileSync(
			path.join(adminDir, 'HEAD'),
			'0123456789abcdef0123456789abcdef01234567\n',
			'utf-8',
		);
		_internals.clearCache();
		expect(resolveLaneContext(lanePath)?.parentProjectPath).toBe(
			path.resolve(projectPath),
		);
	});

	test.each([
		// Reproduced HIGH-1: `git worktree add -b swarm/my-own-experiment ../scratch`
		['swarm/my-own-experiment'],
		['swarm/feature/foo'],
		['swarm-lane/wip'],
		['swarm/lane/notasession/1.1'],
		['swarm/lane/ses_x/1.1-extra-segment/deep'],
	])('regression (HIGH-1): user branch %s outside the swarm base is NOT a lane', (branch) => {
		// A bare `swarm/` prefix used to be sufficient. Misclassifying an
		// ordinary session injects a deny-all it cannot recover from, because
		// the host's Permission.ask short-circuits on deny before creating any
		// deferred — no prompt, so "Allow always" is unreachable.
		const safeName = branch.replace(/[^A-Za-z0-9]/g, '_');
		const { lanePath } = makeWorktreeAt(
			path.join(root, 'user-branches', safeName),
			branch,
		);
		expect(resolveLaneContext(lanePath)).toBeNull();
	});

	test('detached HEAD inside the swarm base still falls back to the path signal', () => {
		const { lanePath } = makeWorktreeAt(
			path.join(root, SWARM_WORKTREE_DIR_NAME, 'ses_d', '5.1'),
			'swarm/lane/ses_d/5.1',
		);
		// Overwrite HEAD with a bare SHA (detached).
		const adminDir = path.join(
			root,
			'proj-layouts',
			'.git',
			'worktrees',
			'5.1',
		);
		fs.writeFileSync(
			path.join(adminDir, 'HEAD'),
			'0123456789abcdef0123456789abcdef01234567\n',
			'utf-8',
		);
		_internals.clearCache();
		expect(resolveLaneContext(lanePath)).not.toBeNull();
	});

	test('layout D: an instance dir NESTED below a lane resolves to the lane root', () => {
		// A nested directory has no `.git` of its own — git never writes one —
		// so a same-directory-only check returns "not a lane" and the nested
		// instance keeps hanging. The bounded ancestor walk finds the lane root.
		//
		// NOTE the previous version of this test wrote a `.git` file into the
		// nested directory before asserting. That fabricated the very property
		// under test and is exactly why this gap stayed invisible.
		const { lanePath, projectPath } = makeWorktreeAt(
			path.join(root, SWARM_WORKTREE_DIR_NAME, 'ses_n', '6.1'),
			'swarm/lane/ses_n/6.1',
		);
		const nested = path.join(lanePath, 'a', 'b', 'c');
		fs.mkdirSync(nested, { recursive: true });
		expect(fs.existsSync(path.join(nested, '.git'))).toBe(false);

		const result = resolveLaneContext(nested);
		expect(result).not.toBeNull();
		// lanePath is the LANE ROOT, not the queried nested directory.
		expect(result?.lanePath).toBe(path.resolve(lanePath));
		expect(result?.parentProjectPath).toBe(path.resolve(projectPath));
	});

	test('the ancestor walk stops at the filesystem root without throwing', () => {
		const orphan = path.join(root, 'no-git-anywhere', 'deep', 'deeper');
		fs.mkdirSync(orphan, { recursive: true });
		expect(() => resolveLaneContext(orphan)).not.toThrow();
		expect(resolveLaneContext(orphan)).toBeNull();
	});
});
