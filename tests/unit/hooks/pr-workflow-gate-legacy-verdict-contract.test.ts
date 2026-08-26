import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	assertPrReviewValidationSettled,
	PR_REVIEW_BASE_DIMENSION_IDS,
	prWorkflowSessionFileStem,
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

const ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

function reviewedRow(itemId: string): string {
	return `[REVIEWED] | ${itemId} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer`;
}

async function arrangeCompletedArtifactWithSurplusRow(legacy: boolean) {
	await establishReviewPrerequisites();
	const batchId = legacy ? 'legacy-surplus' : 'coherent-surplus';
	const laneId = `${batchId}-lane`;
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[{ laneId, workflowLane: laneId, reviewItemIds: ITEM_IDS }],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId, workflowLane: laneId }],
		{
			textOverride: [...ITEM_IDS.map(reviewedRow), reviewedRow('C-X')].join(
				'\n',
			),
		},
	);
	if (legacy) {
		const statePath = path.join(
			tempDir,
			'.swarm',
			'pr-workflow-gates',
			`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
		);
		const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8'));
		delete persisted.prReviewBatchCoherence[batchId];
		await fs.writeFile(statePath, JSON.stringify(persisted), 'utf-8');
		_test_exports.resetTrackedStateCache();
	}
}

describe('PR-review settlement exact-row contract for completed records', () => {
	for (const legacy of [false, true]) {
		test(`rejects an invented surplus row in ${legacy ? 'legacy' : 'coherent'} completed state`, async () => {
			await arrangeCompletedArtifactWithSurplusRow(legacy);
			const composed = await _test_exports.composePrReviewPhaseVerdicts(
				tempDir,
				SESSION_ID,
				'reviewer',
			);
			expect(composed.claims.size).toBe(0);
			expect(composed.unclaimed).toEqual(ITEM_IDS);
			await expect(
				assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
			).rejects.toThrow('items lack an authenticated verdict');
		});
	}

	test('reserved discarded example IDs are never accepted as live assigned verdict rows', () => {
		const analysis = _test_exports.analyzePrReviewVerdictRowContract(
			'[REVIEWED] | discarded-id | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | illustrative only | not routable | not routable',
			['discarded-id'],
			'reviewer',
		);

		expect(analysis.ok).toBe(false);
		expect(analysis.actual).toContain('discarded-id');
	});
});
