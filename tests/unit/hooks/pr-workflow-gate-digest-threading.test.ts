import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewBaseCoverageSettled,
	assertPrReviewValidationSettled,
	completePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const CANDIDATE_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

/**
 * Replace the digest seam with a counting stub. `setupPrWorkflowGateFixtures`
 * already routes the gate's async resolver through this synchronous member, so
 * the counter observes exactly the resolutions production performs.
 */
function countDigestResolutions(result: string | null = REVISION_DIGEST): {
	calls: () => number;
	reset: () => void;
} {
	let calls = 0;
	gateInternals.resolvePrWorkflowRevisionDigest = () => {
		calls += 1;
		return result;
	};
	return { calls: () => calls, reset: () => (calls = 0) };
}

async function settleReviewer(
	classification = 'DISPROVED',
	severity = 'NONE',
): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: 'review-all',
				workflowLane: 'review-all',
				reviewItemIds: CANDIDATE_IDS,
			},
		],
		{ batchId: 'review-all', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'review-all',
		'swarm-pr-review:reviewer',
		[{ laneId: 'review-all', workflowLane: 'review-all' }],
		{
			textOverride: CANDIDATE_IDS.map(
				(id) =>
					`[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | NO | file.ts:1 | rationale | probe | reviewer`,
			).join('\n'),
		},
	);
}

describe('pr-workflow-gate revision digest threading', () => {
	test('base coverage resolves the current revision digest exactly once', async () => {
		await establishReviewPrerequisites();
		const counter = countDigestResolutions();
		await assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID);
		// Six base dimension records plus eleven micro records were checked; the
		// pre-fix per-record fallback resolved once per record.
		expect(counter.calls()).toBe(1);
	});

	test('reviewer settlement resolves the current revision digest exactly once', async () => {
		await establishReviewPrerequisites();
		await settleReviewer();
		const counter = countDigestResolutions();
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		expect(counter.calls()).toBe(1);
	});

	test('the terminal completion chain shares one digest across every pass', async () => {
		await establishReviewPrerequisites();
		await settleReviewer();
		const counter = countDigestResolutions();
		// Base coverage, council/reviewer settlement, the critic-inventory
		// derivation and the candidate-inventory scan all run under this call.
		// INTENT CHANGE (issue #2383): completion first derives the terminal
		// N-of-6 settlement (one digest resolution) and then runs the
		// terminal-ready ladder via its own gate context (a second), so the
		// chain now resolves the digest exactly twice.
		await expect(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'APPROVE',
			}),
		).rejects.toThrow('durable findings checkpoints');
		expect(counter.calls()).toBe(2);
	});

	test('a batch record dispatch resolves one digest per gate entry point', async () => {
		await establishReviewPrerequisites();
		const counter = countDigestResolutions();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-all',
					workflowLane: 'review-all',
					reviewItemIds: CANDIDATE_IDS,
				},
			],
			{ batchId: 'review-all', prHeadSha: HEAD_SHA },
		);
		expect(counter.calls()).toBe(1);
	});

	test('a critic dispatch resolves one digest across settle-then-recompose', async () => {
		await establishReviewPrerequisites();
		await settleReviewer('CONFIRMED', 'HIGH');
		const counter = countDigestResolutions();
		// This entry point settles the reviewer phase with a threaded context,
		// then re-derives the critic inventory and the per-item reviewer row
		// bindings against the re-read state. All of it shares one digest.
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-all',
					workflowLane: 'critic-all',
					reviewItemIds: CANDIDATE_IDS,
				},
			],
			{ batchId: 'critic-all', prHeadSha: HEAD_SHA },
		);
		expect(counter.calls()).toBe(1);
	});

	test('a bounded-snapshot failure names the exact bound that fired', async () => {
		await establishReviewPrerequisites();
		const original = gateInternals.resolvePrWorkflowRevisionDigestDetailed;
		try {
			// P2.2: the detailed seam takes priority over the legacy `string | null`
			// one, so a focused test can drive one specific reason.
			gateInternals.resolvePrWorkflowRevisionDigestDetailed = () => ({
				ok: false,
				reason: 'file-cap',
				detail: '61234 changed paths exceed the cap of 50000',
			});
			const capError = await assertPrReviewBaseCoverageSettled(
				tempDir,
				SESSION_ID,
			).then(
				() => null,
				(reason: unknown) => reason as Error,
			);
			expect(capError?.message).toContain('REVISION_MAX_FILES');
			expect(capError?.message).toContain(
				'61234 changed paths exceed the cap of 50000',
			);
			// The old message listed every bound at once, so it could not have been
			// distinguished from a truncated enumeration.
			expect(capError?.message).not.toContain('GIT_SNAPSHOT_MAX_BUFFER');

			gateInternals.resolvePrWorkflowRevisionDigestDetailed = () => ({
				ok: false,
				reason: 'buffer-truncated',
				detail: 'git diff --name-only output exceeded the bounded buffer',
			});
			const truncationError = await assertPrReviewBaseCoverageSettled(
				tempDir,
				SESSION_ID,
			).then(
				() => null,
				(reason: unknown) => reason as Error,
			);
			expect(truncationError?.message).toContain('GIT_SNAPSHOT_MAX_BUFFER');
			expect(truncationError?.message).not.toContain('REVISION_MAX_FILES');
		} finally {
			gateInternals.resolvePrWorkflowRevisionDigestDetailed = original;
		}
	});

	test('an unresolvable digest blocks with the bounds it could not satisfy', async () => {
		await establishReviewPrerequisites();
		await settleReviewer();
		countDigestResolutions(null);
		// Never threaded as `undefined`: that would silently restore the
		// per-record synchronous fallback inside the marker check.
		for (const entryPoint of [
			() => assertPrReviewBaseCoverageSettled(tempDir, SESSION_ID),
			() => assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
			() =>
				completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
					reportVerdict: 'APPROVE',
				}),
		]) {
			const error = await entryPoint().then(
				() => null,
				(reason: unknown) => reason as Error,
			);
			expect(error?.message).toContain(
				'BLOCKED: PR_REVIEW could not compute a bounded current-revision digest',
			);
			expect(error?.message).toContain('REVISION_MAX_FILES');
			expect(error?.message).toContain('REVISION_MAX_TOTAL_BYTES');
			expect(error?.message).toContain('GIT_SNAPSHOT_MAX_BUFFER');
		}
	});
});
