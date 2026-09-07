/**
 * Issue #2527 — ownership-gated worktree-directory reclamation
 * (`removeOwnedWorktreeDir`), exercised against real git repositories in
 * canonical temp directories.
 *
 * Contract under test (acceptance checks C1/C2/C5/C7/C10):
 *  - an OWNED, clean lane at the project-internal base is reclaimed;
 *  - a lane owned by a DIFFERENT repository is skipped (reason contains
 *    "different repository") and its directory is left intact;
 *  - a `.git`-less remnant is removable only inside this project's own base —
 *    on the legacy parent-level shared base it is skipped;
 *  - git's refusal to remove a dirty own lane is a STOP (never an rmSync
 *    escalation): the lane, its uncommitted file, and its git registration
 *    all survive.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { removeOwnedWorktreeDir } from '../../../src/worktree/ownership';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Runs git in array form with explicit cwd, ignored stdin, bounded time. */
function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
	}) as string;
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, ['init']);
	git(dir, ['config', 'user.email', 'swarm-test@example.local']);
	git(dir, ['config', 'user.name', 'Swarm Test']);
	writeFileSync(path.join(dir, 'README.md'), '# test\n');
	git(dir, ['add', '.']);
	git(dir, ['commit', '-m', 'initial commit']);
}

function addWorktree(repo: string, branch: string, lanePath: string): void {
	mkdirSync(path.dirname(lanePath), { recursive: true });
	git(repo, ['worktree', 'add', '-b', branch, lanePath]);
}

/** git porcelain emits forward slashes; compare case-insensitively on win32. */
function porcelainPath(p: string): string {
	const norm = p.replaceAll('\\', '/');
	return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

let root: string;
let repoA: string;

beforeEach(() => {
	root = canonicalMkdtemp('own-2527-');
	repoA = path.join(root, 'repoA');
	initRepo(repoA);
});

afterEach(() => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Teardown is best-effort (Windows can briefly hold git file handles).
	}
});

describe('removeOwnedWorktreeDir (issue #2527)', () => {
	test('owned clean lane at the project-internal base is reclaimed', async () => {
		const lane = path.join(repoA, '.swarm-worktrees', 'ses_a', 'lane1');
		addWorktree(repoA, 'lane-branch-1', lane);
		expect(existsSync(path.join(lane, '.git'))).toBe(true);

		const outcome = await removeOwnedWorktreeDir(lane, repoA);

		expect(outcome.status).toBe('removed');
		expect(existsSync(lane)).toBe(false);
	}, 60_000);

	test("foreign lane (another repository's worktree) is skipped and left intact", async () => {
		const repoB = path.join(root, 'repoB');
		initRepo(repoB);
		// repoB's lane placed under repoA's project base — any path counts;
		// ownership, not location, decides deletability.
		const foreignLane = path.join(
			repoA,
			'.swarm-worktrees',
			'ses_foreign',
			'lanelB',
		);
		addWorktree(repoB, 'foreign-branch', foreignLane);

		const outcome = await removeOwnedWorktreeDir(foreignLane, repoA);

		expect(outcome.status).toBe('skipped');
		expect(outcome.status === 'skipped' && outcome.reason).toContain(
			'different repository',
		);
		expect(existsSync(foreignLane)).toBe(true);
		expect(existsSync(path.join(foreignLane, '.git'))).toBe(true);
	}, 60_000);

	test('.git-less remnant inside the project base is removed; on the legacy parent base it is skipped', async () => {
		// Inside the project-internal base: ours by construction → removable.
		const internalRemnant = path.join(
			repoA,
			'.swarm-worktrees',
			'ses_a',
			'remnant',
		);
		mkdirSync(internalRemnant, { recursive: true });
		writeFileSync(path.join(internalRemnant, 'stale.txt'), 'stale\n');

		const internalOutcome = await removeOwnedWorktreeDir(
			internalRemnant,
			repoA,
		);
		expect(internalOutcome.status).toBe('removed');
		expect(existsSync(internalRemnant)).toBe(false);

		// On the legacy parent-level shared base: ownership of a bare
		// directory cannot be proven → skipped, never deleted.
		const legacyRemnant = path.join(
			root,
			'.swarm-worktrees',
			'ses_x',
			'remnant',
		);
		mkdirSync(legacyRemnant, { recursive: true });
		writeFileSync(path.join(legacyRemnant, 'stale.txt'), 'stale\n');

		const legacyOutcome = await removeOwnedWorktreeDir(legacyRemnant, repoA);
		expect(legacyOutcome.status).toBe('skipped');
		expect(
			legacyOutcome.status === 'skipped' && legacyOutcome.reason,
		).toContain('outside the project worktree base');
		expect(existsSync(legacyRemnant)).toBe(true);
	}, 60_000);

	test('dirty own lane is refused by git — no rmSync escalation, work survives', async () => {
		const dirtyLane = path.join(
			repoA,
			'.swarm-worktrees',
			'ses_a',
			'lanelDirty',
		);
		addWorktree(repoA, 'lane-branch-dirty', dirtyLane);
		const uncommitted = path.join(dirtyLane, 'uncommitted.txt');
		writeFileSync(uncommitted, 'uncommitted work\n');

		const outcome = await removeOwnedWorktreeDir(dirtyLane, repoA);

		expect(outcome.status).toBe('refused');
		// The refusal text itself is the safety signal ("contains modified
		// or untracked files") — and it must have been a STOP: directory,
		// uncommitted file, and git registration all survive.
		expect(existsSync(dirtyLane)).toBe(true);
		expect(existsSync(uncommitted)).toBe(true);
		const porcelain = git(repoA, ['worktree', 'list', '--porcelain']);
		expect(porcelainPath(porcelain)).toContain(porcelainPath(dirtyLane));
	}, 60_000);
});
