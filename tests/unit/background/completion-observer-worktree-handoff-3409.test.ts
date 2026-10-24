/** Issue #3409 — background completion must hand off foreground ownership before lane teardown. */
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
const CALL_ID = 'worktree-handoff-call';
const CORRELATION_ID = 'worktree-handoff-coder';
const TRANSITION_ID = `coder:${CALL_ID}`;
const BRANCH = 'swarm/lane/background-coder';
const realTransfer = observerInternals.transferCoderSettlementToBackground;
const realSleep = observerInternals.sleep;
const realUpdateCoderSettlement = observerInternals.updateCoderSettlement;
const realAttemptMergeBackFromDirty =
	worktreeInternals.attemptMergeBackFromDirty;
const realRemoveWorktree = worktreeInternals.removeWorktree;

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

describe('#3409 background worktree settlement handoff ordering', () => {
	let directory = '';
	let worktreePath = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('bg-worktree-handoff-3409-');
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
		observerInternals.sleep = realSleep;
		observerInternals.updateCoderSettlement = realUpdateCoderSettlement;
		worktreeInternals.attemptMergeBackFromDirty = realAttemptMergeBackFromDirty;
		worktreeInternals.removeWorktree = realRemoveWorktree;
		releaseCoderDispatchOwnership(directory, TASK_ID, TRANSITION_ID);
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		cleanup();
	});

	async function registerMixedOwnership(
		options: {
			contextBaseline?: ReturnType<typeof captureWorkspaceSnapshot>;
		} = {},
	): Promise<ReturnType<typeof captureWorkspaceSnapshot>> {
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
				declaredFiles: ['src/mixed-worktree-feature.ts'],
				baseline,
				workflowGeneration: 0,
			},
			worktree: descriptor,
		});
		await recordPendingDelegation(directory, {
			correlationId: CORRELATION_ID,
			jobId: 'worktree-mixed-job',
			subagentSessionId: CORRELATION_ID,
			parentSessionId: 'parent',
			callID: CALL_ID,
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: TASK_ID,
			evidenceTaskId: TASK_ID,
			workspace: baseline,
			taskChangeContext: {
				declaredFiles: ['src/mixed-worktree-feature.ts'],
				baseline: options.contextBaseline ?? baseline,
			},
			worktree: descriptor,
		});
		fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(worktreePath, 'src', 'mixed-worktree-feature.ts'),
			'export const mixedWorktreeFeature = true;\n',
		);
		return baseline;
	}

	function readLegacyWal(): Record<string, unknown> {
		return JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'coder-settlements', `${TASK_ID}.json`),
				'utf8',
			),
		) as Record<string, unknown>;
	}

	function observer() {
		return createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
	}

	async function deliverCompletedTerminal(): Promise<void> {
		await observer().event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: 'parent',
						text:
							`<task id="${CORRELATION_ID}" state="completed">` +
							'<task_result>done</task_result></task>',
					},
				},
			},
		});
	}

	test('successful exact foreground-to-background handoff happens while the lane still exists', async () => {
		await registerMixedOwnership();
		const baselineHead = git(directory, ['rev-parse', 'HEAD']);
		let laneExistedAtHandoff: boolean | undefined;
		let legacyStateAtHandoff: unknown;
		observerInternals.transferCoderSettlementToBackground = async (options) => {
			laneExistedAtHandoff = fs.existsSync(worktreePath);
			legacyStateAtHandoff = readLegacyWal().state;
			return realTransfer(options);
		};

		await deliverCompletedTerminal();

		expect(laneExistedAtHandoff).toBe(true);
		expect(legacyStateAtHandoff).toBe('DISPATCHED');
		expect(readLegacyWal()).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
		expect(fs.existsSync(worktreePath)).toBe(false);
		expect(
			fs.readFileSync(
				path.join(directory, 'src', 'mixed-worktree-feature.ts'),
				'utf8',
			),
		).toBe('export const mixedWorktreeFeature = true;\n');
		const headAfterHandoff = git(directory, ['rev-parse', 'HEAD']);
		const sourceBranch = git(directory, ['rev-parse', BRANCH]);
		// squash-unstaged changes target bytes but keeps target HEAD at baseline.
		expect(headAfterHandoff).toBe(baselineHead);

		await deliverCompletedTerminal();

		expect(git(directory, ['rev-parse', 'HEAD'])).toBe(headAfterHandoff);
		expect(git(directory, ['rev-parse', BRANCH])).toBe(sourceBranch);
		expect(fs.existsSync(worktreePath)).toBe(false);
	});

	test('retryable exact-transfer failure leaves settling provenance and lane for durable replay', async () => {
		await registerMixedOwnership();
		const baselineHead = git(directory, ['rev-parse', 'HEAD']);
		let attempts = 0;
		let mergePasses = 0;
		observerInternals.transferCoderSettlementToBackground = async () => {
			attempts += 1;
			throw new Error('CODER_SETTLEMENT_LOCKED: task 4.2');
		};
		observerInternals.sleep = async () => {};
		worktreeInternals.attemptMergeBackFromDirty = async (...args) => {
			mergePasses += 1;
			return realAttemptMergeBackFromDirty(...args);
		};

		await deliverCompletedTerminal();

		const pending = findByCorrelationId(directory, CORRELATION_ID);
		expect(attempts).toBeGreaterThan(0);
		const sourceHead = pending?.coderSettlement?.sourceHeadAfterCommit;
		expect(pending?.coderSettlement).toMatchObject({
			state: 'settling',
			operationId: expect.any(String),
		});
		expect(sourceHead).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
		expect(pending?.coderSettlement?.targetHeadBeforeMerge).toMatch(
			/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
		);
		expect(pending?.legacyCoderSettlementTransfer).toMatchObject({
			taskId: TASK_ID,
			transitionId: TRANSITION_ID,
		});
		expect(readLegacyWal().state).toBe('DISPATCHED');
		expect(fs.existsSync(worktreePath)).toBe(true);
		const mergedHeadBeforeRetry = git(directory, ['rev-parse', 'HEAD']);
		expect(mergedHeadBeforeRetry).toBe(baselineHead);
		expect(
			fs.readFileSync(
				path.join(directory, 'src', 'mixed-worktree-feature.ts'),
				'utf8',
			),
		).toBe('export const mixedWorktreeFeature = true;\n');

		observerInternals.transferCoderSettlementToBackground = realTransfer;
		const recovered = await observer().reconcilePending(pending!);

		expect(recovered).toBe(true);
		expect(
			findByCorrelationId(directory, CORRELATION_ID)?.coderSettlement,
		).toMatchObject({
			state: 'settled',
			outcome: { result: 'merged' },
		});
		expect(readLegacyWal()).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
		expect(fs.existsSync(worktreePath)).toBe(false);
		expect(git(directory, ['rev-parse', 'HEAD'])).toBe(mergedHeadBeforeRetry);
		expect(git(directory, ['rev-parse', BRANCH])).toBe(sourceHead);
		expect(mergePasses).toBe(1);
	});

	test('preserved worktree attribution leaves the foreground WAL and lane owned', async () => {
		const rootBaseline = captureWorkspaceSnapshot(directory);
		await registerMixedOwnership({ contextBaseline: rootBaseline });
		let transferAttempts = 0;
		observerInternals.transferCoderSettlementToBackground = async (options) => {
			transferAttempts += 1;
			return realTransfer(options);
		};

		await deliverCompletedTerminal();

		expect(
			findByCorrelationId(directory, CORRELATION_ID)?.coderSettlement,
		).toMatchObject({
			state: 'preserved',
			outcome: {
				kind: 'standard-worktree',
				result: 'failed',
				reason: 'worktree recovery identity does not match the dispatch',
			},
		});
		expect(transferAttempts).toBe(0);
		expect(readLegacyWal().state).toBe('DISPATCHED');
		expect(fs.existsSync(worktreePath)).toBe(true);
		expect(git(directory, ['branch', '--list', BRANCH])).not.toBe('');
		expect(
			fs.existsSync(path.join(directory, 'src', 'mixed-worktree-feature.ts')),
		).toBe(false);
	});

	test('a settled handoff retries retained-lane cleanup without replaying merge', async () => {
		await registerMixedOwnership();
		const baselineHead = git(directory, ['rev-parse', 'HEAD']);
		let removals = 0;
		worktreeInternals.removeWorktree = async (...args) => {
			removals += 1;
			if (removals === 1) return { error: 'injected cleanup refusal' };
			return realRemoveWorktree(...args);
		};

		await deliverCompletedTerminal();

		const settled = findByCorrelationId(directory, CORRELATION_ID);
		expect(settled?.coderSettlement).toMatchObject({
			state: 'settled',
			outcome: { kind: 'standard-worktree', result: 'merged' },
		});
		expect(settled?.coderSettlement?.sourceHeadAfterCommit).toBe(
			git(directory, ['rev-parse', BRANCH]),
		);
		expect(readLegacyWal()).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
		expect(fs.existsSync(worktreePath)).toBe(true);
		expect(git(directory, ['rev-parse', 'HEAD'])).toBe(baselineHead);
		const landedBytes = fs.readFileSync(
			path.join(directory, 'src', 'mixed-worktree-feature.ts'),
			'utf8',
		);
		expect(landedBytes).toBe('export const mixedWorktreeFeature = true;\n');
		const sourceBranch = git(directory, ['rev-parse', BRANCH]);

		worktreeInternals.removeWorktree = realRemoveWorktree;
		let mergePasses = 0;
		worktreeInternals.attemptMergeBackFromDirty = async (...args) => {
			mergePasses += 1;
			return realAttemptMergeBackFromDirty(...args);
		};
		const recovered = await observer().reconcilePending(settled!);

		expect(recovered).toBe(true);
		expect(fs.existsSync(worktreePath)).toBe(false);
		expect(git(directory, ['rev-parse', 'HEAD'])).toBe(baselineHead);
		expect(
			fs.readFileSync(
				path.join(directory, 'src', 'mixed-worktree-feature.ts'),
				'utf8',
			),
		).toBe(landedBytes);
		expect(git(directory, ['rev-parse', BRANCH])).toBe(sourceBranch);
		expect(mergePasses).toBe(0);
		const consumed = findByCorrelationId(directory, CORRELATION_ID);
		expect(consumed?.status).toBe('consumed');
		expect(await observer().reconcilePending(consumed!)).toBe(true);
		expect(fs.existsSync(worktreePath)).toBe(false);
		expect(git(directory, ['rev-parse', BRANCH])).toBe(sourceBranch);
	});

	test('a compacted consumed settlement cleans retained lane from durable provenance', async () => {
		await registerMixedOwnership();
		const baselineHead = git(directory, ['rev-parse', 'HEAD']);
		worktreeInternals.removeWorktree = async () => ({
			error: 'injected cleanup refusal',
		});

		await deliverCompletedTerminal();
		const consumed = findByCorrelationId(directory, CORRELATION_ID);
		expect(consumed?.status).toBe('completed');
		expect(consumed?.coderSettlement).toMatchObject({
			state: 'settled',
			outcome: { kind: 'standard-worktree', result: 'merged' },
		});
		expect(fs.existsSync(worktreePath)).toBe(true);
		const cleared = await clearLegacyCoderSettlementTransferPending(
			directory,
			CORRELATION_ID,
		);
		expect(cleared?.legacyCoderSettlementTransfer).toBeUndefined();
		const ingestion = await claimDelegationIngestion(
			directory,
			CORRELATION_ID,
			{
				claimantId: 'recovery-fixture',
			},
		);
		expect(ingestion?.disposition).toBe('claimed');
		const consumedRecord = await recordDelegationIngestionResult(
			directory,
			CORRELATION_ID,
			ingestion!.record.ingestion!.claimToken,
			true,
		);
		expect(consumedRecord?.status).toBe('consumed');

		const cleanupObserver = observer();
		const prepared = await cleanupObserver.prepareAdvisories('parent');
		if (prepared)
			await cleanupObserver.ackObservedAdvisories('parent', prepared.messages);
		await compactBackgroundDelegations(directory, { force: true });
		const summary = findByCorrelationId(directory, CORRELATION_ID);
		expect(summary).toBeDefined();
		expect(summary?.taskChangeContext).toBeUndefined();
		expect(summary?.coderSettlement?.provenance).toBeDefined();

		worktreeInternals.removeWorktree = realRemoveWorktree;
		let mergePasses = 0;
		worktreeInternals.attemptMergeBackFromDirty = async (...args) => {
			mergePasses += 1;
			return realAttemptMergeBackFromDirty(...args);
		};
		const recovered = await observer().reconcilePending(summary!);

		expect(recovered).toBe(true);
		expect(fs.existsSync(worktreePath)).toBe(false);
		expect(git(directory, ['rev-parse', 'HEAD'])).toBe(baselineHead);
		expect(
			fs.readFileSync(
				path.join(directory, 'src', 'mixed-worktree-feature.ts'),
				'utf8',
			),
		).toBe('export const mixedWorktreeFeature = true;\n');
		expect(mergePasses).toBe(0);
	});

	test('a settled-write failure after handoff replays without merging twice', async () => {
		await registerMixedOwnership();
		const baselineHead = git(directory, ['rev-parse', 'HEAD']);
		let settlementWrites = 0;
		let mergePasses = 0;
		worktreeInternals.attemptMergeBackFromDirty = async (...args) => {
			mergePasses += 1;
			return realAttemptMergeBackFromDirty(...args);
		};
		observerInternals.updateCoderSettlement = async (...args) => {
			if (args[2].state === 'settled' && ++settlementWrites === 1) {
				throw new Error('injected settled-state persistence failure');
			}
			return realUpdateCoderSettlement(...args);
		};

		await deliverCompletedTerminal();
		const pending = findByCorrelationId(directory, CORRELATION_ID);
		expect(pending?.coderSettlement).toMatchObject({
			state: 'settling',
			provenance: {
				correlationId: CORRELATION_ID,
				worktree: { branchName: BRANCH },
			},
		});
		expect(pending?.legacyCoderSettlementTransfer).toMatchObject({
			taskId: TASK_ID,
			transitionId: TRANSITION_ID,
		});
		expect(readLegacyWal().state).toBe('ABORTED');
		expect(fs.existsSync(worktreePath)).toBe(true);
		expect(git(directory, ['rev-parse', 'HEAD'])).toBe(baselineHead);
		expect(mergePasses).toBe(1);
		const sourceBranch = git(directory, ['rev-parse', BRANCH]);

		observerInternals.updateCoderSettlement = realUpdateCoderSettlement;
		const recovered = await observer().reconcilePending(pending!);

		expect(recovered).toBe(true);
		expect(
			findByCorrelationId(directory, CORRELATION_ID)?.coderSettlement?.state,
		).toBe('settled');
		expect(fs.existsSync(worktreePath)).toBe(false);
		expect(git(directory, ['rev-parse', 'HEAD'])).toBe(baselineHead);
		expect(git(directory, ['rev-parse', BRANCH])).toBe(sourceBranch);
		expect(mergePasses).toBe(1);
	});
});
