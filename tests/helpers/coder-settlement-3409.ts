import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
} from '../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../src/background/workspace-snapshot';
import {
	beginCoderSettlement,
	recordCoderMergeProvenance,
} from '../../src/workflow/coder-settlement';
import type { CoderSettlementWal } from '../../src/workflow/workflow-wal-schema';
import { canonicalTmpDir } from './tmpdir.js';

export const TASK = '1.1';
export function git(directory: string, args: string[]): string {
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

export function fixture(label: string) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(canonicalTmpDir(), `settlement-extra-${label}-`)),
	);
	const repo = path.join(root, 'repo');
	const lane = path.join(root, 'lane');
	fs.mkdirSync(repo);
	git(repo, ['init', '--initial-branch=main']);
	git(repo, ['config', 'user.email', 'test@example.invalid']);
	git(repo, ['config', 'user.name', 'Tests']);
	git(repo, ['config', 'core.autocrlf', 'false']);
	fs.writeFileSync(path.join(repo, 'source.txt'), 'base\n');
	git(repo, ['add', '.']);
	git(repo, ['commit', '-m', 'base']);
	const branch = `swarm-lane/session-${label}/lane-1`;
	git(repo, ['worktree', 'add', '-b', branch, lane]);
	const transitionId = `coder:${label}`;
	const context: BackgroundTaskChangeContext = {
		declaredFiles: ['source.txt'],
		baseline: captureWorkspaceSnapshot(lane),
		workflowGeneration: 0,
	};
	const descriptor: BackgroundWorktreeDescriptor = {
		callID: `call-${label}`,
		parentSessionId: `parent-${label}`,
		taskId: TASK,
		planTaskId: TASK,
		worktreePath: lane,
		branchName: branch,
		worktreeId: 'lane-1',
		worktreeSessionId: `session-${label}`,
		mergeStrategy: 'merge',
		laneIndex: 1,
		worktreeDir: null,
	};
	return { root, repo, lane, branch, transitionId, context, descriptor };
}
export type Fixture = ReturnType<typeof fixture>;
export function begin(f: Fixture): Promise<void> {
	return beginCoderSettlement({
		directory: f.repo,
		taskId: TASK,
		transitionId: f.transitionId,
		actor: 'architect',
		expectedGeneration: 0,
		context: f.context,
		worktree: f.descriptor,
	});
}
export function walPath(f: Fixture): string {
	return path.join(f.repo, '.swarm', 'coder-settlements', `${TASK}.json`);
}
export function readWal(f: Fixture): CoderSettlementWal {
	return JSON.parse(fs.readFileSync(walPath(f), 'utf8')) as CoderSettlementWal;
}
export async function interrupted(f: Fixture): Promise<string> {
	await begin(f);
	fs.writeFileSync(path.join(f.lane, 'source.txt'), 'source change\n');
	git(f.lane, ['add', '.']);
	git(f.lane, ['commit', '-m', 'source']);
	const source = git(f.lane, ['rev-parse', 'HEAD']);
	await recordCoderMergeProvenance({
		directory: f.repo,
		taskId: TASK,
		transitionId: f.transitionId,
		provenance: {
			operationId: f.transitionId,
			sourceHead: source,
			targetHeadBefore: git(f.repo, ['rev-parse', 'HEAD']),
			branchName: f.branch,
			strategy: 'merge',
		},
		observedFiles: ['source.txt'],
	});
	return source;
}
export function removeLane(f: Fixture): void {
	git(f.repo, ['worktree', 'remove', '--force', f.lane]);
	git(f.repo, ['branch', '-D', f.branch]);
}
export function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
