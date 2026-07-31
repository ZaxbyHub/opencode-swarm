/**
 * Issue #1676 — durable terminal settlement, advisory inbox, and fallback tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	acknowledgeObservedBackgroundAdvisories,
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	findByCorrelationId,
	findDelegationForCompletion,
	preparePendingBackgroundAdvisories,
	promoteDelegationFallback,
	putPendingBackgroundAdvisory,
	type RecordPendingInput,
	readDelegationFallback,
	recordDelegationIngestionResult,
	recordPendingDelegation,
	releasePreparedBackgroundAdvisories,
	removeDelegationFallback,
	updateCoderSettlement,
	writeDelegationFallback,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function baseInput(
	dir: string,
	overrides: Partial<RecordPendingInput> = {},
): RecordPendingInput {
	return {
		correlationId: 'subagent-1',
		jobId: 'job-1',
		subagentSessionId: 'subagent-1',
		parentSessionId: 'parent-1',
		callID: 'call-1',
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		taskChangeContext: {
			declaredFiles: ['src/feature.ts'],
			baseline: {
				directory: dir,
				gitHead: 'base-head',
				dirtyHash: 'base-dirty',
				changedFiles: [],
				prHeadSha: 'pr-head',
				scope: '1.1',
			},
		},
		worktree: {
			callID: 'call-1',
			parentSessionId: 'parent-1',
			taskId: '1.1',
			planTaskId: '1.1',
			worktreePath: path.join(dir, '.swarm-worktrees', 'lane-1'),
			branchName: 'swarm/coder-parent-1',
			worktreeId: 'worktree-1',
			worktreeSessionId: 'parent-1',
			mergeStrategy: 'cherry-pick',
			laneIndex: 0,
			worktreeDir: '.swarm-worktrees',
		},
		...overrides,
	};
}

describe('pending-delegations v3 terminal and settlement lifecycle', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('swarm-bg-v3-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		cleanup();
	});

	it('claims one immutable terminal result and never recomputes settled coder files', async () => {
		await recordPendingDelegation(dir, baseInput(dir));
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'subagent-1',
			jobId: 'job-1',
			status: 'completed',
			resultDigest: 'result-digest',
		});

		const first = await claimTerminalResult(dir, 'subagent-1', {
			eventId,
			status: 'completed',
			recordedAt: 100,
			result: {
				text: 'done',
				chars: 4,
				truncated: false,
				digest: 'result-digest',
			},
		});
		const conflicting = await claimTerminalResult(dir, 'subagent-1', {
			eventId: `${eventId}-forged`,
			status: 'error',
			recordedAt: 101,
			result: {
				error: 'late overwrite',
				chars: 14,
				truncated: false,
				digest: 'other',
			},
		});

		expect(first?.disposition).toBe('claimed');
		const replayWithDifferentObservationTime = await claimTerminalResult(
			dir,
			'subagent-1',
			{
				eventId,
				status: 'completed',
				recordedAt: 999,
				result: {
					text: 'done',
					chars: 4,
					truncated: false,
					digest: 'result-digest',
				},
			},
		);
		expect(
			replayWithDifferentObservationTime?.record.terminalResult?.recordedAt,
		).toBe(100);
		expect(conflicting).toBeNull();
		expect(findByCorrelationId(dir, 'subagent-1')?.terminalResult).toEqual(
			first?.record.terminalResult,
		);

		const settlementClaim = await claimCoderSettlement(
			dir,
			'subagent-1',
			'operation-1',
			{
				sourceHeadAfterCommit: 'source-head',
				targetHeadBeforeMerge: 'target-head',
			},
		);
		expect(settlementClaim?.disposition).toBe('claimed');
		expect(
			(await claimCoderSettlement(dir, 'subagent-1', 'operation-1'))
				?.disposition,
		).toBe('resume');
		expect(
			await claimCoderSettlement(dir, 'subagent-1', 'different-operation'),
		).toBeNull();

		const settled = await updateCoderSettlement(dir, 'subagent-1', {
			operationId: 'operation-1',
			state: 'settled',
			observedFiles: ['.\\src\\feature.ts', 'src/feature.ts', 'docs/guide.md'],
			outcome: {
				kind: 'standard-worktree',
				result: 'merged',
				sourceHeadAfterCommit: 'source-head',
				targetHeadBeforeMerge: 'target-head',
				targetHeadAfterMerge: 'merged-head',
			},
		});
		const recompute = await updateCoderSettlement(dir, 'subagent-1', {
			operationId: 'operation-1',
			state: 'settled',
			observedFiles: ['src/forged.ts'],
			outcome: {
				kind: 'standard-worktree',
				result: 'merged',
			},
		});

		expect(settled?.coderSettlement?.observedFiles).toEqual([
			'docs/guide.md',
			'src/feature.ts',
		]);
		expect(recompute?.coderSettlement?.observedFiles).toEqual([
			'docs/guide.md',
			'src/feature.ts',
		]);
	});

	it('serializes ingestion claims and retries only immutable settled data', async () => {
		await recordPendingDelegation(dir, baseInput(dir, { worktree: undefined }));
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'subagent-1',
			jobId: 'job-1',
			status: 'completed',
			resultDigest: 'digest',
		});
		await claimTerminalResult(dir, 'subagent-1', {
			eventId,
			status: 'completed',
			recordedAt: 100,
			result: { chars: 0, truncated: false, digest: 'digest' },
		});
		await claimCoderSettlement(dir, 'subagent-1', 'operation-1');
		await updateCoderSettlement(dir, 'subagent-1', {
			operationId: 'operation-1',
			state: 'settled',
			observedFiles: ['src/feature.ts'],
			outcome: { kind: 'shared-root', result: 'ready' },
		});

		const firstIngestion = await claimDelegationIngestion(dir, 'subagent-1', {
			claimantId: 'owner-1',
			now: 100,
			leaseMs: 1_000,
		});
		expect(firstIngestion?.disposition).toBe('claimed');
		expect(
			(
				await claimDelegationIngestion(dir, 'subagent-1', {
					claimantId: 'owner-2',
					now: 500,
					leaseMs: 1_000,
				})
			)?.disposition,
		).toBe('busy');
		expect(
			await recordDelegationIngestionResult(
				dir,
				'subagent-1',
				'not-the-claim-token',
				true,
				{ now: 500 },
			),
		).toBeNull();
		await recordDelegationIngestionResult(
			dir,
			'subagent-1',
			firstIngestion!.record.ingestion!.claimToken,
			false,
			{ now: 500 },
		);
		const retriedIngestion = await claimDelegationIngestion(dir, 'subagent-1', {
			claimantId: 'owner-2',
			now: 600,
			leaseMs: 1_000,
		});
		expect(retriedIngestion?.disposition).toBe('retry');
		await recordDelegationIngestionResult(
			dir,
			'subagent-1',
			retriedIngestion!.record.ingestion!.claimToken,
			true,
			{ now: 700 },
		);
		expect(
			(
				await claimDelegationIngestion(dir, 'subagent-1', {
					claimantId: 'owner-3',
					now: 700,
				})
			)?.disposition,
		).toBe('consumed');
	});

	it('reclaims an interrupted ingestion claim after its bounded lease', async () => {
		await recordPendingDelegation(dir, baseInput(dir, { worktree: undefined }));
		await claimTerminalResult(dir, 'subagent-1', {
			eventId: 'event-interrupted',
			status: 'completed',
			recordedAt: 100,
			result: { chars: 0, truncated: false, digest: 'digest' },
		});
		await claimCoderSettlement(dir, 'subagent-1', 'settlement');
		await updateCoderSettlement(dir, 'subagent-1', {
			operationId: 'settlement',
			state: 'settled',
			observedFiles: ['src/feature.ts'],
			outcome: { kind: 'shared-root', result: 'ready' },
		});

		const crashedClaim = await claimDelegationIngestion(dir, 'subagent-1', {
			claimantId: 'observer',
			now: 10_000,
			leaseMs: 1_000,
		});
		expect(crashedClaim?.disposition).toBe('claimed');
		expect(
			(
				await claimDelegationIngestion(dir, 'subagent-1', {
					claimantId: 'observer',
					now: 10_999,
					leaseMs: 1_000,
				})
			)?.disposition,
		).toBe('busy');
		const recoveredClaim = await claimDelegationIngestion(dir, 'subagent-1', {
			claimantId: 'observer',
			now: 11_000,
			leaseMs: 1_000,
		});
		expect(recoveredClaim?.disposition).toBe('retry');
		expect(recoveredClaim?.record.ingestion?.claimToken).not.toBe(
			crashedClaim?.record.ingestion?.claimToken,
		);
		expect(
			await recordDelegationIngestionResult(
				dir,
				'subagent-1',
				crashedClaim!.record.ingestion!.claimToken,
				true,
				{ now: 11_001 },
			),
		).toBeNull();
		expect(
			await recordDelegationIngestionResult(
				dir,
				'subagent-1',
				recoveredClaim!.record.ingestion!.claimToken,
				true,
				{ now: 11_001 },
			),
		).toMatchObject({ status: 'consumed' });
	});
});

describe('pending-delegations v3 durable advisory inbox', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(async () => {
		({ dir, cleanup } = createSafeTestDir('swarm-bg-inbox-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await recordPendingDelegation(dir, baseInput(dir));
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'subagent-1',
			jobId: 'job-1',
			status: 'completed',
			resultDigest: 'digest',
		});
		await claimTerminalResult(dir, 'subagent-1', {
			eventId,
			status: 'completed',
			recordedAt: 100,
			result: { chars: 0, truncated: false, digest: 'digest' },
		});
		await putPendingBackgroundAdvisory(dir, 'subagent-1', {
			eventId,
			parentSessionId: 'parent-1',
			message: '[BACKGROUND COMPLETION bgc] coder subagent-1 completed.',
			createdAt: 101,
		});
	});

	afterEach(() => {
		cleanup();
	});

	it('reclaims crashed preparations and acknowledges only host-reflected text', async () => {
		const first = await preparePendingBackgroundAdvisories(dir, 'parent-1', {
			preparationId: 'prepare-1',
			now: 200,
			leaseMs: 1_000,
		});
		const contending = await preparePendingBackgroundAdvisories(
			dir,
			'parent-1',
			{
				preparationId: 'prepare-2',
				now: 201,
				leaseMs: 1_000,
			},
		);

		expect(first).toHaveLength(1);
		expect(contending).toEqual([]);
		const retried = await preparePendingBackgroundAdvisories(dir, 'parent-1', {
			preparationId: 'prepare-2',
			now: 1_200,
			leaseMs: 1_000,
		});
		expect(retried).toHaveLength(1);
		expect(
			await acknowledgeObservedBackgroundAdvisories(dir, 'parent-1', [
				'unrelated host text',
			]),
		).toBe(0);
		expect(findByCorrelationId(dir, 'subagent-1')?.advisoryInbox?.state).toBe(
			'pending',
		);
		expect(
			await acknowledgeObservedBackgroundAdvisories(dir, 'parent-1', [
				`host history: ${retried[0].message}`,
			]),
		).toBe(1);
		expect(
			await preparePendingBackgroundAdvisories(dir, 'parent-1', {
				preparationId: 'prepare-3',
				now: 2_000,
			}),
		).toEqual([]);
		expect(
			await releasePreparedBackgroundAdvisories(dir, 'parent-1', 'prepare-2', [
				retried[0].eventId,
			]),
		).toBe(false);
	});
});

describe('pending-delegations v3 independent fallback artifact', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('swarm-bg-fallback-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		cleanup();
	});

	it('retains exact worktree recovery coordinates and promotes atomically', async () => {
		const stored = await writeDelegationFallback(dir, baseInput(dir));
		expect(stored?.record.worktree?.branchName).toBe('swarm/coder-parent-1');
		expect(await readDelegationFallback(dir, 'subagent-1')).toEqual(stored);
		expect((await findDelegationForCompletion(dir, 'subagent-1'))?.source).toBe(
			'fallback',
		);

		const promoted = await promoteDelegationFallback(dir, 'subagent-1');
		expect(promoted?.source).toBe('primary');
		expect(promoted?.record.worktree).toEqual(stored?.record.worktree);
		expect(await readDelegationFallback(dir, 'subagent-1')).toBeNull();
		expect((await findDelegationForCompletion(dir, 'subagent-1'))?.source).toBe(
			'primary',
		);
	});

	it('fails closed at capacity without evicting a live fallback', async () => {
		await writeDelegationFallback(dir, baseInput(dir), { maxLive: 1 });
		const second = await writeDelegationFallback(
			dir,
			baseInput(dir, {
				correlationId: 'subagent-2',
				subagentSessionId: 'subagent-2',
				jobId: 'job-2',
			}),
			{ maxLive: 1 },
		);

		expect(second).toBeNull();
		expect(await readDelegationFallback(dir, 'subagent-1')).not.toBeNull();
		expect(await readDelegationFallback(dir, 'subagent-2')).toBeNull();
		expect(await removeDelegationFallback(dir, 'subagent-1')).toBe(true);
	});
});
