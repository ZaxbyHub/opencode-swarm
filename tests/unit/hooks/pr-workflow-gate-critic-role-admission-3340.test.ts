// Issue #3340 — gate-side critic admission (AC1) and the PR_FEEDBACK
// closeout-critic role decision (AC2), enforced at the gate boundary rather
// than only at the dispatch call site.
//
// AC1: `recordPrReviewValidationBatch` must reject any critic-phase lane whose
// declared agent does not resolve to exactly `critic` (#3310 enforced this at
// dispatch only). RED at base: the recorder accepted any lane spec.
//
// The AC2 PR_FEEDBACK closeout-critic role decision is covered by
// pr-feedback-closeout-critic-role-3340.test.ts.
//
// Issue item 2: `analyzeLaneArtifactIntegrity` now asserts the critic role for
// `swarm-pr-review:critic` artifacts instead of only checking that the artifact
// role matches the delegation record.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID as REVIEW_SESSION,
	tempDir as reviewTempDir,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
} from './pr-workflow-gate.test-fixtures.js';

const ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension: string, index: number) => `C-${index}`,
);

const REVIEWER_ROWS = ITEM_IDS.map(
	(itemId: string) =>
		`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | LOW | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer`,
).join('\n');
const CRITIC_ROWS = ITEM_IDS.map(
	(itemId: string) =>
		`[CRITIC] | ${itemId} | UPHELD | LOW | reason long enough | required change text`,
).join('\n');

const ROLE_REJECTION = /must use the critic agent/;
const AGENT_DECLARATION_REJECTION = /must declare its agent/;

describe('issue #3340 AC1: gate-side critic admission in recordPrReviewValidationBatch', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('rejects a critic lane whose declared agent is critic_finding_validator (bypassing dispatch)', async () => {
		await expect(
			recordPrReviewValidationBatch(
				reviewTempDir,
				REVIEW_SESSION,
				'critic',
				[
					{
						laneId: 'critic-bad-role',
						workflowLane: 'critic-bad-role',
						reviewItemIds: ITEM_IDS,
						agent: 'critic_finding_validator',
					},
				],
				{ batchId: 'critic-bad-role', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow(ROLE_REJECTION);
	});

	test('rejects a critic lane that declares no agent at all (fail closed)', async () => {
		await expect(
			recordPrReviewValidationBatch(
				reviewTempDir,
				REVIEW_SESSION,
				'critic',
				[
					{
						laneId: 'critic-no-agent',
						workflowLane: 'critic-no-agent',
						reviewItemIds: ITEM_IDS,
					},
				],
				{ batchId: 'critic-no-agent', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow(AGENT_DECLARATION_REJECTION);
	});

	test('rejects an unregistered prefixed name when the generated-name registry is supplied (dispatch parity)', async () => {
		// 'foo_critic' is not a generated agent name; the strict registry
		// resolution must not collapse it onto the critic role.
		await expect(
			recordPrReviewValidationBatch(
				reviewTempDir,
				REVIEW_SESSION,
				'critic',
				[
					{
						laneId: 'critic-foreign-suffix',
						workflowLane: 'critic-foreign-suffix',
						reviewItemIds: ITEM_IDS,
						agent: 'foo_critic',
					},
				],
				{
					batchId: 'critic-foreign-suffix',
					prHeadSha: HEAD_SHA,
					generatedAgentNames: ['mega_critic', 'mega_reviewer'],
				},
			),
		).rejects.toThrow(ROLE_REJECTION);
	});

	test("admits a registered prefixed critic agent ('mega_critic') — never a role rejection", async () => {
		// The batch may later be refused for unrelated setup reasons on this
		// fixture; the assertion is that the role rule itself is satisfied.
		let lateError: unknown = null;
		try {
			await recordPrReviewValidationBatch(
				reviewTempDir,
				REVIEW_SESSION,
				'critic',
				[
					{
						laneId: 'critic-prefixed',
						workflowLane: 'critic-prefixed',
						reviewItemIds: ITEM_IDS,
						agent: 'mega_critic',
					},
				],
				{
					batchId: 'critic-prefixed',
					prHeadSha: HEAD_SHA,
					generatedAgentNames: ['mega_critic', 'mega_reviewer'],
				},
			);
		} catch (error) {
			lateError = error;
		}
		expect(lateError === null || !ROLE_REJECTION.test(String(lateError))).toBe(
			true,
		);
	});

	test('records the batch when the declared agent is exactly critic', async () => {
		await establishReviewPrerequisites();
		const reviewerLanes = [
			{ laneId: 'rv-3340', workflowLane: 'rv-3340', reviewItemIds: ITEM_IDS },
		];
		await recordPrReviewValidationBatch(
			reviewTempDir,
			REVIEW_SESSION,
			'reviewer',
			reviewerLanes,
			{ batchId: 'rv-3340', prHeadSha: HEAD_SHA },
		);
		await persistBatch('rv-3340', 'swarm-pr-review:reviewer', reviewerLanes, {
			textOverride: REVIEWER_ROWS,
		});
		await recordPrReviewValidationBatch(
			reviewTempDir,
			REVIEW_SESSION,
			'critic',
			[
				{
					laneId: 'critic-3340',
					workflowLane: 'critic-3340',
					reviewItemIds: ITEM_IDS,
					agent: 'critic',
				},
			],
			{ batchId: 'critic-3340', prHeadSha: HEAD_SHA },
		);
		// Recording succeeded; prove the batch is durable by persisting its
		// artifact and settling the critic phase on the real composition path.
		const criticLanes = [
			{
				laneId: 'critic-3340',
				workflowLane: 'critic-3340',
				reviewItemIds: ITEM_IDS,
			},
		];
		await persistBatch('critic-3340', 'swarm-pr-review:critic', criticLanes, {
			textOverride: CRITIC_ROWS,
		});
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			reviewTempDir,
			REVIEW_SESSION,
			'critic',
		);
		expect(composed.unclaimed).toEqual([]);
	});
});

describe('issue #3340 item 2: critic-mode artifact integrity asserts the critic role', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('a critic lane whose child record ran critic_finding_validator cannot claim items', async () => {
		await establishReviewPrerequisites();
		const reviewerLanes = [
			{
				laneId: 'rv-wrong-role',
				workflowLane: 'rv-wrong-role',
				reviewItemIds: ITEM_IDS,
			},
		];
		await recordPrReviewValidationBatch(
			reviewTempDir,
			REVIEW_SESSION,
			'reviewer',
			reviewerLanes,
			{ batchId: 'rv-wrong-role', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'rv-wrong-role',
			'swarm-pr-review:reviewer',
			reviewerLanes,
			{ textOverride: REVIEWER_ROWS },
		);
		// The batch is admitted at record time (the lane declares the critic
		// agent), but the child delegation record that actually ran carries
		// critic_finding_validator — artifact + record are self-consistent on
		// that wrong role, so only the role assertion can reject the pair.
		await recordPrReviewValidationBatch(
			reviewTempDir,
			REVIEW_SESSION,
			'critic',
			[
				{
					laneId: 'critic-wrong-role',
					workflowLane: 'critic-wrong-role',
					reviewItemIds: ITEM_IDS,
					agent: 'critic',
				},
			],
			{ batchId: 'critic-wrong-role', prHeadSha: HEAD_SHA },
		);
		const criticLanes = [
			{
				laneId: 'critic-wrong-role',
				workflowLane: 'critic-wrong-role',
				reviewItemIds: ITEM_IDS,
			},
		];
		await persistBatch(
			'critic-wrong-role',
			'swarm-pr-review:critic',
			criticLanes,
			{ textOverride: CRITIC_ROWS, recordAgent: 'critic_finding_validator' },
		);
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			reviewTempDir,
			REVIEW_SESSION,
			'critic',
		);
		expect(composed.claims.size).toBe(0);
		expect(composed.unclaimed).toEqual(ITEM_IDS);
	});
});
