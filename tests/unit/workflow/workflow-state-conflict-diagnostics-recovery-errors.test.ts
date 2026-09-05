import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	standardWorktreeByCallID,
	_internals as worktreeIsolationInternals,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	_internals as coderSettlementInternals,
	recoverCoderSettlement,
} from '../../../src/workflow/coder-settlement';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #2202 (closed into #2471): the two remaining bare coder-settlement
 * recovery errors must name the task, transition, WAL path, WAL state and a
 * concrete recovery command, matching the seven enriched siblings. This file
 * extends tests/unit/workflow/workflow-state-conflict-diagnostics.test.ts
 * (the #2195 suite) rather than growing it past the FR-006 500-line cap.
 *
 * Every test drives the REAL recoverCoderSettlement path — WAL read, dead-pid
 * ownership check, scoped attribution, and the merge-back orchestration —
 * never a synthetic error string.
 */
describe('workflow state-conflict error diagnostics — #2202 recovery errors', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('workflow-state-conflict-2202-');
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		coderSettlementInternals.liveDispatches.clear();
		standardWorktreeByCallID.clear();
		worktreeIsolationInternals.awaitingMergeByCallID.clear();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	function git(args: string[]): string {
		const result = spawnSync('git', ['-C', directory, ...args], {
			cwd: directory,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			encoding: 'utf8',
			timeout: 10_000,
			maxBuffer: 128 * 1024,
			windowsHide: true,
		});
		if (result.status !== 0) {
			throw new Error(result.stderr || result.stdout || `git ${args[0]}`);
		}
		return result.stdout.trim();
	}

	/** A pid that has deterministically exited, so the WAL ownership check passes. */
	function deadPid(): number {
		const child = spawnSync('git', ['--version'], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			encoding: 'utf8',
			timeout: 10_000,
			windowsHide: true,
		});
		if (typeof child.pid !== 'number') throw new Error('no dead pid');
		return child.pid;
	}

	function initCleanRepo(): string {
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = 1;\n',
		);
		git(['init']);
		git(['config', 'user.email', 'tests@example.com']);
		git(['config', 'user.name', 'Tests']);
		git(['add', 'src/feature.ts']);
		git(['commit', '-m', 'test: seed']);
		return git(['rev-parse', 'HEAD']);
	}

	function writeWal(kind: string, taskId: string, body: unknown): string {
		const dir = path.join(directory, '.swarm', kind);
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${taskId}.json`);
		fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`);
		return filePath;
	}

	test('CODER_SETTLEMENT_RECOVERY_UNCERTAIN (isolated worktree) names task, transition, WAL path, state and recovery command', async () => {
		const head = initCleanRepo();
		// The worktree path no longer exists, so scopedObservedFiles cannot
		// capture a baseline there and attribution fails closed for real.
		const walPath = writeWal('coder-settlements', '2.1', {
			version: 1,
			state: 'DISPATCHED',
			taskId: '2.1',
			transitionId: 'coder:2.1:3',
			actor: 'coder',
			processId: deadPid(),
			runtimeId: 'runtime-1',
			expectedGeneration: 0,
			recordedAt: '2026-09-04T00:00:00.000Z',
			context: {
				declaredFiles: ['src/feature.ts'],
				baseline: {
					directory,
					gitHead: head,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
			},
			worktree: {
				callID: 'call-2.1',
				parentSessionId: 'sess-a',
				taskId: '2.1',
				planTaskId: null,
				worktreePath: path.join(directory, '.swarm', 'gone-worktree'),
				branchName: 'swarm/lane-2.1',
				worktreeId: 'wt-2.1',
				worktreeSessionId: 'sess-wt-2.1',
				mergeStrategy: 'merge',
				laneIndex: 0,
				worktreeDir: null,
			},
		});

		const error = await recoverCoderSettlement(directory, '2.1').catch(
			(caught: unknown) => caught as Error,
		);

		expect(error.message).toContain('CODER_SETTLEMENT_RECOVERY_UNCERTAIN');
		expect(error.message).toContain('coder:2.1:3');
		expect(error.message).toContain('task 2.1');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('state DISPATCHED');
		expect(error.message).toContain('Run /swarm recover 2.1');
		expect(error.message).toContain('/swarm reset-session');
		expect(error.message).toContain('do not remove the WAL by hand');
	});

	test('CODER_SETTLEMENT_RECOVERY_UNCERTAIN (workspace baseline) names task, transition, WAL path, state and recovery command', async () => {
		initCleanRepo();
		// A clean baseline whose gitHead names a commit this repository never
		// had: not structurally doomed (issue #2214), but the diff against the
		// current head cannot resolve, so attribution stays retryable-uncertain.
		const walPath = writeWal('coder-settlements', '7.2', {
			version: 1,
			state: 'DISPATCHED',
			taskId: '7.2',
			transitionId: 'coder:7.2:5',
			actor: 'coder',
			processId: deadPid(),
			runtimeId: 'runtime-1',
			expectedGeneration: 0,
			recordedAt: '2026-09-04T00:00:00.000Z',
			context: {
				declaredFiles: ['src/feature.ts'],
				baseline: {
					directory,
					gitHead: '0123456789abcdef0123456789abcdef01234567',
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
			},
		});

		const error = await recoverCoderSettlement(directory, '7.2').catch(
			(caught: unknown) => caught as Error,
		);

		expect(error.message).toContain('CODER_SETTLEMENT_RECOVERY_UNCERTAIN');
		expect(error.message).toContain('coder:7.2:5');
		expect(error.message).toContain('task 7.2');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('state DISPATCHED');
		expect(error.message).toContain('Run /swarm recover 7.2');
		expect(error.message).toContain('/swarm reset-session');
		expect(error.message).toContain('do not remove the WAL by hand');
	});

	test('CODER_SETTLEMENT_MERGE_RECOVERY_REQUIRED names task, transition, WAL path, state, merge outcome and recovery command', async () => {
		initCleanRepo();
		// Real linked worktree on its own branch, one commit ahead of the
		// baseline, so scopedObservedFiles resolves non-null observed files.
		const worktreePath = path.join(directory, 'wt-lane');
		const wtResult = spawnSync(
			'git',
			[
				'-C',
				directory,
				'worktree',
				'add',
				worktreePath,
				'-b',
				'swarm/lane-9.1',
			],
			{
				cwd: directory,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				encoding: 'utf8',
				timeout: 30_000,
				maxBuffer: 128 * 1024,
				windowsHide: true,
			},
		);
		if (wtResult.status !== 0)
			throw new Error(wtResult.stderr || 'worktree add');
		const baseline = captureWorkspaceSnapshot(worktreePath);
		// Leave the lane change UNCOMMITTED: finishStandardWorktreeDispatch then
		// drives merge-back through attemptMergeBackFromDirty (the seam below).
		fs.writeFileSync(
			path.join(worktreePath, 'src', 'feature.ts'),
			'export const feature = 2;\n',
		);

		const walPath = writeWal('coder-settlements', '9.1', {
			version: 1,
			state: 'DISPATCHED',
			taskId: '9.1',
			transitionId: 'coder:9.1:1',
			actor: 'coder',
			processId: deadPid(),
			runtimeId: 'runtime-1',
			expectedGeneration: 0,
			recordedAt: '2026-09-04T00:00:00.000Z',
			context: {
				declaredFiles: ['src/feature.ts'],
				baseline,
			},
			worktree: {
				callID: 'call-9.1',
				parentSessionId: 'sess-a',
				taskId: '9.1',
				planTaskId: null,
				worktreePath,
				branchName: 'swarm/lane-9.1',
				worktreeId: 'wt-9.1',
				worktreeSessionId: 'sess-wt-9.1',
				mergeStrategy: 'merge',
				laneIndex: 0,
				worktreeDir: null,
			},
		});

		// recoverCoderSettlement, the WAL handling, the awaitingMerge registry
		// and finishStandardWorktreeDispatch's orchestration all run for real;
		// only the git merge primitive is injected at the module's own
		// _internals seam with a deterministic conflict outcome.
		const savedMerge = worktreeIsolationInternals.attemptMergeBackFromDirty;
		worktreeIsolationInternals.attemptMergeBackFromDirty = (async () => ({
			failed: true as const,
			stage: 'merge-back',
			message: 'Auto-merge failed in fixture: src/feature.ts conflicts',
		})) as typeof worktreeIsolationInternals.attemptMergeBackFromDirty;

		let error: Error;
		try {
			error = await recoverCoderSettlement(directory, '9.1').catch(
				(caught: unknown) => caught as Error,
			);
		} finally {
			worktreeIsolationInternals.attemptMergeBackFromDirty = savedMerge;
		}

		expect(error.message).toContain('CODER_SETTLEMENT_MERGE_RECOVERY_REQUIRED');
		expect(error.message).toContain('coder:9.1:1');
		expect(error.message).toContain('task 9.1');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('state DISPATCHED');
		expect(error.message).toContain('outcome failed');
		expect(error.message).toContain('src/feature.ts conflicts');
		expect(error.message).toContain('Run /swarm recover 9.1');
		expect(error.message).toContain('/swarm reset-session');
		expect(error.message).toContain('do not remove the WAL by hand');
	});

	test('CODER_SETTLEMENT_RECOVERY_UNCERTAIN (landed-merge reconcile failure) names task, transition, WAL path, state and recovery command', async () => {
		const head = initCleanRepo();
		// Pre-set observedFiles: attribution had already succeeded before the
		// crash, so recovery proceeds straight to merge reconciliation. The
		// provenance names well-formed but nonexistent object ids, so
		// reconcileLandedMerge's real `git merge-base --is-ancestor` exits 128
		// and the landed.error branch (not a synthetic stub) produces the
		// recovery-uncertain error.
		const walPath = writeWal('coder-settlements', '4.7', {
			version: 1,
			state: 'DISPATCHED',
			taskId: '4.7',
			transitionId: 'coder:4.7:2',
			actor: 'coder',
			processId: deadPid(),
			runtimeId: 'runtime-1',
			expectedGeneration: 0,
			recordedAt: '2026-09-04T00:00:00.000Z',
			observedFiles: ['src/feature.ts'],
			mergeProvenance: {
				operationId: 'coder:4.7:2',
				sourceHead: '1234567890abcdef1234567890abcdef12345678',
				targetHeadBefore: 'fedcba0987654321fedcba0987654321fedcba09',
				branchName: 'swarm/lane-4.7',
				strategy: 'merge',
			},
			context: {
				declaredFiles: ['src/feature.ts'],
				baseline: {
					directory,
					gitHead: head,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
			},
			worktree: {
				callID: 'call-4.7',
				parentSessionId: 'sess-a',
				taskId: '4.7',
				planTaskId: null,
				worktreePath: path.join(directory, '.swarm', 'gone-worktree'),
				branchName: 'swarm/lane-4.7',
				worktreeId: 'wt-4.7',
				worktreeSessionId: 'sess-wt-4.7',
				mergeStrategy: 'merge',
				laneIndex: 0,
				worktreeDir: null,
			},
		});

		const error = await recoverCoderSettlement(directory, '4.7').catch(
			(caught: unknown) => caught as Error,
		);

		expect(error.message).toContain('CODER_SETTLEMENT_RECOVERY_UNCERTAIN');
		expect(error.message).toContain('could not reconcile the landed merge');
		expect(error.message).toContain('coder:4.7:2');
		expect(error.message).toContain('task 4.7');
		expect(error.message).toContain(walPath);
		expect(error.message).toContain('state DISPATCHED');
		// The underlying deterministic git failure is carried through.
		expect(error.message).toContain('1234567890abcdef1234567890abcdef12345678');
		expect(error.message).toContain('Run /swarm recover 4.7');
		expect(error.message).toContain('/swarm reset-session');
		expect(error.message).toContain('do not remove the WAL by hand');
	});
});
