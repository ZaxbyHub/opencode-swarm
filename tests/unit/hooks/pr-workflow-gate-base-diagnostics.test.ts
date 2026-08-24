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
	test('names the first failed artifact predicate and prints canonical recovery rows', async () => {
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
		expect(error?.message).toContain('predicate=artifact.role');
		expect(error?.message).toContain('expected="reviewer"');
		expect(error?.message).toContain('actual="wrong-role"');
		expect(error?.message).toContain(
			'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
		);
		expect(error?.message).toContain(
			'[CLEAN] | lane | coverage_scope | evidence',
		);
	});

	test('identifies an absent expected lane instead of only listing dimensions', async () => {
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
		expect(error?.message).toContain('predicate=record.missing');
		expect(error?.message).toContain(
			`valid dimensions: ${PR_REVIEW_BASE_DIMENSION_IDS.join(', ')}`,
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
		).resolves.toMatchObject({ prHeadSha: HEAD_SHA });
	});
});
