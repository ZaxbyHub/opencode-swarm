import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	ensureAgentSession,
	getModifiedFilesForTask,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';
import {
	beginCoderSettlement,
	releaseCoderDispatchOwnership,
} from '../../../src/workflow/coder-settlement';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 256 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git exited ${result.status}`,
		);
	}
	return result.stdout.trim();
}

describe('background coder standard-worktree completion', () => {
	let directory = '';
	let worktreePath = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('swarm-bg-coder-worktree-');
		directory = safe.dir;
		cleanup = safe.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n.swarm-worktrees/\n',
		);
		worktreePath = path.join(directory, '.swarm-worktrees', 'lane-1');
		fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
		git(directory, [
			'worktree',
			'add',
			'-b',
			'swarm/lane/background-coder',
			worktreePath,
			'HEAD',
		]);
	});

	afterEach(() => {
		releaseCoderDispatchOwnership(
			directory,
			'4.2',
			'coder:worktree-mixed-call',
		);
		resetSwarmState();
		cleanup();
	});

	test('merges, attributes, advances, and consumes one trusted completion', async () => {
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '4.1';
		session.lastCoderDelegationTaskId = '4.1';
		const baseline = captureWorkspaceSnapshot(worktreePath);
		await recordPendingDelegation(directory, {
			correlationId: 'worktree-coder',
			jobId: 'worktree-job',
			subagentSessionId: 'worktree-coder',
			parentSessionId: 'parent',
			callID: 'worktree-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '4.1',
			evidenceTaskId: '4.1',
			workspace: baseline,
			taskChangeContext: {
				declaredFiles: ['src/worktree-feature.ts'],
				baseline,
			},
			worktree: {
				callID: 'worktree-call',
				parentSessionId: 'parent',
				taskId: '4.1',
				planTaskId: '4.1',
				worktreePath,
				branchName: 'swarm/lane/background-coder',
				worktreeId: 'lane-1',
				worktreeSessionId: 'worktree-coder',
				mergeStrategy: 'merge',
				laneIndex: 0,
				worktreeDir: null,
			},
		});
		fs.mkdirSync(path.join(worktreePath, 'src'));
		fs.writeFileSync(
			path.join(worktreePath, 'src', 'worktree-feature.ts'),
			'export const worktreeFeature = true;\n',
		);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: 'parent',
						text:
							'<task id="worktree-coder" state="completed">\n' +
							'<task_result>done</task_result>\n</task>',
					},
				},
			},
		});

		const settled = findByCorrelationId(directory, 'worktree-coder');
		expect(settled?.status).toBe('consumed');
		expect(settled?.coderSettlement?.state).toBe('settled');
		expect(settled?.coderSettlement?.outcome?.result).toBe('merged');
		expect(
			fs.readFileSync(
				path.join(directory, 'src', 'worktree-feature.ts'),
				'utf8',
			),
		).toContain('worktreeFeature');
		expect(getTaskState(session, '4.1')).toBe('coder_delegated');
		expect(getModifiedFilesForTask(session, '4.1')).toEqual([
			'src/worktree-feature.ts',
		]);
		expect(fs.existsSync(worktreePath)).toBe(false);
	});

	test('mixed foreground WAL transfers without a second worktree cleanup', async () => {
		const taskId = '4.2';
		const callID = 'worktree-mixed-call';
		const correlationId = 'worktree-mixed-coder';
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = taskId;
		session.lastCoderDelegationTaskId = taskId;
		const baseline = captureWorkspaceSnapshot(worktreePath);
		const descriptor = {
			callID,
			parentSessionId: 'parent',
			taskId,
			planTaskId: taskId,
			worktreePath,
			branchName: 'swarm/lane/background-coder',
			worktreeId: 'lane-1',
			worktreeSessionId: correlationId,
			mergeStrategy: 'merge' as const,
			laneIndex: 0,
			worktreeDir: null,
		};
		await beginCoderSettlement({
			directory,
			taskId,
			transitionId: `coder:${callID}`,
			actor: 'parent',
			expectedGeneration: 0,
			context: {
				declaredFiles: ['src/mixed-worktree-feature.ts'],
				baseline,
				workflowGeneration: 0,
			},
			worktree: descriptor,
		});
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: 'worktree-mixed-job',
			subagentSessionId: correlationId,
			parentSessionId: 'parent',
			callID,
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: taskId,
			evidenceTaskId: taskId,
			workspace: baseline,
			taskChangeContext: {
				declaredFiles: ['src/mixed-worktree-feature.ts'],
				baseline,
			},
			worktree: descriptor,
		});
		fs.mkdirSync(path.join(worktreePath, 'src'));
		fs.writeFileSync(
			path.join(worktreePath, 'src', 'mixed-worktree-feature.ts'),
			'export const mixedWorktreeFeature = true;\n',
		);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: 'parent',
						text: `<task id="${correlationId}" state="completed"><task_result>done</task_result></task>`,
					},
				},
			},
		});

		const legacyWal = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'coder-settlements', `${taskId}.json`),
				'utf8',
			),
		) as Record<string, unknown>;
		expect(legacyWal).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
		expect(fs.existsSync(worktreePath)).toBe(false);
		expect(
			fs.readFileSync(
				path.join(directory, 'src', 'mixed-worktree-feature.ts'),
				'utf8',
			),
		).toContain('mixedWorktreeFeature');
	});
});
