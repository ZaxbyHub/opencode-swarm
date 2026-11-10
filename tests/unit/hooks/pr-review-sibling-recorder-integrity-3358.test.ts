/**
 * Issue #3358 AC9 sibling-surface riders (approved plan R1): the
 * PR_REVIEW_PHASE_ADMITTED_ROLES table is enforced at the gate RECORDER and
 * at ARTIFACT INTEGRITY, not only at dispatch admission. A direct recorder
 * caller declaring a wrong role is rejected; a wrong-role child record
 * fails lane integrity and the phase does not settle; correct roles settle.
 *
 * RED under the R1-revert mutation (recorder + integrity back to
 * critic-only); GREEN at the shipped head.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
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

const ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
const lanes = [
	{ laneId: 'lane-1', workflowLane: 'lane-1', reviewItemIds: ITEM_IDS },
];

const reviewerText = ITEM_IDS.map(
	(itemId) =>
		`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
).join('\n');

describe('gate-recorder and integrity sibling admission (#3358 AC8, plan R1)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('recorder rejects a DECLARED wrong reviewer role (direct-bypass caller)', async () => {
		await establishReviewPrerequisites();
		const declaredCritic = [{ ...lanes[0], agent: 'critic' }];
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				declaredCritic,
				{
					batchId: 'bypass-reviewer-role',
					prHeadSha: HEAD_SHA,
					generatedAgentNames: [],
				},
			),
		).rejects.toThrow(
			/uses invalid role "critic".*reviewer lanes must use one of/,
		);
	});

	test('recorder rejects a DECLARED non-factory council role', async () => {
		await establishReviewPrerequisites();
		const declaredCritic = [{ ...lanes[0], agent: 'critic' }];
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'council',
				declaredCritic,
				{
					batchId: 'bypass-council-role',
					prHeadSha: HEAD_SHA,
					generatedAgentNames: [],
				},
			),
		).rejects.toThrow(
			/uses invalid role "critic".*council lanes must use one of/,
		);
	});

	test('recorder admits an exact declared role (reviewer)', async () => {
		await establishReviewPrerequisites();
		await expect(
			recordPrReviewValidationBatch(tempDir, SESSION_ID, 'reviewer', lanes, {
				batchId: 'legit-reviewer',
				prHeadSha: HEAD_SHA,
			}),
		).resolves.toBeDefined();
	});

	test('a wrong-role child record fails lane integrity and never settles (reviewer mode, explorer child)', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{
				batchId: 'wrong-child-reviewer',
				prHeadSha: HEAD_SHA,
			},
		);
		await persistBatch(
			'wrong-child-reviewer',
			'swarm-pr-review:reviewer',
			lanes,
			{
				textOverride: reviewerText,
				recordAgent: 'explorer',
			},
		);
		_test_exports.resetTrackedStateCache();
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).rejects.toThrow(/items lack an authenticated verdict/);
	});

	test('a wrong-role child record fails lane integrity (council mode, reviewer child)', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(tempDir, SESSION_ID, 'council', lanes, {
			batchId: 'wrong-child-council',
			prHeadSha: HEAD_SHA,
		});
		await persistBatch(
			'wrong-child-council',
			'swarm-pr-review:council',
			lanes,
			{
				textOverride: reviewerText,
				recordAgent: 'reviewer',
			},
		);
		_test_exports.resetTrackedStateCache();
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'council'),
		).rejects.toThrow();
	});

	test('a correct-role child record settles (reviewer mode)', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{
				batchId: 'good-child-reviewer',
				prHeadSha: HEAD_SHA,
			},
		);
		await persistBatch(
			'good-child-reviewer',
			'swarm-pr-review:reviewer',
			lanes,
			{
				textOverride: reviewerText,
			},
		);
		_test_exports.resetTrackedStateCache();
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toBeDefined();
	});
});
