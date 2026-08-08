import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import {
	assertPrReviewValidationSettled,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('PR-review council CLEAN settlement', () => {
	test('settles a zero-finding council artifact through the micro-lane row family', async () => {
		await establishReviewPrerequisites();
		const lane = {
			laneId: 'council-generalist-lane',
			workflowLane: 'council-generalist',
		};
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'council',
			[lane],
			{ batchId: 'council-clean', prHeadSha: HEAD_SHA },
		);
		await persistBatch('council-clean', 'swarm-pr-review:council', [lane], {
			textOverride: `${CANDIDATE_HEADERS.micro_lane}\n[CLEAN] | council-generalist | complete adversarial council review | inspected the complete diff and found no surviving council claim`,
			subagentSessionId: 'council-generalist-session',
		});

		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'council'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});
});
