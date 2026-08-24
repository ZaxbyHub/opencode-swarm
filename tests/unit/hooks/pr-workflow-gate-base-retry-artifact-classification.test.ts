import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const singletonLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
	laneId: workflowLane,
	workflowLane,
}));

function consolidatedRetry(lanes: typeof singletonLanes) {
	return [
		{
			laneId: 'retry-consolidated',
			workflowLane: lanes[0].workflowLane,
			ownedWorkflowLanes: lanes.map((lane) => lane.workflowLane),
		},
	];
}

async function establishInitialBaseWave(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, singletonLanes, {
		batchId: 'base-initial',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
}

describe('tier-L base retry artifact classification', () => {
	test.each([
		{ label: 'incomplete', transcriptIncomplete: true, truncated: false },
		{ label: 'truncated', transcriptIncomplete: false, truncated: true },
	])('allows consolidation after terminal malformed $label artifacts', async ({
		transcriptIncomplete,
		truncated,
	}) => {
		await establishInitialBaseWave();
		const failedLanes = singletonLanes.slice(0, 2);
		await persistBatch('base-initial', 'swarm-pr-review:base', failedLanes, {
			textOverride: 'malformed terminal artifact',
			transcriptIncomplete,
			truncated,
		});

		const state = await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			consolidatedRetry(failedLanes),
			{
				batchId: 'base-retry-consolidated',
				prHeadSha: HEAD_SHA,
			},
		);

		expect(state.prReviewBaseDispatch?.batchId).toBe('base-retry-consolidated');
	});

	test('does not classify a semantically valid recovered stale artifact as terminal failure', async () => {
		await establishInitialBaseWave();
		const recoveredLanes = singletonLanes.slice(0, 2);
		await persistBatch('base-initial', 'swarm-pr-review:base', recoveredLanes, {
			transcriptIncomplete: true,
		});

		await expect(
			enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				consolidatedRetry(recoveredLanes),
				{
					batchId: 'base-retry-consolidated',
					prHeadSha: HEAD_SHA,
					revisionDigest: 'new-worktree-revision',
				},
			),
		).rejects.toThrow(
			'no recorded lane that reached a terminal non-successful state',
		);
	});
});
