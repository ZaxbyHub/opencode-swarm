import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	cleanupStandardWorktreeForCallId,
	_internals as isolation,
	resetStandardWorktreeIsolationState,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import type { CoderSettlementWal } from '../../../src/workflow/workflow-wal-schema';
import { removeWorktree } from '../../../src/worktree/core';
import {
	cleanupOrphanedBranches,
	postMergeCleanup,
} from '../../../src/worktree/merge';
import { removeOwnedWorktreeDir } from '../../../src/worktree/ownership';
import { preserveSettlementSource } from '../../../src/worktree/settlement-source-recovery';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let root: string;
let repo: string;
let lane: string;
const branch = 'swarm/lane/cleanup-3409/1.1';
const originals = {
	remove: isolation.removeWorktree,
	postMerge: isolation.postMergeCleanup,
};

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', args, {
		cwd: directory,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 256 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function record(state: CoderSettlementWal['state']): void {
	const wal: CoderSettlementWal = {
		version: 1,
		state,
		taskId: '1.1',
		transitionId: 'cleanup-3409',
		actor: 'architect',
		processId: process.pid,
		runtimeId: 'fixture-runtime',
		expectedGeneration: 0,
		accepted: false,
		context: {
			declaredFiles: ['source.txt'],
			baseline: captureWorkspaceSnapshot(repo),
			workflowGeneration: 0,
		},
		worktree: {
			callID: 'cleanup-call',
			parentSessionId: 'cleanup-session',
			taskId: '1.1',
			worktreePath: lane,
			branchName: branch,
			worktreeId: 'lane-1',
			worktreeSessionId: 'cleanup-session',
			mergeStrategy: 'merge',
			laneIndex: 0,
			worktreeDir: null,
		},
		recordedAt: '2026-10-22T00:00:00.000Z',
	};
	const directory = path.join(repo, '.swarm', 'coder-settlements');
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, '1.1.json'), JSON.stringify(wal));
}

function track(): void {
	ensureAgentSession('cleanup-session');
	standardWorktreeByCallID.set('cleanup-call', {
		callID: 'cleanup-call',
		parentSessionID: 'cleanup-session',
		taskId: '1.1',
		handle: {
			worktreePath: lane,
			branchName: branch,
			purpose: 'lane',
			id: 'lane-1',
			sessionId: 'cleanup-session',
		},
		mergeStrategy: 'merge',
		laneIndex: 0,
	});
}

beforeEach(() => {
	root = canonicalMkdtemp('settlement-sinks-3409-');
	repo = path.join(root, 'repo');
	lane = path.join(repo, '.swarm-worktrees', 'cleanup-session', 'lane-1');
	fs.mkdirSync(repo);
	git(repo, ['init', '--initial-branch=main']);
	git(repo, ['config', 'user.name', 'Tests']);
	git(repo, ['config', 'user.email', 'tests@example.invalid']);
	fs.writeFileSync(path.join(repo, 'source.txt'), 'base\n');
	git(repo, ['add', '.']);
	git(repo, ['commit', '-m', 'base']);
	resetStandardWorktreeIsolationState();
	resetSwarmState();
});

afterEach(() => {
	isolation.removeWorktree = originals.remove;
	isolation.postMergeCleanup = originals.postMerge;
	resetStandardWorktreeIsolationState();
	resetSwarmState();
	fs.rmSync(root, { recursive: true, force: true });
});

describe('settlement cleanup sinks #3409', () => {
	for (const state of ['DISPATCHED', 'PREPARED'] as const) {
		test(`direct removeWorktree preserves a ${state} lane`, async () => {
			git(repo, ['worktree', 'add', '-b', branch, lane]);
			record(state);
			const result = await removeWorktree(lane, repo, { force: true });
			expect('error' in result && result.error).toContain('ARTIFACT_PROTECTED');
			expect(fs.existsSync(path.join(lane, '.git'))).toBe(true);
			expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(branch);
		});

		test(`orphan and direct branch cleanup preserve a branch-only ${state} lane`, async () => {
			git(repo, ['worktree', 'add', '-b', branch, lane]);
			fs.writeFileSync(path.join(lane, 'source.txt'), 'unlanded source\n');
			git(lane, ['commit', '-am', 'unlanded lane work']);
			const source = git(lane, ['rev-parse', 'HEAD']);
			git(repo, ['worktree', 'remove', lane]);
			record(state);
			// No registered checkout can make Git refuse deletion for us: the
			// pending-settlement admission must be the retaining mechanism.
			expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(
				branch,
			);
			const orphan = await cleanupOrphanedBranches(repo);
			expect(orphan.removed).not.toContain(branch);
			expect(
				orphan.errors.some(
					(entry) =>
						entry.branch === branch &&
						entry.error.includes('ARTIFACT_PROTECTED'),
				),
			).toBe(true);
			expect(git(repo, ['rev-parse', branch])).toBe(source);
			const direct = await postMergeCleanup(repo, branch);
			expect('error' in direct && direct.error).toContain('ARTIFACT_PROTECTED');
			expect(git(repo, ['rev-parse', branch])).toBe(source);
		});
	}

	test('ordinary orphan cleanup leaves a content-addressed source backup intact', async () => {
		git(repo, ['branch', branch]);
		const source = git(repo, ['rev-parse', branch]);
		await preserveSettlementSource(repo, source);
		const cleanup = await cleanupOrphanedBranches(repo);
		expect(cleanup.removed).toContain(branch);
		expect(
			git(repo, ['rev-parse', `refs/swarm/coder-settlements/${source}`]),
		).toBe(source);
	});

	test('ownership gitless deletion preserves a pending lane remnant', async () => {
		fs.mkdirSync(lane, { recursive: true });
		fs.writeFileSync(path.join(lane, 'source.txt'), 'recoverable bytes');
		record('DISPATCHED');
		const result = await removeOwnedWorktreeDir(lane, repo);
		expect(result.status).toBe('skipped');
		expect(fs.readFileSync(path.join(lane, 'source.txt'), 'utf8')).toBe(
			'recoverable bytes',
		);
	});

	test('ownership delegates registered terminal removal without nested lock acquisition', async () => {
		git(repo, ['worktree', 'add', '-b', branch, lane]);
		record('COMMITTED');
		const result = await removeOwnedWorktreeDir(lane, repo);
		expect(result).toEqual({ status: 'removed' });
		expect(fs.existsSync(lane)).toBe(false);
	});

	test('typed lower-sink refusal cannot authorize the residual fallback', async () => {
		fs.mkdirSync(lane, { recursive: true });
		fs.writeFileSync(path.join(lane, 'source.txt'), 'retained');
		track();
		isolation.removeWorktree = async () => ({
			error:
				'CODER_SETTLEMENT_ARTIFACT_REMOVAL_REFUSED: uncertain diagnostic: is not a working tree',
		});
		isolation.postMergeCleanup = async () => ({ error: 'retained by fixture' });
		const result = await cleanupStandardWorktreeForCallId(
			'cleanup-call',
			'success',
			repo,
		);
		expect(result.removedWorktree).toBe(false);
		expect(fs.readFileSync(path.join(lane, 'source.txt'), 'utf8')).toBe(
			'retained',
		);
	});

	for (const uncertain of [false, true]) {
		test(`residual fallback refuses ${uncertain ? 'uncertain' : 'pending'} inventory`, async () => {
			fs.mkdirSync(lane, { recursive: true });
			fs.writeFileSync(path.join(lane, 'source.txt'), 'retained');
			record('DISPATCHED');
			if (uncertain)
				fs.writeFileSync(
					path.join(repo, '.swarm', 'coder-settlements', '1.1.json'),
					'{',
				);
			track();
			// Drive the distinct residual fallback after the lower Git removal
			// has returned and released admission, rather than its success path.
			isolation.removeWorktree = async () => ({
				error: 'is not a working tree',
			});
			isolation.postMergeCleanup = async () => ({
				error: 'retained by fixture',
			});
			const result = await cleanupStandardWorktreeForCallId(
				'cleanup-call',
				'success',
				repo,
			);
			expect(result.removedWorktree).toBe(false);
			expect(fs.readFileSync(path.join(lane, 'source.txt'), 'utf8')).toBe(
				'retained',
			);
		});
	}
});
