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
import { _internals as settlementSourceInternals } from '../../../src/worktree/settlement-source-recovery';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

const TASK_ID = '1.1';
const originalSettlementBunSpawn = settlementSourceInternals.bunSpawn;
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
	settlementSourceInternals.bunSpawn = originalSettlementBunSpawn;
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

		// The surviving source is the recovery input: recovery restores the lane
		// branch from it and lands the 'merge' dispatch in the #2508
		// squash-unstaged shape. It never aborts the settlement and never rejects.
		const recovered = await recoverCoderSettlement(f.repo, TASK_ID);
		expect(recovered).not.toBeNull();
		expect(recovered?.accepted).toBe(true);
		const wal = JSON.parse(fs.readFileSync(walPath(f), 'utf8')) as {
			state: string;
			cleanupComplete?: boolean;
			worktree?: { landedUnstaged?: boolean };
		};
		expect(wal.state).toBe('COMMITTED');
		expect(wal.worktree?.landedUnstaged).toBe(true);
		expect(wal.cleanupComplete).toBe(true);
		// Unstaged landing: HEAD does not move and the source is not an ancestor;
		// the lane bytes are present in the primary working tree only.
		expect(git(f.repo, ['rev-parse', 'HEAD'])).toBe(
			provenance.targetHeadBefore,
		);
		expect(fs.readFileSync(path.join(f.repo, 'source.txt'), 'utf8')).toBe(
			'lane change\n',
		);
		// The restored lane branch is retained as the backup for unstaged bytes.
		expect(git(f.repo, ['rev-parse', '--verify', f.branch])).toBe(
			provenance.sourceHead,
		);
		expect(
			git(f.repo, [
				'rev-parse',
				`refs/swarm/coder-settlements/${provenance.sourceHead}`,
			]),
		).toBe(provenance.sourceHead);
	});

	test('a source that reappears before the self-heal stays pending and is backed up', async () => {
		const f = fixture('reappeared');
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
		// The first source probe reports a clean absence (quiet miss on a healthy
		// object store); the self-heal's own re-probe under the settlement lock is
		// real and finds the commit. The guard must keep the settlement pending.
		let sourceProbes = 0;
		settlementSourceInternals.bunSpawn = ((cmd, opts) => {
			const args = cmd.slice(1);
			const isSourceProbe =
				args[0] === 'rev-parse' &&
				args[1] === '--verify' &&
				args[2] === '--quiet' &&
				args[3] === `${provenance.sourceHead}^{commit}`;
			const fakeAbsence = isSourceProbe && ++sourceProbes === 1;
			return originalSettlementBunSpawn(
				fakeAbsence
					? [cmd[0], 'rev-parse', '--verify', '--quiet', 'refs/heads/none']
					: cmd,
				opts,
			);
		}) as typeof originalSettlementBunSpawn;
		await expect(recoverCoderSettlement(f.repo, TASK_ID)).rejects.toThrow(
			/RECOVERABLE_ORPHAN_COMMIT: .*settlement remains pending/,
		);
		expect(sourceProbes).toBe(2);
		const wal = JSON.parse(fs.readFileSync(walPath(f), 'utf8')) as Record<
			string,
			unknown
		>;
		expect(wal.state).toBe('DISPATCHED');
		expect(wal.abortReason).toBeUndefined();
		expect(
			git(f.repo, [
				'rev-parse',
				`refs/swarm/coder-settlements/${provenance.sourceHead}`,
			]),
		).toBe(provenance.sourceHead);
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
		// The source-presence probe fails loudly (a Git error, not a quiet miss), as
		// it does for an unreadable object store. Git cannot say whether the
		// WAL's recorded commit is present, so recovery must keep the settlement
		// pending instead of treating that uncertainty as absence. Only the probe
		// for this exact source is swapped; every other Git call is real.
		const probe = ['rev-parse', '--verify', '--quiet'];
		settlementSourceInternals.bunSpawn = ((cmd, opts) => {
			const args = cmd.slice(1);
			const isSourceProbe =
				probe.every((arg, index) => args[index] === arg) &&
				args[3] === `${provenance.sourceHead}^{commit}`;
			return originalSettlementBunSpawn(
				isSourceProbe
					? [cmd[0], 'rev-parse', '--verify', 'refs/heads/no-such-object-db']
					: cmd,
				opts,
			);
		}) as typeof originalSettlementBunSpawn;
		try {
			await expect(recoverCoderSettlement(f.repo, TASK_ID)).rejects.toThrow(
				'CODER_SETTLEMENT_SOURCE_UNCERTAIN',
			);
		} finally {
			settlementSourceInternals.bunSpawn = originalSettlementBunSpawn;
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
