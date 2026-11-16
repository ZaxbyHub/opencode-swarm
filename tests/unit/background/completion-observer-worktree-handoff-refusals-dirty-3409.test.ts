/**
 * Dirty-lane refusal fences for issue #3409 background settlement handoff.
 *
 * finishPublishedCoderWorktree has two independent dirty-lane guards: one
 * before the handoff ('lane is dirty or could not be inspected') and one after
 * it ('lane changed during handoff'). Each test dirties the lane at a different
 * moment so removing exactly one guard changes an observable side effect.
 *
 * The refusal reason text is deliberately not asserted: it reaches only the
 * per-event advisory inbox, which is write-once, and the settle run that
 * precedes any reconcile has already published that event's advisory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	createBackgroundCompletionObserver,
	_internals as observerInternals,
} from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	resetStandardWorktreeIsolationState,
	_internals as worktreeInternals,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	beginCoderSettlement,
	releaseCoderDispatchOwnership,
} from '../../../src/workflow/coder-settlement';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK_ID = '4.2';
const CALL_ID = 'handoff-dirty-call';
const CORRELATION_ID = 'handoff-dirty-coder';
const TRANSITION_ID = `coder:${CALL_ID}`;
const BRANCH = 'swarm/lane/handoff-dirty';
const realTransfer = observerInternals.transferCoderSettlementToBackground;
const realRemove = worktreeInternals.removeWorktree;

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 30_000,
		maxBuffer: 256 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git exited ${result.status}`,
		);
	}
	return result.stdout.trim();
}

describe('#3409 background handoff dirty-lane guards', () => {
	let directory = '';
	let worktreePath = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('bg-handoff-dirty-3409-');
		directory = safe.dir;
		cleanup = safe.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		git(directory, ['init', '--initial-branch=main']);
		git(directory, ['config', 'user.email', 'tests@example.invalid']);
		git(directory, ['config', 'user.name', 'Tests']);
		git(directory, ['config', 'core.autocrlf', 'false']);
		git(directory, ['config', 'commit.gpgsign', 'false']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n.swarm-worktrees/\n',
		);
		worktreePath = path.join(directory, '.swarm-worktrees', 'lane-1');
		fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
		git(directory, ['worktree', 'add', '-b', BRANCH, worktreePath, 'HEAD']);
	});

	afterEach(() => {
		observerInternals.transferCoderSettlementToBackground = realTransfer;
		worktreeInternals.removeWorktree = realRemove;
		releaseCoderDispatchOwnership(directory, TASK_ID, TRANSITION_ID);
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		cleanup();
	});

	/** Registers the lane, completes the coder with cleanup refused, returns the settled record. */
	async function settleWithLaneRetained() {
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = TASK_ID;
		session.lastCoderDelegationTaskId = TASK_ID;
		const baseline = captureWorkspaceSnapshot(worktreePath);
		const descriptor = {
			callID: CALL_ID,
			parentSessionId: 'parent',
			taskId: TASK_ID,
			planTaskId: TASK_ID,
			worktreePath,
			branchName: BRANCH,
			worktreeId: 'lane-1',
			worktreeSessionId: CORRELATION_ID,
			mergeStrategy: 'merge' as const,
			laneIndex: 0,
			worktreeDir: null,
		};
		await beginCoderSettlement({
			directory,
			taskId: TASK_ID,
			transitionId: TRANSITION_ID,
			actor: 'parent',
			expectedGeneration: 0,
			context: {
				declaredFiles: ['src/handoff-feature.ts'],
				baseline,
				workflowGeneration: 0,
			},
			worktree: descriptor,
		});
		await recordPendingDelegation(directory, {
			correlationId: CORRELATION_ID,
			jobId: 'handoff-dirty-job',
			subagentSessionId: CORRELATION_ID,
			parentSessionId: 'parent',
			callID: CALL_ID,
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: TASK_ID,
			evidenceTaskId: TASK_ID,
			workspace: baseline,
			taskChangeContext: {
				declaredFiles: ['src/handoff-feature.ts'],
				baseline,
			},
			worktree: descriptor,
		});
		fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(worktreePath, 'src', 'handoff-feature.ts'),
			'export const handoffFeature = true;\n',
		);
		worktreeInternals.removeWorktree = async () => ({
			error: 'injected cleanup refusal',
		});
		await createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		}).event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: 'parent',
						text: `<task id="${CORRELATION_ID}" state="completed"><task_result>done</task_result></task>`,
					},
				},
			},
		});
		const settled = findByCorrelationId(directory, CORRELATION_ID);
		expect(settled?.coderSettlement?.state).toBe('settled');
		expect(fs.existsSync(worktreePath)).toBe(true);
		return settled!;
	}

	test('a lane dirtied before reconciliation is refused by the pre-handoff guard without entering handoff', async () => {
		const settled = await settleWithLaneRetained();
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		fs.writeFileSync(path.join(worktreePath, 'dirty.txt'), 'keep this lane\n');
		let transferAttempts = 0;
		observerInternals.transferCoderSettlementToBackground = async (...args) => {
			transferAttempts += 1;
			return realTransfer(...args);
		};
		let removalAttempts = 0;
		worktreeInternals.removeWorktree = async (...args) => {
			removalAttempts += 1;
			return realRemove(...args);
		};

		const recovered = await observer.reconcilePending(settled);

		expect(recovered).toBe(false);
		// Without the pre-handoff guard the post-handoff guard still refuses, so
		// only the handoff side effect distinguishes the two.
		expect(transferAttempts).toBe(0);
		expect(removalAttempts).toBe(0);
		expect(fs.readFileSync(path.join(worktreePath, 'dirty.txt'), 'utf8')).toBe(
			'keep this lane\n',
		);
	});

	test('a lane that is clean at first inspection but dirtied during handoff is refused by the post-handoff guard', async () => {
		const settled = await settleWithLaneRetained();
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		let transferAttempts = 0;
		observerInternals.transferCoderSettlementToBackground = async (...args) => {
			transferAttempts += 1;
			// The lane was clean when the pre-handoff guard inspected it; work
			// lands only once the handoff has run.
			const outcome = await realTransfer(...args);
			fs.writeFileSync(
				path.join(worktreePath, 'late-dirty.txt'),
				'late lane work\n',
			);
			return outcome;
		};
		let removalAttempts = 0;
		worktreeInternals.removeWorktree = async (...args) => {
			removalAttempts += 1;
			return realRemove(...args);
		};

		const recovered = await observer.reconcilePending(settled);

		expect(recovered).toBe(false);
		// Handoff really ran, so the first guard passed and the second one refused
		// before ownership was installed and before any removal was attempted.
		expect(transferAttempts).toBe(1);
		expect(removalAttempts).toBe(0);
		expect(fs.existsSync(worktreePath)).toBe(true);
		expect(
			fs.readFileSync(path.join(worktreePath, 'late-dirty.txt'), 'utf8'),
		).toBe('late lane work\n');
	});
});
