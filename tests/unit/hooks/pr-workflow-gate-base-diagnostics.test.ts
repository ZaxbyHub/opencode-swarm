import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
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

const lanes = () =>
	PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));

async function declareBase(batchId: string, selected = lanes()): Promise<void> {
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, selected, {
		batchId,
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
}

describe('PR review base settlement diagnostics', () => {
	test('names the coverage gap and settlement path for a failed lane', async () => {
		// INTENT CHANGE (issue #2383): the settlement refusal no longer embeds
		// per-lane predicate diagnostics (`first failed lane predicates: ...`).
		// The N-of-6 settlement message names the coverage kind, the covered
		// count, every unresolved dimension, and the settlement path instead.
		// Lane-level predicate diagnostics remain observable on the collect-path
		// lane result (dispatch-lanes-pr-review-collection-validation tests).
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const all = lanes();
		await declareBase('base-all', all);
		await persistBatch('base-all', 'swarm-pr-review:base', all.slice(1));
		await persistBatch('base-all', 'swarm-pr-review:base', all.slice(0, 1), {
			artifactRole: 'wrong-role',
		});

		let error: Error | undefined;
		try {
			await assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID);
		} catch (caught) {
			error = caught as Error;
		}
		expect(error?.message).toContain(
			'PR_REVIEW base coverage is PARTIAL (5/6 dimensions covered; unresolved: intent-architecture)',
		);
		expect(error?.message).toContain(
			'settle via write_pr_review_artifact partial_base_coverage.unresolved_dimensions',
		);
	});

	test('lists every unresolved dimension when an expected lane has no record', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const all = lanes();
		await declareBase('base-missing', all);
		await persistBatch('base-missing', 'swarm-pr-review:base', all.slice(0, 1));

		let error: Error | undefined;
		try {
			await assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID);
		} catch (caught) {
			error = caught as Error;
		}
		expect(error?.message).toContain('PR_REVIEW base coverage is PARTIAL');
		expect(error?.message).toContain(
			`unresolved: ${PR_REVIEW_BASE_DIMENSION_IDS.slice(1).join(', ')}`,
		);
	});

	test('unions a valid retry lane with prior successful coverage', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const all = lanes();
		await declareBase('base-first', all);
		await persistBatch('base-first', 'swarm-pr-review:base', all.slice(1));

		const retry = [{ ...all[0], laneId: `retry-${all[0].laneId}` }];
		await declareBase('base-retry', retry);
		await persistBatch('base-retry', 'swarm-pr-review:base', retry);

		await expect(
			assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
		).resolves.toMatchObject({ state: { prHeadSha: HEAD_SHA } });
	});
});
