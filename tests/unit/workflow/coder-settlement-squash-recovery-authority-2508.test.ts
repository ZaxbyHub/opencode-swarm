import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	awaitingMergeByCallID,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	recordWorktreeProvisioningOwner,
	scanWorktreeProvisioningOwnersForRecovery,
} from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import {
	lookupWorktreeRecoveryAuthoritiesByTask,
	scanWorktreeRecoveryAuthoritiesForRecovery,
} from '../../../src/hooks/delegation-gate/worktree-recovery-authority';
import {
	_internals,
	beginCoderSettlement,
	recoverCoderSettlement,
} from '../../../src/workflow/coder-settlement';
import type { MergeOperationProvenance } from '../../../src/worktree/merge';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

const TASK_ID = '2508.1';

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
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

function branchExists(directory: string, branch: string): boolean {
	const result = spawnSync(
		'git',
		[
			'-C',
			directory,
			'show-ref',
			'--verify',
			'--quiet',
			`refs/heads/${branch}`,
		],
		{
			cwd: directory,
			stdio: ['ignore', 'ignore', 'ignore'],
			timeout: 10_000,
			windowsHide: true,
		},
	);
	if (result.error) throw result.error;
	return result.status === 0;
}

interface Fixture {
	root: string;
	repo: string;
	worktree: string;
	branch: string;
	callID: string;
	transitionId: string;
	descriptor: BackgroundWorktreeDescriptor;
	context: BackgroundTaskChangeContext;
}

function createFixture(): Fixture {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(canonicalTmpDir(), 'coder-squash-recovery-2508-')),
	);
	const repo = path.join(root, 'repo');
	const worktree = path.join(root, 'lane');
	fs.mkdirSync(repo);
	git(repo, ['init']);
	git(repo, ['config', 'user.email', 'tests@example.com']);
	git(repo, ['config', 'user.name', 'Tests']);
	fs.mkdirSync(path.join(repo, 'src', 'nested'), { recursive: true });
	fs.writeFileSync(
		path.join(repo, 'src', 'nested', 'feature.ts'),
		'export const feature = 1;\n',
	);
	git(repo, ['add', '.']);
	git(repo, ['commit', '-m', 'test: seed']);

	const callID = 'call-2508-squash';
	const transitionId = 'coder:2508-squash';
	const branch = 'swarm-lane/session-2508/lane-1';
	git(repo, ['worktree', 'add', '-b', branch, worktree]);
	const context: BackgroundTaskChangeContext = {
		declaredFiles: ['src'],
		baseline: captureWorkspaceSnapshot(worktree),
		workflowGeneration: 0,
	};
	const descriptor: BackgroundWorktreeDescriptor = {
		callID,
		parentSessionId: 'parent-2508',
		taskId: TASK_ID,
		planTaskId: TASK_ID,
		worktreePath: worktree,
		branchName: branch,
		worktreeId: 'lane-1',
		worktreeSessionId: 'session-2508',
		mergeStrategy: 'squash',
		laneIndex: 1,
		worktreeDir: null,
	};
	return {
		root,
		repo,
		worktree,
		branch,
		callID,
		transitionId,
		descriptor,
		context,
	};
}

function walPath(fixture: Fixture): string {
	return path.join(
		fixture.repo,
		'.swarm',
		'coder-settlements',
		`${TASK_ID}.json`,
	);
}

function readWal(fixture: Fixture): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(walPath(fixture), 'utf8')) as Record<
		string,
		unknown
	>;
}

function prepareLandedSquash(fixture: Fixture): MergeOperationProvenance {
	const changedPath = path.join('src', 'nested', 'feature.ts');
	fs.writeFileSync(
		path.join(fixture.worktree, changedPath),
		'export const feature = 2;\n',
	);
	git(fixture.worktree, ['add', '.']);
	git(fixture.worktree, ['commit', '-m', 'feat: squash mutation']);
	const provenance: MergeOperationProvenance = {
		operationId: fixture.transitionId,
		sourceHead: git(fixture.worktree, ['rev-parse', 'HEAD']),
		targetHeadBefore: git(fixture.repo, ['rev-parse', 'HEAD']),
		branchName: fixture.branch,
		strategy: 'squash',
		resultTree: git(fixture.worktree, ['write-tree']),
		changedPaths: [changedPath],
	};
	// Recreate the crash window after squash application: primary HEAD and index
	// remain at targetHeadBefore while the result tree is visible in the working
	// tree, and the lane branch still owns the immutable source commit.
	fs.copyFileSync(
		path.join(fixture.worktree, changedPath),
		path.join(fixture.repo, changedPath),
	);
	const wal = readWal(fixture);
	fs.writeFileSync(
		walPath(fixture),
		`${JSON.stringify(
			{
				...wal,
				state: 'DISPATCHED',
				processId: 999_999_999,
				observedFiles: [changedPath],
				mergeProvenance: provenance,
			},
			null,
			2,
		)}\n`,
	);
	return provenance;
}

describe('issue #2508 squash recovery authority — regression: CS2-001', () => {
	const roots: string[] = [];

	beforeEach(() => {
		_internals.liveDispatches.clear();
		standardWorktreeByCallID.clear();
		awaitingMergeByCallID.clear();
	});

	afterEach(() => {
		_internals.liveDispatches.clear();
		standardWorktreeByCallID.clear();
		awaitingMergeByCallID.clear();
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('publishes authority before cleanup and retains the squash branch', async () => {
		const fixture = createFixture();
		roots.push(fixture.root);
		await beginCoderSettlement({
			directory: fixture.repo,
			taskId: TASK_ID,
			transitionId: fixture.transitionId,
			actor: 'architect',
			expectedGeneration: 0,
			context: fixture.context,
			worktree: fixture.descriptor,
		});
		recordWorktreeProvisioningOwner(fixture.repo, {
			callID: fixture.callID,
			parentSessionId: fixture.descriptor.parentSessionId,
			worktreeSessionId: fixture.descriptor.worktreeSessionId,
			taskId: TASK_ID,
		});
		const provenance = prepareLandedSquash(fixture);
		_internals.liveDispatches.clear();

		// Before this fix, cleanup retained the branch without durable authority,
		// allowing the orphan sweep to delete the only recovery source.
		const recovered = await recoverCoderSettlement(fixture.repo, TASK_ID);
		expect(recovered).toMatchObject({ accepted: true, alreadyApplied: false });
		expect(fs.existsSync(fixture.worktree)).toBe(false);
		expect(branchExists(fixture.repo, fixture.branch)).toBe(true);
		expect(readWal(fixture)).toMatchObject({
			state: 'COMMITTED',
			cleanupComplete: true,
		});
		expect(scanWorktreeProvisioningOwnersForRecovery(fixture.repo)).toEqual({
			status: 'ok',
			owners: [],
		});

		const authorities = lookupWorktreeRecoveryAuthoritiesByTask(fixture.repo, {
			parentSessionId: fixture.descriptor.parentSessionId,
			taskId: TASK_ID,
		});
		expect(authorities.status).toBe('ok');
		if (authorities.status === 'ok') {
			expect(authorities.authorities).toHaveLength(1);
			expect(authorities.authorities[0]).toMatchObject({
				status: 'preserved',
				immutable: {
					laneBranch: fixture.branch,
					strategy: 'squash',
					resultTree: provenance.resultTree,
					changedPaths: provenance.changedPaths,
				},
			});
		}
		expect(
			scanWorktreeRecoveryAuthoritiesForRecovery(fixture.repo).status,
		).toBe('ok');
	});
});
