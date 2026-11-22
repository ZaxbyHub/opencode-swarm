/**
 * #3903 feedback round: two uncaught/unsafe paths in settlement recovery.
 *
 * FB-002: the ABORTED retry calls cleanupRecoveredWorktree, which throws when
 *   dirty work cannot be preserved or removed. recoverCoderSettlement runs in
 *   toolBefore for every tool; an uncaught throw wedges re-dispatch,
 *   update_task_status and close. Cleanup must be best-effort and retryable.
 * FB-001: the COMMITTED retry of an INCOMPLETE WAL is not the original
 *   successful landing. Using 'success' skips FR-001c dirty-work preservation
 *   and force-removes a failed/cancelled lane plus branch -D. Retries must
 *   use cancelled semantics.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
} from '../../../src/background/pending-delegations';
import {
	captureWorkspaceSnapshot,
	captureWorkspaceSnapshotAsync,
} from '../../../src/background/workspace-snapshot';
import { recordWorktreeProvisioningOwner } from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import {
	abortCoderSettlement,
	beginCoderSettlement,
	recoverCoderSettlement,
	settleCoderDispatch,
} from '../../../src/workflow/coder-settlement';
import { gitSpawnBounded } from '../../helpers/git-spawn-bounded';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TASK_ID = '1.1';
const LABEL = 'fb3903';

let root: string;
let repo: string;
let lane: string;
let branch: string;
let transitionId: string;
let descriptor: BackgroundWorktreeDescriptor;

function walPath(): string {
	return path.join(repo, '.swarm', 'coder-settlements', `${TASK_ID}.json`);
}

function readWal(): { state: string; cleanupComplete?: boolean } {
	return JSON.parse(fs.readFileSync(walPath(), 'utf8')) as {
		state: string;
		cleanupComplete?: boolean;
	};
}

function git(args: string[]) {
	return gitSpawnBounded(args, repo);
}

// Windows/git can briefly report an unregistered lane right after `worktree add`
// (the async ownership guard then sees no git HEAD). Wait for the lane to answer
// rev-parse before beginning a settlement; this is fixture readiness, not a
// product behavior assertion.
async function waitForLaneGitReady(): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const probe = await gitSpawnBounded(['rev-parse', 'HEAD'], lane, 5_000);
		if (probe.exitCode === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error('lane git did not become ready after worktree add');
}

// The failing predicate is the async twin's `git status --porcelain=v2 --branch`
// HEAD, not plain rev-parse. Wait for THAT to resolve before begin.
async function waitForAsyncSnapshotHead(): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const snapshot = await captureWorkspaceSnapshotAsync(lane);
		if (snapshot.gitHead !== null) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const probe = await gitSpawnBounded(
		['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
		lane,
		5_000,
	);
	throw new Error(
		`async snapshot did not resolve a lane git HEAD (status rc=${probe.exitCode}, stderr=${JSON.stringify(probe.stderr.slice(0, 400))}, stdout=${JSON.stringify(probe.stdout.slice(0, 200))})`,
	);
}

beforeEach(async () => {
	root = canonicalMkdtemp(`coder-fb3903-${LABEL}-`);
	repo = path.join(root, 'repo');
	fs.mkdirSync(repo);
	expect((await git(['init', '-q'])).exitCode).toBe(0);
	expect((await git(['config', 'user.email', 't@t.test'])).exitCode).toBe(0);
	expect((await git(['config', 'user.name', 'T'])).exitCode).toBe(0);
	fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(repo, 'src', 'feature.ts'),
		'export const v = 1;\n',
	);
	expect((await git(['add', '.'])).exitCode).toBe(0);
	expect((await git(['commit', '-q', '-m', 'seed'])).exitCode).toBe(0);

	branch = `swarm-lane/session-${LABEL}/lane-1`;
	lane = path.join(repo, '.swarm-worktrees', `session-${LABEL}`, 'lane-1');
	fs.mkdirSync(path.dirname(lane), { recursive: true });
	expect((await git(['worktree', 'add', '-b', branch, lane])).exitCode).toBe(0);
	await waitForLaneGitReady();
	await waitForAsyncSnapshotHead();

	transitionId = `coder:${LABEL}`;
	descriptor = {
		callID: `call-${LABEL}`,
		parentSessionId: `parent-${LABEL}`,
		taskId: TASK_ID,
		planTaskId: TASK_ID,
		worktreePath: lane,
		branchName: branch,
		worktreeId: 'lane-1',
		worktreeSessionId: `session-${LABEL}`,
		mergeStrategy: 'merge',
		laneIndex: 1,
		worktreeDir: null,
		reservationId: `reservation-${LABEL}`,
		generation: 1,
	};
	// beginCoderSettlement rejects a baseline with no git HEAD when the project
	// root IS a git repo. Re-derive the sync lane snapshot until it carries a
	// HEAD; this is fixture readiness (Windows git can miss the freshly added
	// linked worktree on the first read), not a product behavior assertion.
	let baseline = captureWorkspaceSnapshot(lane);
	for (let attempt = 0; baseline.gitHead === null && attempt < 10; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		baseline = captureWorkspaceSnapshot(lane);
	}
	expect(baseline.gitHead).not.toBeNull();
	const context: BackgroundTaskChangeContext = {
		declaredFiles: ['src'],
		baseline,
		workflowGeneration: 0,
	};
	// Windows git spawns can intermittently return no HEAD to the async twin
	// even after a successful sync rev-parse. The failed call creates no
	// settlement state, so retrying the same begin is safe and keeps this test
	// deterministic on a loaded host.
	let begun = false;
	for (let attempt = 0; attempt < 4 && !begun; attempt++) {
		try {
			await beginCoderSettlement({
				directory: repo,
				taskId: TASK_ID,
				transitionId,
				actor: 'architect',
				expectedGeneration: 0,
				context,
				worktree: descriptor,
			});
			begun = true;
		} catch (error) {
			if (
				attempt === 3 ||
				!(error instanceof Error) ||
				!error.message.includes('CODER_SETTLEMENT_BASELINE_UNAVAILABLE')
			) {
				throw error;
			}
		}
	}
	recordWorktreeProvisioningOwner(repo, {
		callID: descriptor.callID,
		parentSessionId: descriptor.parentSessionId,
		worktreeSessionId: descriptor.worktreeSessionId,
		taskId: TASK_ID,
		reservationId: `reservation-${LABEL}`,
		generation: 1,
		branchName: branch,
	});
});

afterEach(async () => {
	fs.rmSync(root, { recursive: true, force: true });
	// Let Windows release git handles opened by the async snapshot twin before
	// the next fixture starts spawning git in a different repo.
	await new Promise((resolve) => setTimeout(resolve, 500));
});

describe('#3903 settlement recovery feedback', () => {
	it('FB-002: an ABORTED retry whose preservation fails does not throw and stays retryable', async () => {
		// First abort leaves the WAL incomplete with the lane on disk.
		const ownersDir = path.join(repo, '.swarm', 'worktree-provisioning-owners');
		fs.mkdirSync(ownersDir, { recursive: true });
		fs.writeFileSync(path.join(ownersDir, 'garbage.json'), 'x'.repeat(17_000));
		expect(
			await abortCoderSettlement({
				directory: repo,
				taskId: TASK_ID,
				transitionId,
				reason: 'test abort',
			}),
		).toBe('aborted');
		fs.rmSync(path.join(ownersDir, 'garbage.json'));
		fs.writeFileSync(path.join(lane, 'src', 'dirty.ts'), 'dirty\n');
		expect(readWal().state).toBe('ABORTED');
		expect(readWal().cleanupComplete).not.toBe(true);

		// Reject the preservation commit so cleanupRecoveredWorktree throws.
		const hooksDir = path.join(repo, '.git', 'hooks');
		fs.mkdirSync(hooksDir, { recursive: true });
		const hook = path.join(hooksDir, 'pre-commit');
		fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
		fs.chmodSync(hook, 0o755);

		// The toolBefore recovery path must never throw into the fail-closed chain.
		await expect(recoverCoderSettlement(repo, TASK_ID)).resolves.toBeNull();
		expect(readWal().cleanupComplete).not.toBe(true);
		expect(fs.existsSync(path.join(lane, 'src', 'dirty.ts'))).toBe(true);
	}, 45_000);

	it('FB-001: a COMMITTED incomplete-WAL retry preserves dirty work before removal', async () => {
		const committed = await settleCoderDispatch({
			directory: repo,
			taskId: TASK_ID,
			transitionId,
			accepted: true,
			testEngineerExempt: false,
			observedFiles: ['src/feature.ts'],
		});
		expect(committed.accepted).toBe(true);
		expect(readWal().state).toBe('COMMITTED');
		expect(readWal().cleanupComplete).not.toBe(true);
		fs.writeFileSync(path.join(lane, 'src', 'precious.ts'), 'precious\n');

		await expect(recoverCoderSettlement(repo, TASK_ID)).resolves.toBeNull();

		const tags = await git(['tag', '-l', 'swarm-preserved-*']);
		const preserved = tags.stdout.trim().length > 0;
		const precious = path.join(lane, 'src', 'precious.ts');
		if (fs.existsSync(precious)) {
			expect(fs.readFileSync(precious, 'utf8')).toBe('precious\n');
		} else {
			// Removal is admissible only with a preservation marker.
			expect(preserved).toBe(true);
		}
	}, 45_000);
});
