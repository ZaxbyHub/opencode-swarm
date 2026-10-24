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
	_internals,
	beginCoderSettlement,
	recordCoderMergeProvenance,
	recoverCoderSettlement,
} from '../../../src/workflow/coder-settlement';
import type { MergeOperationProvenance } from '../../../src/worktree/merge';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

const TASK_ID = '1.1';
const roots: string[] = [];
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

interface Fixture {
	root: string;
	repo: string;
	worktree: string;
	branch: string;
	transitionId: string;
	descriptor: BackgroundWorktreeDescriptor;
	context: BackgroundTaskChangeContext;
}

function fixture(label: string): Fixture {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(canonicalTmpDir(), `settle-3409-${label}-`)),
	);
	roots.push(root);
	const repo = path.join(root, 'repo');
	const worktree = path.join(root, 'lane');
	fs.mkdirSync(repo);
	git(repo, ['init', '--initial-branch=main']);
	git(repo, ['config', 'user.email', 'tests@example.invalid']);
	git(repo, ['config', 'user.name', 'Tests']);
	git(repo, ['config', 'core.autocrlf', 'false']);
	fs.writeFileSync(path.join(repo, 'source.txt'), 'base\n');
	fs.writeFileSync(path.join(repo, 'target.txt'), 'base\n');
	git(repo, ['add', '.']);
	git(repo, ['commit', '-m', 'base']);
	const branch = `swarm-lane/session-${label}/lane-1`;
	git(repo, ['worktree', 'add', '-b', branch, worktree]);
	const transitionId = `coder:${label}`;
	const context: BackgroundTaskChangeContext = {
		declaredFiles: ['source.txt'],
		baseline: captureWorkspaceSnapshot(worktree),
		workflowGeneration: 0,
	};
	const descriptor: BackgroundWorktreeDescriptor = {
		callID: `call-${label}`,
		parentSessionId: `parent-${label}`,
		taskId: TASK_ID,
		planTaskId: TASK_ID,
		worktreePath: worktree,
		branchName: branch,
		worktreeId: 'lane-1',
		worktreeSessionId: `session-${label}`,
		mergeStrategy: 'merge',
		laneIndex: 1,
		worktreeDir: null,
	};
	return { root, repo, worktree, branch, transitionId, descriptor, context };
}

function commitSource(f: Fixture): MergeOperationProvenance {
	fs.writeFileSync(path.join(f.worktree, 'source.txt'), 'lane change\n');
	git(f.worktree, ['add', 'source.txt']);
	git(f.worktree, ['commit', '-m', 'lane source commit']);
	return {
		operationId: f.transitionId,
		sourceHead: git(f.worktree, ['rev-parse', 'HEAD']),
		targetHeadBefore: git(f.repo, ['rev-parse', 'HEAD']),
		branchName: f.branch,
		strategy: 'merge',
	};
}

function walPath(f: Fixture): string {
	return path.join(f.repo, '.swarm', 'coder-settlements', `${TASK_ID}.json`);
}

async function begin(f: Fixture): Promise<void> {
	await beginCoderSettlement({
		directory: f.repo,
		taskId: TASK_ID,
		transitionId: f.transitionId,
		actor: 'architect',
		expectedGeneration: 0,
		context: f.context,
		worktree: f.descriptor,
	});
}

beforeEach(() => {
	_internals.liveDispatches.clear();
});
afterEach(() => {
	_internals.liveDispatches.clear();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe('issue #3409 coder settlement orphan recovery', () => {
	test('an unmerged source commit survives when both lane directory and branch disappear', async () => {
		const f = fixture('orphan');
		await begin(f);
		const provenance = commitSource(f);
		await recordCoderMergeProvenance({
			directory: f.repo,
			taskId: TASK_ID,
			transitionId: f.transitionId,
			provenance,
			observedFiles: ['source.txt'],
		});
		_internals.liveDispatches.clear();
		git(f.repo, ['worktree', 'remove', '--force', f.worktree]);
		git(f.repo, ['branch', '-D', f.branch]);
		expect(git(f.repo, ['cat-file', '-t', provenance.sourceHead])).toBe(
			'commit',
		);

		let recoveryError: unknown;
		try {
			await recoverCoderSettlement(f.repo, TASK_ID);
		} catch (error) {
			recoveryError = error;
		}
		const wal = JSON.parse(fs.readFileSync(walPath(f), 'utf8')) as Record<
			string,
			unknown
		>;
		const state = wal.state;
		const branchHead = spawnSync(
			'git',
			['-C', f.repo, 'rev-parse', '--verify', f.branch],
			{
				cwd: f.repo,
				stdio: ['ignore', 'pipe', 'ignore'],
				encoding: 'utf8',
				timeout: 10_000,
				windowsHide: true,
			},
		);
		const ancestry = spawnSync(
			'git',
			[
				'-C',
				f.repo,
				'merge-base',
				'--is-ancestor',
				provenance.sourceHead,
				'HEAD',
			],
			{
				cwd: f.repo,
				stdio: ['ignore', 'ignore', 'ignore'],
				timeout: 10_000,
				windowsHide: true,
			},
		);
		if (ancestry.error) throw ancestry.error;
		const landed = ancestry.status === 0;
		// Recovery may safely land the recorded source itself. Otherwise it must leave
		// the non-terminal WAL intact and a durable named ref for the orphaned commit.
		expect(state).not.toBe('ABORTED');
		if (!landed) {
			expect(String(recoveryError)).toContain('RECOVERABLE_ORPHAN_COMMIT');
			expect(wal.state).toBe('DISPATCHED');
			expect(branchHead.status).toBe(0);
			expect(branchHead.stdout.trim()).toBe(provenance.sourceHead);
		} else {
			expect(fs.readFileSync(path.join(f.repo, 'source.txt'), 'utf8')).toBe(
				'lane change\n',
			);
			expect(wal.state).toBe('COMMITTED');
		}
	});

	test('partial merge failure leaves the dispatched lane commit reachable for retry', async () => {
		const f = fixture('partial');
		await begin(f);
		const provenance = commitSource(f);
		await recordCoderMergeProvenance({
			directory: f.repo,
			taskId: TASK_ID,
			transitionId: f.transitionId,
			provenance,
			observedFiles: ['source.txt'],
		});
		fs.writeFileSync(
			path.join(f.repo, 'source.txt'),
			'target conflicting change\n',
		);
		git(f.repo, ['add', 'source.txt']);
		git(f.repo, ['commit', '-m', 'target conflict']);
		_internals.liveDispatches.clear();

		await expect(recoverCoderSettlement(f.repo, TASK_ID)).rejects.toThrow(
			/MERGE_RECOVERY_REQUIRED|RECOVERY_UNCERTAIN/,
		);
		expect(fs.existsSync(f.worktree)).toBe(true);
		expect(
			git(f.repo, ['show-ref', '--verify', `refs/heads/${f.branch}`]),
		).toContain(provenance.sourceHead);
		expect(
			(
				JSON.parse(fs.readFileSync(walPath(f), 'utf8')) as Record<
					string,
					unknown
				>
			).state,
		).toBe('DISPATCHED');
	});

	test('an unreadable source object database does not make an orphan safe to abort', async () => {
		const f = fixture('indeterminate-odb');
		await begin(f);
		const provenance = commitSource(f);
		await recordCoderMergeProvenance({
			directory: f.repo,
			taskId: TASK_ID,
			transitionId: f.transitionId,
			provenance,
			observedFiles: ['source.txt'],
		});
		_internals.liveDispatches.clear();
		git(f.repo, ['worktree', 'remove', '--force', f.worktree]);
		git(f.repo, ['branch', '-D', f.branch]);
		// Point Git at a regular file as its object directory. Git cannot determine
		// whether the WAL's recorded commit is present, so recovery must preserve
		// the pending settlement instead of treating that uncertainty as absence.
		const invalidObjectDirectory = path.join(f.root, 'not-an-object-directory');
		fs.writeFileSync(invalidObjectDirectory, 'unreadable object database');
		const previousObjectDirectory = process.env.GIT_OBJECT_DIRECTORY;
		process.env.GIT_OBJECT_DIRECTORY = invalidObjectDirectory;
		try {
			await expect(recoverCoderSettlement(f.repo, TASK_ID)).rejects.toThrow();
		} finally {
			if (previousObjectDirectory === undefined) {
				delete process.env.GIT_OBJECT_DIRECTORY;
			} else {
				process.env.GIT_OBJECT_DIRECTORY = previousObjectDirectory;
			}
		}
		expect(
			(
				JSON.parse(fs.readFileSync(walPath(f), 'utf8')) as Record<
					string,
					unknown
				>
			).state,
		).toBe('DISPATCHED');
	});
});
