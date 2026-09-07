/**
 * Issue #2527 — init orphan recovery against real git repos.
 *
 * Drives the REAL `runInitOrphanRecovery` end to end. Only the cross-process
 * lock primitives are replaced through the module's `_internals` seam (the
 * documented precedent in `init-orphan-recovery.test.ts` — real
 * proper-lockfile is flaky on CI); every ownership, enumeration, migration,
 * and removal path is the production code with real git.
 *
 * Round-2 critic obligations covered:
 *  - (a) two-sibling fixture: repoA's recovery NEVER deletes repoB's lane or
 *    its uncommitted work (foreign skip warning surfaced);
 *  - (b) a clean own orphan created directly in the NEW project-internal
 *    base is GENUINELY reclaimed (removedWorktrees contains it);
 *  - (c) a `.git`-less internal remnant is reclaimed;
 *  - (d) a lane with a durable live-owner record survives.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	_internals as RecoveryInternals,
	runInitOrphanRecovery,
} from '../../../src/hooks/init-orphan-recovery';
import { recordLiveLaneOwner } from '../../../src/parallel/lane-owners';
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

const realIsLocked = RecoveryInternals.isLocked;
const realListActiveLocks = RecoveryInternals.listActiveLocks;
const realTryAcquireLock = RecoveryInternals.tryAcquireLock;

let root: string;

beforeEach(() => {
	resetSwarmState();
	root = canonicalMkdtemp('iorec-2527-');
	// Lock seams only (see file header): no cross-process lock, and the
	// recovery lock always acquires with a no-op release. Constant timestamps
	// — no Date.now in test code.
	RecoveryInternals.isLocked = () => false;
	RecoveryInternals.listActiveLocks = () => [];
	RecoveryInternals.tryAcquireLock = async () => ({
		acquired: true as const,
		lock: {
			filePath: '.swarm/locks/init-orphan-recovery.lock',
			agent: 'init-orphan-recovery',
			taskId: 'init',
			timestamp: '2026-01-01T00:00:00.000Z',
			expiresAt: 0,
			_release: async () => {},
		},
	});
});

afterEach(() => {
	RecoveryInternals.isLocked = realIsLocked;
	RecoveryInternals.listActiveLocks = realListActiveLocks;
	RecoveryInternals.tryAcquireLock = realTryAcquireLock;
	resetSwarmState();
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort teardown (Windows can briefly hold git file handles).
	}
});

describe('runInitOrphanRecovery (issue #2527)', () => {
	test('(a) two siblings: repoA recovery never deletes repoB lane or its uncommitted work', async () => {
		const repoA = path.join(root, 'repoA');
		const repoB = path.join(root, 'repoB');
		initRepo(repoA);
		initRepo(repoB);

		// repoA's own clean orphan lane in the project-internal base…
		const ownLane = path.join(repoA, '.swarm-worktrees', 'ses-own', 'laneA');
		addWorktree(repoA, 'rec-own-branch', ownLane);
		// …and repoB's lane (with uncommitted work) placed under repoA's
		// base — the cross-project destruction class from issue #2527.
		const foreignLane = path.join(
			repoA,
			'.swarm-worktrees',
			'ses-foreign',
			'lanelB',
		);
		addWorktree(repoB, 'rec-foreign-branch', foreignLane);
		const uncommitted = path.join(foreignLane, 'uncommitted.txt');
		writeFileSync(uncommitted, 'sibling work\n');

		const result = await runInitOrphanRecovery(repoA);

		expect(result.attempted).toBe(true);
		expect(result.crossProcessLockHeld).toBe(false);
		// Own clean orphan reclaimed…
		expect(result.removedWorktrees).toContain(ownLane);
		expect(existsSync(ownLane)).toBe(false);
		// …foreign lane and its uncommitted work fully intact, with the
		// ownership skip surfaced as a warning.
		expect(existsSync(foreignLane)).toBe(true);
		expect(existsSync(uncommitted)).toBe(true);
		expect(
			result.warnings.some((w) =>
				w.includes('owned by a different repository'),
			),
		).toBe(true);
	}, 120_000);

	test('(b) clean own orphan in the NEW project-internal base is genuinely reclaimed', async () => {
		const repoA = path.join(root, 'repoA');
		initRepo(repoA);
		const ownLane = path.join(repoA, '.swarm-worktrees', 'ses-r2', 'laneR2');
		addWorktree(repoA, 'rec-r2-branch', ownLane);

		const result = await runInitOrphanRecovery(repoA);

		expect(result.removedWorktrees).toContain(ownLane);
		expect(existsSync(ownLane)).toBe(false);
	}, 120_000);

	test('(c) .git-less remnant inside the project base is reclaimed', async () => {
		const repoA = path.join(root, 'repoA');
		initRepo(repoA);
		const remnant = path.join(
			repoA,
			'.swarm-worktrees',
			'ses-remnant',
			'lanelR',
		);
		mkdirSync(remnant, { recursive: true });
		writeFileSync(path.join(remnant, 'stale.txt'), 'stale\n');

		const result = await runInitOrphanRecovery(repoA);

		expect(result.removedWorktrees).toContain(remnant);
		expect(existsSync(remnant)).toBe(false);
	}, 120_000);

	test('(d) lane with a durable live-owner record survives recovery', async () => {
		const repoA = path.join(root, 'repoA');
		initRepo(repoA);
		const liveLane = path.join(repoA, '.swarm-worktrees', 'ses-live', 'laneL');
		addWorktree(repoA, 'rec-live-branch', liveLane);
		// Durable owner signal for THIS process (alive PID, fresh record):
		// liveness is the lane's, not a five-minute lock TTL.
		recordLiveLaneOwner(repoA, {
			lanePath: liveLane,
			branchName: 'swarm/lane/ses_live/laneL',
			sessionId: 'ses_liveaaaaaaaaaaaaaaaaaaa',
			taskId: 'task-live',
		});

		const result = await runInitOrphanRecovery(repoA);

		expect(existsSync(liveLane)).toBe(true);
		expect(result.removedWorktrees).not.toContain(liveLane);
	}, 120_000);
});
