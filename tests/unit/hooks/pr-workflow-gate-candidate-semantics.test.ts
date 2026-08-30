import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	bindPrReviewBase,
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

const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

describe('PR-review candidate semantics at the coverage gate', () => {
	test('reports batch, lane, row, and invalid fields for malformed candidate output', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const [malformedDimension, ...remainingDimensions] =
			PR_REVIEW_BASE_DIMENSION_IDS;
		const malformedLane = {
			laneId: 'bad-intent-output',
			workflowLane: malformedDimension,
		};
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [malformedLane], {
			batchId: 'semantic-bad',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		});
		await persistBatch(
			'semantic-bad',
			'swarm-pr-review:base',
			[malformedLane],
			{
				textOverride: [
					BASE_HEADER,
					`BAD-SEVERITY | ${malformedDimension} | BLOCKER-${'x'.repeat(100_000)} | correctness | src/a.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `,
					'BAD-LANE | not-a-real-lane | HIGH | correctness | src/a.ts:2 | claim | evidence | impact | HIGH | ORDINARY | ',
				].join('\n'),
			},
		);

		const remainingLanes = remainingDimensions.map((workflowLane) => ({
			laneId: `good-${workflowLane}`,
			workflowLane,
		}));
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, remainingLanes, {
			batchId: 'semantic-good',
			prHeadSha: HEAD_SHA,
		});
		await persistBatch('semantic-good', 'swarm-pr-review:base', remainingLanes);

		let diagnostic = '';
		try {
			await assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID);
		} catch (error) {
			diagnostic = error instanceof Error ? error.message : String(error);
		}
		// INTENT CHANGE (issue #2383): the settlement refusal no longer embeds
		// per-row lane diagnostics; it names the coverage kind, the covered
		// count, and every unresolved dimension. Row-level diagnostics
		// (`row 2 field severity: Invalid severity: ...`) remain observable on
		// the collect-path lane result, pinned in
		// dispatch-lanes-pr-review-collection-validation tests.
		expect(diagnostic).toContain(
			'PR_REVIEW base coverage is PARTIAL (5/6 dimensions covered; unresolved: intent-architecture)',
		);
		expect(diagnostic.length).toBeLessThan(2_000);
		expect(diagnostic).not.toContain('x'.repeat(1_000));
	});

	test('retains coverage when a valid owned candidate is followed by a malformed owned candidate', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
		const [malformedDimension, ...remainingDimensions] =
			PR_REVIEW_BASE_DIMENSION_IDS;
		const mixedLane = {
			laneId: 'mixed-valid-malformed-output',
			workflowLane: malformedDimension,
		};
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [mixedLane], {
			batchId: 'semantic-mixed',
			prHeadSha: HEAD_SHA,
			prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
		});
		await persistBatch('semantic-mixed', 'swarm-pr-review:base', [mixedLane], {
			textOverride: [
				BASE_HEADER,
				`VALID | ${malformedDimension} | HIGH | correctness | src/a.ts:1 | valid claim | valid evidence | valid impact | HIGH | ORDINARY | `,
				`MALFORMED | ${malformedDimension} | URGENT | correctness | src/a.ts:2 | dropped claim | dropped evidence | dropped impact | HIGH | ORDINARY | `,
			].join('\n'),
		});

		const remainingLanes = remainingDimensions.map((workflowLane) => ({
			laneId: `good-mixed-${workflowLane}`,
			workflowLane,
		}));
		await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, remainingLanes, {
			batchId: 'semantic-mixed-good',
			prHeadSha: HEAD_SHA,
		});
		await persistBatch(
			'semantic-mixed-good',
			'swarm-pr-review:base',
			remainingLanes,
		);

		// Approved salvage: one malformed row no longer destroys the lane's valid
		// finding. The VALID row establishes coverage; the malformed row is
		// reported as a diagnostic and contributes nothing to the inventory.
		await expect(
			assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
		).resolves.toBeDefined();
		expect(
			_test_exports.extractCandidateIds(
				[
					BASE_HEADER,
					`VALID | ${malformedDimension} | HIGH | correctness | src/a.ts:1 | valid claim | valid evidence | valid impact | HIGH | ORDINARY | `,
					`MALFORMED | ${malformedDimension} | URGENT | correctness | src/a.ts:2 | dropped claim | dropped evidence | dropped impact | HIGH | ORDINARY | `,
				].join('\n'),
				'base_explorer',
				[malformedDimension],
			),
		).toEqual(['VALID']);
	});

	test('Tier M preserves earlier valid evidence when a later retry is malformed', async () => {
		const originalResolveDiffStats = _test_exports.resolvePrReviewDiffStats;
		_test_exports.resolvePrReviewDiffStats = () => ({
			changedLines: 120,
			changedFiles: 5,
			hasSubmoduleChange: false,
		});
		try {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			await bindPrReviewBase(tempDir, SESSION_ID, {
				prHeadSha: HEAD_SHA,
				baseRef: 'origin/main',
				baseSha: 'def456',
			});
			const initialLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
				laneId: `initial-${workflowLane}`,
				workflowLane,
			}));
			await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, initialLanes, {
				batchId: 'tier-m-initial',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			});
			await persistBatch(
				'tier-m-initial',
				'swarm-pr-review:base',
				initialLanes,
				{ scope: 'complete PR diff def456...abc123' },
			);

			const retriedDimension = PR_REVIEW_BASE_DIMENSION_IDS[0];
			const retryLane = {
				laneId: 'later-malformed-retry',
				workflowLane: retriedDimension,
			};
			await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [retryLane], {
				batchId: 'tier-m-retry',
				prHeadSha: HEAD_SHA,
			});
			await persistBatch('tier-m-retry', 'swarm-pr-review:base', [retryLane], {
				scope: 'complete PR diff def456...abc123',
				textOverride: `${BASE_HEADER}\nBAD-CONFIDENCE | ${retriedDimension} | HIGH | correctness | src/b.ts:1 | claim | evidence | impact | 0.97 | ORDINARY | `,
			});

			await expect(
				assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
			).resolves.toMatchObject({
				state: { prReviewDepthTier: 'M', prHeadSha: HEAD_SHA },
			});
		} finally {
			_test_exports.resolvePrReviewDiffStats = originalResolveDiffStats;
		}
	});
});
