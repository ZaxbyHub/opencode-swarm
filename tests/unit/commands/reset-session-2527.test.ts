/**
 * Issue #2527 — `/swarm reset-session` worktree-lane reclamation, driven
 * through `handleResetSessionCommand` (the registry handler shape:
 * `{directory, args, sessionID}`) against real git repos.
 *
 * Contract: sibling-foreign lanes are never deleted; clean own lanes go
 * without confirmation; dirty own lanes are preserved and surfaced with a
 * `--confirm=<token>` (two-step destructive purge); the printed token purges
 * on the second invocation; a wrong token is rejected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { handleResetSessionCommand } from '../../../src/commands/reset-session';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { resetSwarmState } from '../../../src/state';
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

let root: string;
let repoA: string;

beforeEach(() => {
	resetSwarmState();
	root = canonicalMkdtemp('reset-2527-');
	repoA = path.join(root, 'repoA');
	initRepo(repoA);
	mkdirSync(path.join(repoA, '.swarm', 'session'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	closeProjectDb(repoA);
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort teardown (Windows can briefly hold git file handles).
	}
});

describe('handleResetSessionCommand — worktree lane reclamation (#2527)', () => {
	it('sibling foreign lane is never deleted', async () => {
		const repoB = path.join(root, 'repoB');
		initRepo(repoB);
		const foreignLane = path.join(repoA, '.swarm-worktrees', 'ses-f', 'lanelF');
		addWorktree(repoB, 'rs-foreign-branch', foreignLane);
		const uncommitted = path.join(foreignLane, 'uncommitted.txt');
		writeFileSync(uncommitted, 'sibling work\n');

		const output = await handleResetSessionCommand(repoA, [], 'ses_op01');

		expect(output).toContain('owned by a different repository');
		expect(existsSync(foreignLane)).toBe(true);
		expect(existsSync(uncommitted)).toBe(true);
	}, 120_000);

	it('own clean lane is deleted without args', async () => {
		const ownLane = path.join(repoA, '.swarm-worktrees', 'ses-c', 'laneC');
		addWorktree(repoA, 'rs-clean-branch', ownLane);

		const output = await handleResetSessionCommand(repoA, [], 'ses_op02');

		expect(output).toContain('Removed 1 clean worktree lane(s)');
		expect(existsSync(ownLane)).toBe(false);
	}, 120_000);

	it('own dirty lane: preserved with a confirm token; wrong token rejected; printed token purges', async () => {
		const dirtyLane = path.join(repoA, '.swarm-worktrees', 'ses-d', 'laneD');
		addWorktree(repoA, 'rs-dirty-branch', dirtyLane);
		const uncommitted = path.join(dirtyLane, 'uncommitted.txt');
		writeFileSync(uncommitted, 'uncommitted work\n');

		// First invocation (no token): git refuses the dirty lane, it is
		// preserved, and the operator gets a single-use confirm token.
		const first = await handleResetSessionCommand(repoA, [], 'ses_op03');
		expect(first).toMatch(/--confirm=[0-9a-f]{24}/);
		expect(existsSync(dirtyLane)).toBe(true);
		const token = /--confirm=([0-9a-f]{24})/.exec(first)?.[1];
		expect(token).toBeDefined();

		// Wrong token: rejected, nothing destroyed, record stays armed.
		const wrong = await handleResetSessionCommand(
			repoA,
			['--confirm=ffffffffffffffffffffffff'],
			'ses_op03',
		);
		expect(wrong).toContain('Confirmed purge rejected');
		expect(existsSync(dirtyLane)).toBe(true);

		// Second invocation echoing the printed token: purged.
		const second = await handleResetSessionCommand(
			repoA,
			[`--confirm=${token}`],
			'ses_op03',
		);
		expect(second).toContain('Removed 1 confirmed worktree lane(s)');
		expect(existsSync(dirtyLane)).toBe(false);
	}, 120_000);
});
