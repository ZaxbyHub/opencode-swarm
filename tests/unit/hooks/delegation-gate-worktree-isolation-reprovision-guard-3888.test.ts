/**
 * #3888: a superseded dispatch's standard-worktree teardown must never destroy
 * a lane that a different live dispatch now owns (same-task re-provision
 * re-creates the identical path/branch). Pins the ownership guard
 * (findSupersedingLaneDispatch + G1 in cleanupStandardWorktreeForCallId + G2 in
 * the delegation-gate terminal branch), the distinct confirmed/uncertain skip
 * outcomes, and lock-busy preservation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	awaitingMergeByCallID,
	cleanupStandardWorktreeForCallId,
	findSupersedingLaneDispatch,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { recordWorktreeProvisioningOwner } from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import { recordLiveLaneOwner } from '../../../src/parallel/lane-owners';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import type { WorktreeHandle } from '../../../src/worktree';

const SESSION = 'ses_3888t';
const BRANCH = 'swarm-lane/ses_3888t/1.1';

function gitSpawn(
	args: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn('git', args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => {
			stdout += d;
		});
		proc.stderr.on('data', (d) => {
			stderr += d;
		});
		proc.on('close', (exitCode) => {
			resolve({ exitCode: exitCode ?? 1, stdout, stderr });
		});
	});
}

let project: string;
let lanePath: string;

function makeDispatch(callID: string): StandardWorktreeDispatch {
	return {
		callID,
		parentSessionID: SESSION,
		taskId: '1.1',
		planTaskId: '1.1',
		handle: {
			worktreePath: lanePath,
			branchName: BRANCH,
			purpose: 'lane',
			id: `wt-${callID}`,
			sessionId: SESSION,
		} as WorktreeHandle,
		mergeStrategy: 'merge',
		laneIndex: 0,
		worktree_dir: undefined,
	};
}

function seedAwaiting(callID: string): void {
	awaitingMergeByCallID.set(callID, {
		callID,
		parentSessionID: SESSION,
		taskId: '1.1',
		planTaskId: '1.1',
		branch: BRANCH,
		worktreePath: lanePath,
		mergeStrategy: 'merge',
		queuedAt: 1_000,
	});
}

function ownerDir(): string {
	return path.join(project, '.swarm', 'worktree-provisioning-owners');
}

beforeEach(async () => {
	resetStandardWorktreeIsolationState();
	resetSwarmState();
	project = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'wt3888-guard-')),
	);
	fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
	await gitSpawn(['init', '-q'], project);
	await gitSpawn(['config', 'user.email', 't@t.test'], project);
	await gitSpawn(['config', 'user.name', 'T'], project);
	fs.writeFileSync(path.join(project, 'README.md'), 'x\n');
	await gitSpawn(['add', 'README.md'], project);
	await gitSpawn(['commit', '-q', '-m', 'init'], project);
	lanePath = path.join(project, '.swarm-worktrees', SESSION, '1.1');
	fs.mkdirSync(path.dirname(lanePath), { recursive: true });
	const add = await gitSpawn(
		['worktree', 'add', '-b', BRANCH, lanePath, 'HEAD'],
		project,
	);
	expect(add.exitCode).toBe(0);
	ensureAgentSession(SESSION);
});

afterEach(() => {
	resetStandardWorktreeIsolationState();
	resetSwarmState();
	fs.rmSync(project, { recursive: true, force: true });
});

describe('#3888 findSupersedingLaneDispatch', () => {
	it('detects a live sibling map entry at the same path/branch', () => {
		standardWorktreeByCallID.set('call-b', makeDispatch('call-b'));
		const found = findSupersedingLaneDispatch(
			project,
			'call-a',
			lanePath,
			BRANCH,
		);
		expect(found).toEqual({
			kind: 'active-dispatch',
			callID: 'call-b',
		});
	});

	it('detects a fresh v3 provisioning-owner marker with no map entry', () => {
		recordWorktreeProvisioningOwner(project, {
			callID: 'call-b',
			parentSessionId: SESSION,
			worktreeSessionId: SESSION,
			taskId: '1.1',
			reservationId: 'res-b',
			generation: 2,
			branchName: BRANCH,
		});
		const found = findSupersedingLaneDispatch(
			project,
			'call-a',
			lanePath,
			BRANCH,
		);
		expect(found).toEqual({ kind: 'provisioning-owner', callID: 'call-b' });
	});

	it('fails closed (uncertain) when the owner store is unreadable', () => {
		fs.mkdirSync(ownerDir(), { recursive: true });
		fs.writeFileSync(path.join(ownerDir(), 'garbage.json'), 'x'.repeat(600));
		const found = findSupersedingLaneDispatch(
			project,
			'call-a',
			lanePath,
			BRANCH,
		);
		expect(found?.kind).toBe('uncertain');
	});

	it('returns undefined with no other owner', () => {
		expect(
			findSupersedingLaneDispatch(project, 'call-a', lanePath, BRANCH),
		).toBeUndefined();
	});
});

describe('#3888 cleanup guard (G1)', () => {
	it('skips worktree+branch removal when a sibling dispatch owns the lane', async () => {
		seedAwaiting('call-a');
		standardWorktreeByCallID.set('call-b', makeDispatch('call-b'));
		const result = await cleanupStandardWorktreeForCallId(
			'call-a',
			'success',
			project,
		);
		expect(result.skippedReprovisioned).toBe(true);
		expect(result.removedWorktree).toBe(false);
		expect(fs.existsSync(lanePath)).toBe(true);
		const ref = await gitSpawn(
			['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`],
			project,
		);
		expect(ref.exitCode).toBe(0);
		expect(awaitingMergeByCallID.has('call-a')).toBe(false);
		expect(
			ensureAgentSession(SESSION).pendingAdvisoryMessages?.some((m) =>
				m.startsWith('STANDARD_WORKTREE_CLEANUP_SKIPPED_REPROVISIONED'),
			),
		).toBe(true);
	}, 30_000);

	it('normal teardown still removes the lane and live-owner record', async () => {
		seedAwaiting('call-a');
		recordLiveLaneOwner(project, {
			lanePath,
			branchName: BRANCH,
			sessionId: SESSION,
			taskId: '1.1',
		});
		const result = await cleanupStandardWorktreeForCallId(
			'call-a',
			'success',
			project,
		);
		expect(result.removedWorktree).toBe(true);
		expect(result.skippedReprovisioned).toBeUndefined();
		expect(fs.existsSync(lanePath)).toBe(false);
		expect(
			fs.existsSync(path.join(project, '.swarm', 'live-lane-owners.json')),
		).toBe(false);
	}, 30_000);

	it('preserves the live dispatch durable owner record on a skip', async () => {
		seedAwaiting('call-a');
		standardWorktreeByCallID.set('call-b', makeDispatch('call-b'));
		recordLiveLaneOwner(project, {
			lanePath,
			branchName: BRANCH,
			sessionId: SESSION,
			taskId: '1.1',
		});
		await cleanupStandardWorktreeForCallId('call-a', 'success', project);
		const store = JSON.parse(
			fs.readFileSync(
				path.join(project, '.swarm', 'live-lane-owners.json'),
				'utf-8',
			),
		) as { entries: { lanePath: string }[] };
		expect(store.entries.some((e) => e.lanePath === lanePath)).toBe(true);
	}, 30_000);

	it('uncertain store skips destruction and retains the tracking entry', async () => {
		seedAwaiting('call-a');
		fs.mkdirSync(ownerDir(), { recursive: true });
		fs.writeFileSync(path.join(ownerDir(), 'garbage.json'), 'x'.repeat(600));
		const result = await cleanupStandardWorktreeForCallId(
			'call-a',
			'success',
			project,
		);
		expect(result.skippedOwnershipUncertain).toBe(true);
		expect(fs.existsSync(lanePath)).toBe(true);
		expect(awaitingMergeByCallID.has('call-a')).toBe(true);
	}, 30_000);

	it('fails toward preservation when the lifecycle lock is held', async () => {
		seedAwaiting('call-a');
		const acquired = await _internals.tryAcquireWorktreeLifecycleLock(
			project,
			'.swarm/locks/init-orphan-recovery.lock',
			'probe-holder',
			'1.1',
		);
		expect(acquired.acquired).toBe(true);
		try {
			const result = await cleanupStandardWorktreeForCallId(
				'call-a',
				'success',
				project,
			);
			expect(result.skippedOwnershipUncertain).toBe(true);
			expect(fs.existsSync(lanePath)).toBe(true);
			const ref = await gitSpawn(
				['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`],
				project,
			);
			expect(ref.exitCode).toBe(0);
			expect(
				ensureAgentSession(SESSION).pendingAdvisoryMessages?.some((m) =>
					m.includes('STANDARD_WORKTREE_CLEANUP_LOCK_BUSY_PRESERVED'),
				),
			).toBe(true);
		} finally {
			await acquired.lock._release?.();
		}
	}, 60_000);
});
