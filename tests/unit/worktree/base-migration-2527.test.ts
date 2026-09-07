/**
 * Issue #2527 (F4) — legacy parent-level shared worktree base migration
 * (`migrateLegacyWorktreeBase`) over real git repositories.
 *
 * Contract: owned, clean, non-live lanes are MOVED into
 * `<project>/.swarm-worktrees` via `git worktree move` (registered at the new
 * path, non-prunable); foreign-owned lanes and live-owned lanes are RETAINED
 * at their legacy paths; the legacy base directory is rmdir'd only when
 * empty; at most 16 lanes move per pass.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { SWARM_WORKTREE_DIR_NAME } from '../../../src/config/constants';
import {
	listLiveLaneOwners,
	recordLiveLaneOwner,
} from '../../../src/parallel/lane-owners';
import { migrateLegacyWorktreeBase } from '../../../src/worktree/base-migration';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 60_000,
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
function norm(p: string): string {
	const forward = p.replaceAll('\\', '/');
	return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

/** Parses `git worktree list --porcelain` into per-worktree blocks. */
function worktreeBlocks(
	repo: string,
): Array<{ header: string; lines: string[] }> {
	const blocks: Array<{ header: string; lines: string[] }> = [];
	for (const rawBlock of git(repo, ['worktree', 'list', '--porcelain']).split(
		'\n\n',
	)) {
		const lines = rawBlock.split('\n').filter((l) => l.trim().length > 0);
		if (lines.length > 0) blocks.push({ header: lines[0], lines });
	}
	return blocks;
}

let root: string;
let project: string;
let legacyBase: string;
let newBase: string;

beforeEach(() => {
	root = canonicalMkdtemp('basemig-2527-');
	project = path.join(root, 'repoA');
	initRepo(project);
	legacyBase = path.join(path.dirname(project), SWARM_WORKTREE_DIR_NAME);
	newBase = path.join(project, SWARM_WORKTREE_DIR_NAME);
});

afterEach(() => {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort teardown (Windows can briefly hold git file handles).
	}
});

describe('migrateLegacyWorktreeBase (issue #2527 F4)', () => {
	test('owned clean lane on the legacy base is moved into the project base', async () => {
		const legacyLane = path.join(legacyBase, 'ses-1', 'lane-1');
		addWorktree(project, 'mig-branch-1', legacyLane);
		const movedLane = path.join(newBase, 'ses-1', 'lane-1');

		const result = await migrateLegacyWorktreeBase(project, []);

		expect(result.legacyBaseExists).toBe(true);
		expect(result.moved).toEqual([movedLane]);
		expect(existsSync(movedLane)).toBe(true);
		expect(existsSync(legacyLane)).toBe(false);
		// Registered at the NEW path and healthy (not prunable).
		const block = worktreeBlocks(project).find((b) =>
			norm(b.header).includes(norm(movedLane)),
		);
		expect(block).toBeDefined();
		expect(block?.lines.some((l) => l.startsWith('prunable'))).toBe(false);
		// No lane CONTENT is retained at the legacy path, and the emptied
		// session husk is dropped after a successful move so the legacy base
		// actually reaches the empty state the final plain rmdir requires.
		// The safety property under test: nothing was deleted besides the
		// move and the empty husk.
		expect(existsSync(legacyLane)).toBe(false);
		const sessionHusk = path.join(legacyBase, 'ses-1');
		expect(existsSync(sessionHusk)).toBe(false);
		expect(existsSync(legacyBase)).toBe(false);
		expect(result.legacyBaseRemoved).toBe(true);
	}, 120_000);

	test('a truly empty legacy base is removed by the plain rmdir', async () => {
		mkdirSync(legacyBase, { recursive: true });

		const result = await migrateLegacyWorktreeBase(project, []);

		expect(result.legacyBaseExists).toBe(true);
		expect(result.attempted).toBe(true);
		expect(result.moved).toHaveLength(0);
		expect(result.retained).toHaveLength(0);
		expect(result.legacyBaseRemoved).toBe(true);
		expect(existsSync(legacyBase)).toBe(false);
	});

	test('foreign lane on the shared legacy base is retained at its legacy path', async () => {
		const repoB = path.join(root, 'repoB');
		initRepo(repoB);
		const foreignLane = path.join(legacyBase, 'ses-2', 'laneB');
		addWorktree(repoB, 'mig-foreign-branch', foreignLane);

		const result = await migrateLegacyWorktreeBase(project, []);

		expect(result.moved).toHaveLength(0);
		const retained = result.retained.find((r) => r.lanePath === foreignLane);
		expect(retained?.reason).toContain('owned by a different repository');
		expect(existsSync(foreignLane)).toBe(true);
		// Retained entries keep the legacy base alive (never rm -rf'd).
		expect(result.legacyBaseRemoved).toBe(false);
		expect(existsSync(legacyBase)).toBe(true);
	}, 120_000);

	test('live-owned lane is retained (its owner process is still running)', async () => {
		const liveLane = path.join(legacyBase, 'ses-3', 'lane-3');
		addWorktree(project, 'mig-branch-live', liveLane);
		recordLiveLaneOwner(project, {
			lanePath: liveLane,
			branchName: 'swarm/lane/ses_3/lane-3',
			sessionId: 'ses_3aaaaaaaaaaaaaaaaaaaaa',
			taskId: 'task-3',
		});
		const liveOwners = listLiveLaneOwners(project).live;
		expect(liveOwners.map((o) => o.lanePath)).toContain(liveLane);

		const result = await migrateLegacyWorktreeBase(project, liveOwners);

		expect(result.moved).toHaveLength(0);
		const retained = result.retained.find((r) => r.lanePath === liveLane);
		expect(retained?.reason).toContain('live lane');
		expect(existsSync(liveLane)).toBe(true);
		expect(result.legacyBaseRemoved).toBe(false);
	}, 120_000);

	test('per-pass cap: 17 owned clean lanes → 16 moved, 1 retained', async () => {
		const lanes: string[] = [];
		for (let i = 1; i <= 17; i++) {
			const lane = path.join(
				legacyBase,
				'ses-cap',
				`lane-${String(i).padStart(2, '0')}`,
			);
			addWorktree(project, `mig-cap-branch-${i}`, lane);
			lanes.push(lane);
		}

		const result = await migrateLegacyWorktreeBase(project, []);

		expect(result.moved).toHaveLength(16);
		expect(result.retained).toHaveLength(1);
		expect(result.retained[0].reason).toContain('per-pass migration cap');
		// Exactly one lane still sits at its legacy path; the other 16
		// exist only under the project-internal base.
		const remainingLegacy = lanes.filter((l) => existsSync(l));
		expect(remainingLegacy).toHaveLength(1);
		expect(result.moved.filter((m) => existsSync(m))).toHaveLength(16);
		// The retained lane keeps the legacy base present.
		expect(existsSync(legacyBase)).toBe(true);
	}, 120_000);
});
