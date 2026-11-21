/**
 * #3888 r9: an ALREADY-ABORTED settlement whose cleanup is incomplete must
 * retry through fail-closed dirty-work preservation. abortCoderSettlement's
 * retry and recoverCoderSettlement's ABORTED arm both reach
 * completeCoderSettlementCleanup, which must select cancelled semantics for
 * ABORTED WALs — a dirty lane left by an uncertain first attempt is preserved
 * (or the retry aborts), never force-removed unpreserved.
 *
 * The lane sits under the repo's `.swarm-worktrees/` trusted base so the
 * force-removal fallback in removeWorktree is reachable — that is the leg
 * where the unpreserved data loss actually manifests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { recordWorktreeProvisioningOwner } from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import {
	abortCoderSettlement,
	beginCoderSettlement,
} from '../../../src/workflow/coder-settlement';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TASK_ID = '1.1';
const LABEL = 'wt3888ar';

function git(
	cwd: string,
	args: string[],
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

let root: string;
let repo: string;
let worktree: string;
let branch: string;
let transitionId: string;

beforeEach(async () => {
	root = canonicalMkdtemp(`coder-wt3888-abort-${LABEL}-`);
	repo = path.join(root, 'repo');
	fs.mkdirSync(repo);
	await git(repo, ['init', '-q']);
	await git(repo, ['config', 'user.email', 't@t.test']);
	await git(repo, ['config', 'user.name', 'T']);
	fs.mkdirSync(path.join(repo, 'src', 'nested'), { recursive: true });
	fs.writeFileSync(
		path.join(repo, 'src', 'nested', 'feature.ts'),
		'export const feature = 1;\n',
	);
	await git(repo, ['add', '.']);
	await git(repo, ['commit', '-q', '-m', 'seed']);
	// Lane under the repo's trusted .swarm-worktrees base (force-removal
	// fallback reachable).
	branch = `swarm-lane/session-${LABEL}/lane-1`;
	worktree = path.join(repo, '.swarm-worktrees', `session-${LABEL}`, 'lane-1');
	fs.mkdirSync(path.dirname(worktree), { recursive: true });
	const add = await git(repo, ['worktree', 'add', '-b', branch, worktree]);
	expect(add.exitCode).toBe(0);
	const callID = `call-${LABEL}`;
	transitionId = `coder:${LABEL}`;
	const context: BackgroundTaskChangeContext = {
		declaredFiles: ['src'],
		baseline: captureWorkspaceSnapshot(worktree),
		workflowGeneration: 0,
	};
	const descriptor: BackgroundWorktreeDescriptor = {
		callID,
		parentSessionId: `parent-${LABEL}`,
		taskId: TASK_ID,
		planTaskId: TASK_ID,
		worktreePath: worktree,
		branchName: branch,
		worktreeId: 'lane-1',
		worktreeSessionId: `session-${LABEL}`,
		mergeStrategy: 'merge',
		laneIndex: 1,
		worktreeDir: null,
	};
	await beginCoderSettlement({
		directory: repo,
		taskId: TASK_ID,
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
		taskId: TASK_ID,
	});
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('#3888 aborted-retry dirty preservation', () => {
	it('an already-aborted retry with an incomplete-cleanup dirty lane preserves the bytes', async () => {
		// Make the FIRST abort's cleanup uncertain (poisoned owner store), so
		// the WAL is left with cleanup incomplete and the lane on disk.
		const ownersDir = path.join(repo, '.swarm', 'worktree-provisioning-owners');
		fs.mkdirSync(ownersDir, { recursive: true });
		fs.writeFileSync(path.join(ownersDir, 'garbage.json'), 'x'.repeat(600));
		const first = await abortCoderSettlement({
			directory: repo,
			taskId: TASK_ID,
			transitionId,
			reason: 'test abort',
		});
		expect(first).toBe('aborted');
		expect(fs.existsSync(worktree)).toBe(true);
		// Uncertainty clears and DIRTY bytes appear on the retained lane.
		fs.rmSync(path.join(ownersDir, 'garbage.json'));
		fs.writeFileSync(path.join(worktree, 'src', 'precious.txt'), 'precious\n');
		// Retry: the already-aborted path must run dirty-preserving cleanup.
		const second = await abortCoderSettlement({
			directory: repo,
			taskId: TASK_ID,
			transitionId,
			reason: 'retry',
		});
		expect(second).toBe('already-aborted');
		// The dirty bytes must remain recoverable. The repo's established
		// preservation contract (FR-001c) commits dirty work as a
		// `swarm-preserved:` commit anchored by a swarm-preserved-* TAG before
		// removal. Assert the tag EXISTS — the r8 defect force-removed the
		// lane with no preserve attempt at all.
		const tags = await git(repo, ['tag', '-l', 'swarm-preserved-*']);
		const preserved = tags.stdout.trim().length > 0;
		const laneSurvived =
			fs.existsSync(worktree) &&
			fs.existsSync(path.join(worktree, 'src', 'precious.txt'));
		expect(laneSurvived || preserved).toBe(true);
	}, 45_000);
});
