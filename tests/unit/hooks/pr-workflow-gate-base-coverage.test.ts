import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	abortPrWorkflow,
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('pr-workflow-gate base coverage', () => {
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
			hasSubmoduleChange: false,
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

	test('a consolidated lane with copy-pasted evidence text across its owned dimensions fails to settle, distinct text succeeds', async () => {
		const originalResolveDiffStats = _test_exports.resolvePrReviewDiffStats;
		_test_exports.resolvePrReviewDiffStats = () => ({
			changedLines: 12,
			changedFiles: 2,
			hasSubmoduleChange: false,
		});
		try {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			await bindPrReviewBase(tempDir, SESSION_ID, {
				prHeadSha: HEAD_SHA,
				baseRef: 'origin/main',
				baseSha: 'def456',
			});
			const [dimA, dimB, dimC, ...restDims] = PR_REVIEW_BASE_DIMENSION_IDS;
			const consolidatedLane = [
				{
					laneId: 'sweep-abc',
					workflowLane: dimA,
					ownedWorkflowLanes: [dimA, dimB, dimC],
				},
			];
			await enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				consolidatedLane,
				{ batchId: 'base-consolidated', prHeadSha: HEAD_SHA },
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
			await persistBatch(
				'base-remaining',
				'swarm-pr-review:base',
				remainingLanes,
				{
					scope: expectedScope,
				},
			);

			// Two owned dimensions beyond the first both fall back to
			// persistBatch's identical generic [CLEAN] template — a real
			// copy-paste-relabel case, not a contrived one — and must be
			// rejected as indistinguishable evidence.
			await persistBatch(
				'base-consolidated',
				'swarm-pr-review:base',
				consolidatedLane,
				{ scope: expectedScope },
			);
			await expect(
				assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
			).rejects.toThrow(`missing dimensions: ${dimA}, ${dimB}, ${dimC}`);

			// Retrying the same lane with genuinely distinct per-dimension
			// evidence text succeeds.
			await enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				consolidatedLane,
				{ batchId: 'base-consolidated-retry', prHeadSha: HEAD_SHA },
			);
			await persistBatch(
				'base-consolidated-retry',
				'swarm-pr-review:base',
				consolidatedLane,
				{
					scope: expectedScope,
					textOverride: [
						'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
						`C-0 | ${dimA} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH`,
						`[CLEAN] | ${dimB} | reviewed diff scoped to ${dimB} | no ${dimB} finding after focused invariant review`,
						`[CLEAN] | ${dimC} | reviewed diff scoped to ${dimC} | no ${dimC} finding after focused invariant review`,
					].join('\n'),
				},
			);
			await expect(
				assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
			).resolves.toMatchObject({ prHeadSha: HEAD_SHA });
		} finally {
			_test_exports.resolvePrReviewDiffStats = originalResolveDiffStats;
		}
	});

	test('prReviewDepthTier and prReviewDiffStats survive a disk round-trip', async () => {
		const originalResolveDiffStats = _test_exports.resolvePrReviewDiffStats;
		_test_exports.resolvePrReviewDiffStats = () => ({
			changedLines: 12,
			changedFiles: 2,
			hasSubmoduleChange: false,
		});
		try {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			await bindPrReviewBase(tempDir, SESSION_ID, {
				prHeadSha: HEAD_SHA,
				baseRef: 'origin/main',
				baseSha: 'def456',
			});

			_test_exports.resetTrackedStateCache();
			const recovered = await readPrWorkflowGateState(tempDir, SESSION_ID);

			expect(recovered?.prReviewDepthTier).toBe('S');
			expect(recovered?.prReviewDiffStats).toEqual({
				changedLines: 12,
				changedFiles: 2,
				hasSubmoduleChange: false,
			});
		} finally {
			_test_exports.resolvePrReviewDiffStats = originalResolveDiffStats;
		}
	});

	test('a gate state persisted before hasSubmoduleChange existed still parses and stays recoverable via abort', async () => {
		const originalResolveDiffStats = _test_exports.resolvePrReviewDiffStats;
		_test_exports.resolvePrReviewDiffStats = () => ({
			changedLines: 12,
			changedFiles: 2,
			hasSubmoduleChange: false,
		});
		try {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			await bindPrReviewBase(tempDir, SESSION_ID, {
				prHeadSha: HEAD_SHA,
				baseRef: 'origin/main',
				baseSha: 'def456',
			});

			// Simulate a gate-state file written before hasSubmoduleChange was
			// added to prReviewDiffStats (an older version of this exact PR's own
			// code) by stripping it back out of the persisted JSON.
			const relativePath =
				_test_exports.workflowGateStateRelativePath(SESSION_ID);
			const statePath = path.join(tempDir, '.swarm', relativePath);
			const onDisk = JSON.parse(await fs.readFile(statePath, 'utf-8'));
			expect(onDisk.prReviewDiffStats.hasSubmoduleChange).toBe(false);
			delete onDisk.prReviewDiffStats.hasSubmoduleChange;
			await fs.writeFile(statePath, JSON.stringify(onDisk), 'utf-8');

			_test_exports.resetTrackedStateCache();
			const recovered = await readPrWorkflowGateState(tempDir, SESSION_ID);
			expect(recovered?.prReviewDiffStats).toEqual({
				changedLines: 12,
				changedFiles: 2,
				hasSubmoduleChange: false,
			});

			_test_exports.resetTrackedStateCache();
			await expect(abortPrWorkflow(tempDir, SESSION_ID)).resolves.toMatchObject(
				{ mode: 'PR_REVIEW' },
			);
		} finally {
			_test_exports.resolvePrReviewDiffStats = originalResolveDiffStats;
		}
	});
});
