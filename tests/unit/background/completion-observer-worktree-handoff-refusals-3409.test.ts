/** Failure fences for issue #3409 background settlement handoff. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	createBackgroundCompletionObserver,
	_internals as observerInternals,
} from '../../../src/background/completion-observer';
import {
	claimDelegationIngestion,
	clearLegacyCoderSettlementTransferPending,
	compactBackgroundDelegations,
	findByCorrelationId,
	recordDelegationIngestionResult,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	awaitingMergeByCallID,
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
const CALL_ID = 'handoff-refusal-call';
const CORRELATION_ID = 'handoff-refusal-coder';
const TRANSITION_ID = `coder:${CALL_ID}`;
const BRANCH = 'swarm/lane/handoff-refusal';
const realTransfer = observerInternals.transferCoderSettlementToBackground;
const realMarkTransferPending =
	observerInternals.markLegacyCoderSettlementTransferPending;
const realUpdateSettlement = observerInternals.updateCoderSettlement;
const realSleep = observerInternals.sleep;
const realMerge = worktreeInternals.attemptMergeBackFromDirty;
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

describe('#3409 background handoff refusal fences', () => {
	let directory = '';
	let worktreePath = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('bg-handoff-refusal-3409-');
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
		observerInternals.markLegacyCoderSettlementTransferPending =
			realMarkTransferPending;
		observerInternals.updateCoderSettlement = realUpdateSettlement;
		observerInternals.sleep = realSleep;
		worktreeInternals.attemptMergeBackFromDirty = realMerge;
		worktreeInternals.removeWorktree = realRemove;
		releaseCoderDispatchOwnership(directory, TASK_ID, TRANSITION_ID);
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		cleanup();
	});

	async function register(): Promise<void> {
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
			jobId: 'handoff-refusal-job',
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
	}

	async function complete(): Promise<void> {
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
	}

	test('a returned settling snapshot for another operation cannot authorize handoff', async () => {
		await register();
		const initialHead = git(directory, ['rev-parse', 'HEAD']);
		let mergeAttempts = 0;
		let transferAttempts = 0;
		worktreeInternals.attemptMergeBackFromDirty = async (...args) => {
			mergeAttempts += 1;
			return realMerge(...args);
		};
		observerInternals.transferCoderSettlementToBackground = async (...args) => {
			transferAttempts += 1;
			return realTransfer(...args);
		};
		observerInternals.updateCoderSettlement = async (...args) => {
			const persisted = await realUpdateSettlement(...args);
			if (args[2].state !== 'settling' || !persisted?.coderSettlement)
				return persisted;
			return {
				...persisted,
				coderSettlement: {
					...persisted.coderSettlement,
					operationId: 'foreign-operation',
				},
			};
		};

		await complete();

		// The merge adapter is entered to persist immutable provenance before Git;
		// rejecting its foreign operation snapshot must still prevent handoff.
		expect(mergeAttempts).toBe(1);
		expect(transferAttempts).toBe(0);
		expect(git(directory, ['rev-parse', 'HEAD'])).toBe(initialHead);
		expect(git(directory, ['rev-parse', BRANCH])).not.toBe(initialHead);
		expect(fs.existsSync(worktreePath)).toBe(true);
		expect(
			fs.existsSync(path.join(directory, 'src', 'handoff-feature.ts')),
		).toBe(false);
		expect(
			fs.readFileSync(
				path.join(directory, '.swarm', 'coder-settlements', `${TASK_ID}.json`),
				'utf8',
			),
		).toContain('DISPATCHED');
	});

	test('marker refusal leaves foreground ownership and the lane available', async () => {
		await register();
		const initialHead = git(directory, ['rev-parse', 'HEAD']);
		observerInternals.markLegacyCoderSettlementTransferPending = async () =>
			null;
		observerInternals.sleep = async () => {};

		await complete();

		expect(fs.existsSync(worktreePath)).toBe(true);
		expect(git(directory, ['rev-parse', BRANCH])).not.toBe(initialHead);
		expect(git(directory, ['rev-parse', 'HEAD'])).toBe(initialHead);
		expect(
			fs.readFileSync(
				path.join(directory, '.swarm', 'coder-settlements', `${TASK_ID}.json`),
				'utf8',
			),
		).toContain('DISPATCHED');
	});

	test('a foreign awaiting-merge owner is preserved and blocks reconstructed settlement', async () => {
		await register();
		const foreign = {
			callID: CALL_ID,
			parentSessionID: 'other-parent',
			taskId: '9.1',
			branch: 'swarm/lane/other-owner',
			worktreePath: path.join(directory, 'foreign-lane'),
			mergeStrategy: 'merge' as const,
			queuedAt: 1,
		};
		awaitingMergeByCallID.set(CALL_ID, foreign);

		await complete();

		expect(awaitingMergeByCallID.get(CALL_ID)).toBe(foreign);
		expect(fs.existsSync(worktreePath)).toBe(true);
		expect(
			fs.existsSync(path.join(directory, 'src', 'handoff-feature.ts')),
		).toBe(false);
		expect(
			fs.readFileSync(
				path.join(directory, '.swarm', 'coder-settlements', `${TASK_ID}.json`),
				'utf8',
			),
		).toContain('DISPATCHED');
	});

	test('a foreign tracking owner arriving during handoff is preserved before cleanup', async () => {
		await register();
		worktreeInternals.removeWorktree = async () => ({
			error: 'injected cleanup refusal',
		});
		await complete();
		const settled = findByCorrelationId(directory, CORRELATION_ID);
		expect(settled?.coderSettlement?.state).toBe('settled');
		expect(fs.existsSync(worktreePath)).toBe(true);
		worktreeInternals.removeWorktree = realRemove;
		const foreign = {
			callID: CALL_ID,
			parentSessionID: 'racing-owner',
			taskId: '9.2',
			branch: 'swarm/lane/racing-owner',
			worktreePath: path.join(directory, 'racing-lane'),
			mergeStrategy: 'merge' as const,
			queuedAt: 2,
		};
		observerInternals.transferCoderSettlementToBackground = async (options) => {
			const outcome = await realTransfer(options);
			awaitingMergeByCallID.set(CALL_ID, foreign);
			return outcome;
		};

		const recovered = await createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		}).reconcilePending(settled!);

		expect(recovered).toBe(false);
		expect(awaitingMergeByCallID.get(CALL_ID)).toBe(foreign);
		expect(fs.existsSync(worktreePath)).toBe(true);
		expect(git(directory, ['rev-parse', BRANCH])).toBe(
			settled?.coderSettlement?.sourceHeadAfterCommit,
		);
	});

	for (const remnant of ['dirty lane', 'advanced source branch'] as const) {
		test(`compacted consumed history preserves ${remnant} without replaying a merge`, async () => {
			await register();
			worktreeInternals.removeWorktree = async () => ({
				error: 'injected cleanup refusal',
			});
			await complete();
			const settled = findByCorrelationId(directory, CORRELATION_ID);
			expect(settled?.coderSettlement?.state).toBe('settled');
			expect(fs.existsSync(worktreePath)).toBe(true);

			const markerCleared = await clearLegacyCoderSettlementTransferPending(
				directory,
				CORRELATION_ID,
			);
			expect(markerCleared?.legacyCoderSettlementTransfer).toBeUndefined();
			const ingestion = await claimDelegationIngestion(
				directory,
				CORRELATION_ID,
				{
					claimantId: 'recovery-fixture',
				},
			);
			expect(ingestion?.disposition).toBe('claimed');
			const consumed = await recordDelegationIngestionResult(
				directory,
				CORRELATION_ID,
				ingestion!.record.ingestion!.claimToken,
				true,
			);
			expect(consumed?.status).toBe('consumed');

			if (remnant === 'dirty lane') {
				fs.writeFileSync(
					path.join(worktreePath, 'dirty-remnant.txt'),
					'keep this lane\n',
				);
			} else {
				fs.writeFileSync(
					path.join(worktreePath, 'later.txt'),
					'later source work\n',
				);
				git(worktreePath, ['add', 'later.txt']);
				git(worktreePath, ['commit', '-m', 'test: advance source branch']);
			}
			const cleanupObserver = createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			});
			const prepared = await cleanupObserver.prepareAdvisories('parent');
			if (prepared)
				await cleanupObserver.ackObservedAdvisories(
					'parent',
					prepared.messages,
				);
			const compacted = await compactBackgroundDelegations(directory, {
				force: true,
			});
			expect(compacted.status).toBe('compacted');
			const summary = findByCorrelationId(directory, CORRELATION_ID);
			expect(summary?.taskChangeContext).toBeUndefined();
			expect(summary?.coderSettlement?.provenance.worktree?.branchName).toBe(
				BRANCH,
			);
			const branch = git(directory, ['rev-parse', BRANCH]);
			const recordedSource = summary?.coderSettlement?.sourceHeadAfterCommit;
			if (remnant === 'advanced source branch')
				expect(branch).not.toBe(recordedSource);
			const head = git(directory, ['rev-parse', 'HEAD']);
			const targetBytes = fs.readFileSync(
				path.join(directory, 'src', 'handoff-feature.ts'),
				'utf8',
			);
			let mergeAttempts = 0;
			worktreeInternals.attemptMergeBackFromDirty = async (...args) => {
				mergeAttempts += 1;
				return realMerge(...args);
			};

			const recovered = await createBackgroundCompletionObserver({
				config: { enabled: true },
				directory,
			}).reconcilePending(summary!);

			expect(recovered).toBe(false);
			expect(fs.existsSync(worktreePath)).toBe(true);
			if (remnant === 'dirty lane') {
				expect(
					fs.readFileSync(path.join(worktreePath, 'dirty-remnant.txt'), 'utf8'),
				).toBe('keep this lane\n');
			} else {
				expect(
					fs.readFileSync(path.join(worktreePath, 'later.txt'), 'utf8'),
				).toBe('later source work\n');
				expect(git(directory, ['rev-parse', BRANCH])).toBe(branch);
			}
			expect(git(directory, ['rev-parse', 'HEAD'])).toBe(head);
			expect(
				fs.readFileSync(
					path.join(directory, 'src', 'handoff-feature.ts'),
					'utf8',
				),
			).toBe(targetBytes);
			expect(mergeAttempts).toBe(0);
		});
	}
});
