import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewWorkflowBinding,
	type PrReviewLaneResultEnvelope,
} from '../../../src/background/pr-review-contract.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
	rollbackPrReviewBaseAdmissionIfUnlaunched,
	submitPrReviewResult,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeCollectLaneResults,
} from '../../../src/tools/dispatch-lanes.js';
import {
	HEAD_SHA,
	LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	PR_REVIEW_BASE_SHA,
	PR_REVIEW_SCOPE,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const originalDispatchGetSessionOps = dispatchInternals.getSessionOps;
const originalDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalRevisionDigest = gateInternals.resolvePrWorkflowRevisionDigest;
const REGISTERED_REVISION_DIGEST = 'e'.repeat(64);

beforeEach(setupPrWorkflowGateFixtures);

afterEach(async () => {
	dispatchInternals.getSessionOps = originalDispatchGetSessionOps;
	gateInternals.resolvePrReviewDiffStats = originalDiffStats;
	gateInternals.resolvePrWorkflowRevisionDigest = originalRevisionDigest;
	await teardownPrWorkflowGateFixtures();
});

function baseLane(laneId = 'base-lane-2512') {
	return {
		laneId,
		workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0]!,
	};
}

function cleanEnvelope(
	lane = PR_REVIEW_BASE_DIMENSION_IDS[0]!,
): PrReviewLaneResultEnvelope {
	return {
		schemaVersion: 1,
		outcome: 'CLEAN',
		creditedLanes: [lane],
		findings: [],
		cleanAttestations: [
			{
				workflowLane: lane,
				coverageScope: `The complete changed surface for ${lane} was reviewed.`,
				evidence: `No actionable defect survived the ${lane} review.`,
			},
		],
		unresolved: [],
	};
}

async function bindWorkflow(): Promise<
	NonNullable<Awaited<ReturnType<typeof readPrWorkflowGateState>>>
> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	gateInternals.resolvePrWorkflowRevisionDigest = () =>
		REGISTERED_REVISION_DIGEST;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 12,
		changedFiles: 2,
		hasSubmoduleChange: false,
	});
	await bindPrReviewBase(tempDir, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: PR_REVIEW_BASE_SHA,
	});
	const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
	if (!state) throw new Error('workflow binding was not persisted');
	return state;
}

describe('registered retained transition paths (#2512)', () => {
	test('base-admission rollback persists the removal and is a no-op for stale/non-tail replay', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [baseLane()], {
			batchId: 'rollback-target',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		});
		const before = await readPrWorkflowGateState(tempDir, SESSION_ID);
		if (!before) throw new Error('missing pre-rollback state');

		expect(
			await rollbackPrReviewBaseAdmissionIfUnlaunched(
				tempDir,
				SESSION_ID,
				'rollback-target',
			),
		).toBe(true);
		gateInternals.resetTrackedStateCache();
		const after = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(after?.prReviewBaseDispatches ?? []).toEqual([]);
		expect(after?.prReviewBaseDispatch).toBeUndefined();
		expect(after?.revision).toBeGreaterThan(before.revision);

		const replaySnapshot = JSON.stringify(after);
		expect(
			await rollbackPrReviewBaseAdmissionIfUnlaunched(
				tempDir,
				SESSION_ID,
				'rollback-target',
			),
		).toBe(false);
		gateInternals.resetTrackedStateCache();
		expect(
			JSON.stringify(await readPrWorkflowGateState(tempDir, SESSION_ID)),
		).toBe(replaySnapshot);

		await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[baseLane('older-batch')],
			{
				batchId: 'older-batch',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[baseLane('current-batch')],
			{
				batchId: 'current-batch',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		const staleBefore = JSON.stringify(
			await readPrWorkflowGateState(tempDir, SESSION_ID),
		);
		expect(
			await rollbackPrReviewBaseAdmissionIfUnlaunched(
				tempDir,
				SESSION_ID,
				'older-batch',
			),
		).toBe(false);
		gateInternals.resetTrackedStateCache();
		expect(
			JSON.stringify(await readPrWorkflowGateState(tempDir, SESSION_ID)),
		).toBe(staleBefore);

		await persistBatch('current-batch', 'swarm-pr-review:base', [
			baseLane('current-batch'),
		]);
		const launchedBefore = JSON.stringify(
			await readPrWorkflowGateState(tempDir, SESSION_ID),
		);
		expect(
			await rollbackPrReviewBaseAdmissionIfUnlaunched(
				tempDir,
				SESSION_ID,
				'current-batch',
			),
		).toBe(false);
		gateInternals.resetTrackedStateCache();
		expect(
			JSON.stringify(await readPrWorkflowGateState(tempDir, SESSION_ID)),
		).toBe(launchedBefore);
	});

	test('collection observation reports the exact diagnostic without terminalizing a pending lane', async () => {
		const childSessionId = 'collection-child-2512';
		await recordPendingDelegation(tempDir, {
			correlationId: childSessionId,
			jobId: null,
			subagentSessionId: childSessionId,
			parentSessionId: SESSION_ID,
			callID: 'collection-call-2512',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'collection-batch-2512',
			laneId: 'collection-lane-2512',
			mode: 'swarm-pr-review:base',
			workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0],
			workspace: {
				directory: tempDir,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: PR_REVIEW_SCOPE,
			},
		});
		dispatchInternals.getSessionOps = () => null;

		const result = await executeCollectLaneResults(
			{
				batch_id: 'collection-batch-2512',
				include_pending: true,
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(result.failure_class).toBe('no_client');
		expect(result.pending).toBe(1);
		expect(result.errors).toEqual([
			'OpenCode session messages client is not available (collection_host_unavailable)',
		]);
		const record = findByCorrelationId(tempDir, childSessionId);
		expect(record?.status).toBe('pending');
		expect(record?.terminalResult).toBeUndefined();
		expect(record?.result).toBeUndefined();
	});

	test('accepted structured submission publishes a durable receipt and terminal settlement; stale and exact replay are distinct', async () => {
		const state = await bindWorkflow();
		const childSessionId = 'structured-child-2512';
		const lane = PR_REVIEW_BASE_DIMENSION_IDS[0]!;
		await recordPendingDelegation(tempDir, {
			correlationId: childSessionId,
			jobId: encodePrReviewWorkflowBinding(state.workflowInstanceId!),
			subagentSessionId: childSessionId,
			parentSessionId: SESSION_ID,
			callID: 'structured-call-2512',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'structured-batch-2512',
			laneId: 'structured-lane-2512',
			mode: 'swarm-pr-review:base',
			workflowLane: lane,
			workflowGeneration: state.revision,
			generation: 1,
			workspace: {
				directory: tempDir,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: PR_REVIEW_SCOPE,
			},
		});
		const input = {
			batchId: 'structured-batch-2512',
			laneId: 'structured-lane-2512',
			revisionDigest: REGISTERED_REVISION_DIGEST,
			result: cleanEnvelope(lane),
		};

		await expect(
			submitPrReviewResult(tempDir, childSessionId, input),
		).resolves.toMatchObject({ status: 'recorded' });
		const receipt = findByCorrelationId(tempDir, childSessionId)?.result
			?.prReviewResultReceipt;
		expect(receipt).toMatchObject({
			batchId: input.batchId,
			laneId: input.laneId,
			workflowRevision: state.revision,
			childSessionId,
		});

		await expect(
			submitPrReviewResult(tempDir, childSessionId, {
				...input,
				revisionDigest: '0'.repeat(64),
			}),
		).resolves.toEqual({
			status: 'rejected',
			reason: 'stale dispatch revision digest',
		});
		await expect(
			submitPrReviewResult(tempDir, childSessionId, input),
		).resolves.toMatchObject({ status: 'duplicate' });

		const terminalText = 'structured receipt terminal settlement';
		const terminalDigest = createHash('sha256')
			.update(terminalText)
			.digest('hex');
		const claimed = await claimTerminalResult(tempDir, childSessionId, {
			eventId: buildBackgroundCompletionEventId({
				correlationId: childSessionId,
				jobId: encodePrReviewWorkflowBinding(state.workflowInstanceId!),
				status: 'completed',
				resultDigest: terminalDigest,
			}),
			status: 'completed',
			recordedAt: Date.now(),
			result: {
				text: terminalText,
				chars: terminalText.length,
				truncated: false,
				digest: terminalDigest,
			},
		});
		expect(claimed?.disposition).toBe('claimed');
		expect(claimed?.record.status).toBe('completed');
		expect(
			claimed?.record.terminalResult?.result.prReviewResultReceipt,
		).toEqual(receipt);
	});
});
