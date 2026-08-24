/**
 * Shared fixture for issue #2236 — a coder settlement whose lane worktree
 * directory can be torn down while its branch survives.
 *
 * Lives here rather than inside a test file so the two #2236 workflow suites
 * (recovery behaviour, and the never-terminal-while-branch-exists invariant)
 * can share one real git fixture without either file approaching the FR-006
 * 500-line cap.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
} from '../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../src/background/workspace-snapshot';
import { recordWorktreeProvisioningOwner } from '../../src/hooks/delegation-gate/worktree-provisioning-owner';
import { beginCoderSettlement } from '../../src/workflow/coder-settlement';
import { canonicalMkdtemp } from './tmpdir.js';

export const STALE_WORKTREE_TASK_ID = '1.1';

export interface Fixture {
	root: string;
	repo: string;
	worktree: string;
	branch: string;
	callID: string;
	transitionId: string;
	descriptor: BackgroundWorktreeDescriptor;
	context: BackgroundTaskChangeContext;
}

/** Runs git and returns trimmed stdout, throwing on any failure. */
export function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 20_000,
		maxBuffer: 256 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

export function branchExists(fixture: Fixture): boolean {
	const result = spawnSync(
		'git',
		[
			'-C',
			fixture.repo,
			'show-ref',
			'--verify',
			'--quiet',
			`refs/heads/${fixture.branch}`,
		],
		{
			cwd: fixture.repo,
			stdio: ['ignore', 'ignore', 'ignore'],
			timeout: 20_000,
			windowsHide: true,
		},
	);
	if (result.error) throw result.error;
	return result.status === 0;
}

export function walPath(fixture: Fixture): string {
	return path.join(
		fixture.repo,
		'.swarm',
		'coder-settlements',
		`${STALE_WORKTREE_TASK_ID}.json`,
	);
}

export function readWal(fixture: Fixture): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(walPath(fixture), 'utf8')) as Record<
		string,
		unknown
	>;
}

/**
 * Creates a real repository with one seeded commit and one registered lane
 * worktree, then opens a DISPATCHED coder settlement against it and records
 * the provisioning-owner marker (both of which the recovery path expects).
 */
export async function createStaleWorktreeFixture(
	label: string,
): Promise<Fixture> {
	const root = canonicalMkdtemp(`coder-stale-wt-${label}-`);
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

	const callID = `call-${label}`;
	const transitionId = `coder:${label}`;
	const branch = `swarm-lane/session-${label}/lane-1`;
	git(repo, ['worktree', 'add', '-b', branch, worktree]);

	const context: BackgroundTaskChangeContext = {
		declaredFiles: ['src'],
		baseline: captureWorkspaceSnapshot(worktree),
		workflowGeneration: 0,
	};
	const descriptor: BackgroundWorktreeDescriptor = {
		callID,
		parentSessionId: `parent-${label}`,
		taskId: STALE_WORKTREE_TASK_ID,
		planTaskId: STALE_WORKTREE_TASK_ID,
		worktreePath: worktree,
		branchName: branch,
		worktreeId: 'lane-1',
		worktreeSessionId: `session-${label}`,
		mergeStrategy: 'merge',
		laneIndex: 1,
		worktreeDir: null,
	};
	const fixture: Fixture = {
		root,
		repo,
		worktree,
		branch,
		callID,
		transitionId,
		descriptor,
		context,
	};

	await beginCoderSettlement({
		directory: repo,
		taskId: STALE_WORKTREE_TASK_ID,
		transitionId,
		actor: 'architect',
		expectedGeneration: 0,
		context,
		worktree: descriptor,
	});
	recordWorktreeProvisioningOwner(repo, {
		callID,
		parentSessionId: descriptor.parentSessionId,
		worktreeSessionId: descriptor.worktreeSessionId,
		taskId: STALE_WORKTREE_TASK_ID,
	});
	return fixture;
}
