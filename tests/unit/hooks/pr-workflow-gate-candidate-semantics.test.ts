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
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';

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
		});
		await persistBatch(
			'semantic-bad',
			'swarm-pr-review:base',
			[malformedLane],
			{
				textOverride: [
					BASE_HEADER,
					`BAD-SEVERITY | ${malformedDimension} | BLOCKER-${'x'.repeat(100_000)} | correctness | src/a.ts:1 | claim | evidence | impact | HIGH`,
					'BAD-LANE | not-a-real-lane | HIGH | correctness | src/a.ts:2 | claim | evidence | impact | HIGH',
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
		expect(diagnostic).toMatch(/batch=semantic-bad.*lane=bad-intent-output/);
		expect(diagnostic).toContain('predicate=discovery.row');
		expect(diagnostic).toMatch(
			/row 2 field severity: Invalid severity: BLOCKER/,
		);
		// The structured diagnostic is deliberately first-failure-only; a later
		// malformed row cannot replace the deterministic severity predicate.
		expect(diagnostic).not.toContain('not-a-real-lane');
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
		});
		await persistBatch('semantic-mixed', 'swarm-pr-review:base', [mixedLane], {
			textOverride: [
				BASE_HEADER,
				`VALID | ${malformedDimension} | HIGH | correctness | src/a.ts:1 | valid claim | valid evidence | valid impact | HIGH`,
				`MALFORMED | ${malformedDimension} | URGENT | correctness | src/a.ts:2 | dropped claim | dropped evidence | dropped impact | HIGH`,
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
					`VALID | ${malformedDimension} | HIGH | correctness | src/a.ts:1 | valid claim | valid evidence | valid impact | HIGH`,
					`MALFORMED | ${malformedDimension} | URGENT | correctness | src/a.ts:2 | dropped claim | dropped evidence | dropped impact | HIGH`,
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
				textOverride: `${BASE_HEADER}\nBAD-CONFIDENCE | ${retriedDimension} | HIGH | correctness | src/b.ts:1 | claim | evidence | impact | 0.97`,
			});

			await expect(
				assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
			).resolves.toMatchObject({
				prReviewDepthTier: 'M',
				prHeadSha: HEAD_SHA,
			});
		} finally {
			_test_exports.resolvePrReviewDiffStats = originalResolveDiffStats;
		}
	});
});
