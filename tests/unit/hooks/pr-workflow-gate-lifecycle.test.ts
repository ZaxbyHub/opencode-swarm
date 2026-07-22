import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	bindPrReviewBase,
	bindPrWorkflowHead,
	enforcePrReviewBaseDimensions,
	enforcePrWorkflowDispatchLanesAsync,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

describe('pr-workflow-gate lifecycle and base coverage', () => {
	test('activatePrWorkflow persists recoverable session-keyed state', async () => {
		const activated = await activatePrWorkflow(
			tempDir,
			SESSION_ID,
			'PR_REVIEW',
		);

		expect(activated.mode).toBe('PR_REVIEW');

		_test_exports.resetTrackedStateCache();
		const recovered = await readPrWorkflowGateState(tempDir, SESSION_ID);

		expect(recovered).not.toBeNull();
		expect(recovered?.sessionID).toBe(SESSION_ID);
		expect(recovered?.mode).toBe('PR_REVIEW');

		const relativePath =
			_test_exports.workflowGateStateRelativePath(SESSION_ID);
		const onDisk = JSON.parse(
			await fs.readFile(path.join(tempDir, '.swarm', relativePath), 'utf-8'),
		) as { sessionID: string; mode: string };
		expect(onDisk.sessionID).toBe(SESSION_ID);
		expect(onDisk.mode).toBe('PR_REVIEW');
	});

	test('cache is isolated by canonical project directory and session id', async () => {
		const secondDir = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-gate-second-')),
		);
		try {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			await activatePrWorkflow(secondDir, SESSION_ID, 'PR_FEEDBACK');
			expect((await readPrWorkflowGateState(tempDir, SESSION_ID))?.mode).toBe(
				'PR_REVIEW',
			);
			expect((await readPrWorkflowGateState(secondDir, SESSION_ID))?.mode).toBe(
				'PR_FEEDBACK',
			);
		} finally {
			await fs.rm(secondDir, { recursive: true, force: true });
		}
	});

	test('bindPrWorkflowHead is immutable and same-value idempotent', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		await bindPrWorkflowHead(tempDir, SESSION_ID, HEAD_SHA);
		await expect(
			bindPrWorkflowHead(tempDir, SESSION_ID, HEAD_SHA),
		).resolves.toMatchObject({ prHeadSha: HEAD_SHA });
		await expect(
			bindPrWorkflowHead(tempDir, SESSION_ID, 'changed-head'),
		).rejects.toThrow('does not match PR head');
	});

	test('bindPrWorkflowHead rejects dirty and indeterminate working trees', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		for (const cleanState of [false, null] as const) {
			_test_exports.resolveIsWorkingTreeClean = () => cleanState;
			await expect(
				bindPrWorkflowHead(tempDir, SESSION_ID, HEAD_SHA),
			).rejects.toThrow('requires a clean index and working tree');
		}
	});

	test('enforcePrWorkflowDispatchLanesAsync blocks blocking dispatch for active review and feedback workflows', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		await expect(
			enforcePrWorkflowDispatchLanesAsync(
				tempDir,
				SESSION_ID,
				'dispatch_lanes',
			),
		).rejects.toThrow('requires dispatch_lanes_async');

		const feedbackSession = `${SESSION_ID}-feedback`;
		await activatePrWorkflow(tempDir, feedbackSession, 'PR_FEEDBACK');
		await expect(
			enforcePrWorkflowDispatchLanesAsync(
				tempDir,
				feedbackSession,
				'dispatch_lanes',
			),
		).rejects.toThrow('requires dispatch_lanes_async');

		await expect(
			enforcePrWorkflowDispatchLanesAsync(
				tempDir,
				feedbackSession,
				'dispatch_lanes_async',
			),
		).resolves.toMatchObject({ mode: 'PR_FEEDBACK' });
	});

	test('enforcePrReviewBaseDimensions accepts the exact six required base lane ids', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');

		const state = await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[...PR_REVIEW_BASE_DIMENSION_IDS]
				.reverse()
				.map((workflowLane) => ({ laneId: workflowLane, workflowLane })),
			{ batchId: 'batch-1', prHeadSha: HEAD_SHA },
		);

		expect(state.prReviewBaseDispatch).toEqual({
			batchId: 'batch-1',
			lanes: [...PR_REVIEW_BASE_DIMENSION_IDS]
				.reverse()
				.map((workflowLane) => ({ laneId: workflowLane, workflowLane })),
			validatedAt: expect.any(String),
		});

		_test_exports.resetTrackedStateCache();
		const recovered = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(recovered?.prReviewBaseDispatches).toHaveLength(1);
	});

	test('base retries may cover subsets but unrecognized dimensions are rejected', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2).map((workflowLane) => ({
				laneId: workflowLane,
				workflowLane,
			})),
			{ batchId: 'retry-subset', prHeadSha: HEAD_SHA },
		);

		await expect(
			enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				[
					...PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 5).map((workflowLane) => ({
						workflowLane,
					})),
					{ workflowLane: 'not-a-base-dimension' },
				],
				{ batchId: 'bad', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('must be drawn from');
	});

	test('base settlement uses successful retry coverage and rejects empty artifacts', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const firstHalf = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 3).map(
			(workflowLane) => ({ laneId: `failed-${workflowLane}`, workflowLane }),
		);
		const retryFirstHalf = PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 3).map(
			(workflowLane) => ({ laneId: `retry-${workflowLane}`, workflowLane }),
		);
		const secondHalf = PR_REVIEW_BASE_DIMENSION_IDS.slice(3).map(
			(workflowLane) => ({ laneId: `ok-${workflowLane}`, workflowLane }),
		);
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, firstHalf, {
			batchId: 'base-failed',
			prHeadSha: HEAD_SHA,
		});
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, retryFirstHalf, {
			batchId: 'base-retry',
			prHeadSha: HEAD_SHA,
		});
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, secondHalf, {
			batchId: 'base-second',
			prHeadSha: HEAD_SHA,
		});
		await persistBatch(
			'base-failed',
			'swarm-pr-review:base',
			firstHalf.slice(0, 2),
		);
		await persistBatch('base-retry', 'swarm-pr-review:base', retryFirstHalf);
		await persistBatch('base-second', 'swarm-pr-review:base', secondHalf, {
			textOverride: 'Now let me check the remaining files.',
		});
		await expect(
			assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
		).rejects.toThrow('missing dimensions');

		const retrySecondHalf = secondHalf.map((lane) => ({
			...lane,
			laneId: `retry-${lane.workflowLane}`,
		}));
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, retrySecondHalf, {
			batchId: 'base-second-retry',
			prHeadSha: HEAD_SHA,
		});
		await persistBatch(
			'base-second-retry',
			'swarm-pr-review:base',
			retrySecondHalf,
		);
		await expect(
			assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
		).resolves.toMatchObject({ prHeadSha: HEAD_SHA });
	});

	test('base settlement rejects six records from one reused child session', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const lanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
			laneId: workflowLane,
			workflowLane,
		}));
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, lanes, {
			batchId: 'base-shared-session',
			prHeadSha: HEAD_SHA,
		});
		await persistBatch('base-shared-session', 'swarm-pr-review:base', lanes, {
			subagentSessionId: 'one-child-for-all-six',
		});

		await expect(
			assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
		).rejects.toThrow('missing dimensions');
	});

	test('a retry base batch cannot consolidate ownership at depth tier L (legacy/unset tier)', async () => {
		// No bindPrReviewBase call: prReviewDepthTier is unset, defaulting to
		// 'L' exactly like a legacy gate state predating the depth-tier field.
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const singletonLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
			laneId: workflowLane,
			workflowLane,
		}));
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, singletonLanes, {
			batchId: 'base-initial',
			prHeadSha: HEAD_SHA,
		});
		// The initial six lanes never complete — the retry batch below must not
		// be able to settle all six dimensions on its own via consolidation.
		const consolidatedRetryLane = [
			{
				laneId: 'retry-consolidated',
				workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0],
				ownedWorkflowLanes: [...PR_REVIEW_BASE_DIMENSION_IDS],
			},
		];
		await expect(
			enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				consolidatedRetryLane,
				{
					batchId: 'base-retry-consolidated',
					prHeadSha: HEAD_SHA,
				},
			),
		).rejects.toThrow('depth tier L requires one dedicated lane per dimension');
	});

	test('at depth tier S/M, a later base batch may consolidate ownership and settles all-or-none', async () => {
		const originalResolveDiffStats = _test_exports.resolvePrReviewDiffStats;
		_test_exports.resolvePrReviewDiffStats = () => ({
			changedLines: 12,
			changedFiles: 2,
		});
		try {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			await bindPrReviewBase(tempDir, SESSION_ID, {
				prHeadSha: HEAD_SHA,
				baseRef: 'origin/main',
				baseSha: 'def456',
			});
			const [dimA, dimB, ...restDims] = PR_REVIEW_BASE_DIMENSION_IDS;
			const consolidatedLane = [
				{
					laneId: 'sweep-ab',
					workflowLane: dimA,
					ownedWorkflowLanes: [dimA, dimB],
				},
			];
			await enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				consolidatedLane,
				{
					batchId: 'base-consolidated',
					prHeadSha: HEAD_SHA,
				},
			);
			const remainingLanes = restDims.map((workflowLane) => ({
				laneId: workflowLane,
				workflowLane,
			}));
			await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, remainingLanes, {
				batchId: 'base-remaining',
				prHeadSha: HEAD_SHA,
			});
			const expectedScope = 'complete PR diff def456...abc123';
			// Consolidated lane never completes: neither of its two owned
			// dimensions may settle from the other's evidence (all-or-none).
			await persistBatch(
				'base-remaining',
				'swarm-pr-review:base',
				remainingLanes,
				{
					scope: expectedScope,
				},
			);
			await expect(
				assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
			).rejects.toThrow(`missing dimensions: ${dimA}, ${dimB}`);

			await persistBatch(
				'base-consolidated',
				'swarm-pr-review:base',
				consolidatedLane,
				{ scope: expectedScope },
			);
			await expect(
				assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
			).resolves.toMatchObject({ prHeadSha: HEAD_SHA });
		} finally {
			_test_exports.resolvePrReviewDiffStats = originalResolveDiffStats;
		}
	});
});
