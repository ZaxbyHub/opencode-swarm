import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts,
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
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const BASE_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

const assertB1 = gateInternals.assertSettledPhaseHasAuthoritativeVerdicts;

const reviewed = (
	ids: readonly string[],
	classification = 'CONFIRMED',
	severity = 'HIGH',
): string =>
	ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale | probe | reviewer`,
		)
		.join('\n');

const criticised = (ids: readonly string[]): string =>
	ids
		.map((id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | required change`)
		.join('\n');

/** Declare a reviewer batch over one lane owning every id, then settle it. */
async function settleReviewerPhase(
	batchId: string,
	rows: string,
	itemIds: readonly string[] = BASE_IDS,
): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${batchId}-a`,
				workflowLane: `${batchId}-a`,
				reviewItemIds: [...itemIds],
			},
		],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId: `${batchId}-a`, workflowLane: `${batchId}-a` }],
		{ textOverride: rows, subagentSessionId: `${batchId}-a` },
	);
}

async function settleCriticPhase(
	batchId: string,
	itemIds: readonly string[],
): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'critic',
		[
			{
				laneId: batchId,
				workflowLane: batchId,
				reviewItemIds: [...itemIds],
			},
		],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		batchId,
		'swarm-pr-review:critic',
		[{ laneId: batchId, workflowLane: batchId }],
		{ textOverride: criticised(itemIds), subagentSessionId: batchId },
	);
}

function errorFrom(promise: Promise<unknown>): Promise<Error | null> {
	return promise.then(
		() => null,
		(reason: unknown) => reason as Error,
	);
}

describe('pr-workflow-gate B1 invariant: settled phase implies a covering verdict map', () => {
	test('an EMPTY reviewer map after settlement blocks and names the real cause', () => {
		let thrown: Error | null = null;
		try {
			assertB1(
				'reviewer',
				{ requiredInventory: [...BASE_IDS], unclaimed: [] },
				new Map(),
				'unit(reviewer)',
			);
		} catch (error) {
			thrown = error as Error;
		}
		expect(thrown).not.toBeNull();
		const message = thrown?.message ?? '';
		// Names the phase, the emptiness, that settlement succeeded, and the
		// consequence — instead of the misleading downstream "no authoritative
		// reviewer verdict" that names a symptom.
		expect(message).toContain('BLOCKED: PR_REVIEW internal invariant violated');
		expect(message).toContain('unit(reviewer)');
		expect(message).toContain(
			'the reviewer phase settled over 6 required item',
		);
		expect(message).toContain(
			'verdict map is EMPTY after successful settlement',
		);
		expect(message).toContain('skips the critic-coverage gate');
		expect(message).toContain(
			`missing reviewer verdicts for: ${BASE_IDS.join(', ')}`,
		);
		expect(message).not.toContain('no authoritative reviewer verdict');
	});

	test('a PARTIAL reviewer map blocks and names only the uncovered items', () => {
		const covered = BASE_IDS.slice(0, 4);
		const missing = BASE_IDS.slice(4);
		const error = (() => {
			try {
				assertB1(
					'reviewer',
					{ requiredInventory: [...BASE_IDS], unclaimed: [] },
					new Map(covered.map((id) => [id, {}])),
					'unit(partial)',
				);
				return null;
			} catch (reason) {
				return reason as Error;
			}
		})();
		expect(error?.message).toContain('PARTIAL (4 of 6 items)');
		expect(error?.message).toContain(
			`missing reviewer verdicts for: ${missing.join(', ')}`,
		);
		for (const claimed of covered) {
			expect(error?.message).not.toContain(`${claimed},`);
		}
	});

	test('the critic phase is covered by the same invariant, with its own cause', () => {
		const error = (() => {
			try {
				assertB1(
					'critic',
					{ requiredInventory: [...BASE_IDS], unclaimed: [] },
					new Map(),
					'unit(critic)',
				);
				return null;
			} catch (reason) {
				return reason as Error;
			}
		})();
		expect(error?.message).toContain(
			'the critic phase settled over 6 required',
		);
		expect(error?.message).toContain(
			'verdict map is EMPTY after successful settlement',
		);
		expect(error?.message).toContain(
			'silently drops challenges the gate already accepted',
		);
		expect(error?.message).toContain(
			`missing critic verdicts for: ${BASE_IDS.join(', ')}`,
		);
	});

	test('an UNSETTLED phase legitimately projects an empty map and is allowed', () => {
		// Pre-existing fail-closed semantics: derivation returns an empty map
		// until the phase is item-complete. The invariant must not fire there or
		// it would break every mid-flight gate call.
		expect(() =>
			assertB1(
				'reviewer',
				{ requiredInventory: [...BASE_IDS], unclaimed: [BASE_IDS[5]] },
				new Map(),
				'unit(unsettled)',
			),
		).not.toThrow();
	});

	test('an empty required inventory legitimately yields an empty map', () => {
		expect(() =>
			assertB1(
				'reviewer',
				{ requiredInventory: [], unclaimed: [] },
				new Map(),
				'unit(empty)',
			),
		).not.toThrow();
		expect(() =>
			assertB1(
				'critic',
				{ requiredInventory: [], unclaimed: [] },
				new Map(),
				'unit(empty)',
			),
		).not.toThrow();
	});

	test('the violation message is bounded and degrades to a count', () => {
		const many = Array.from({ length: 64 }, (_value, index) => `I-${index}`);
		const error = (() => {
			try {
				assertB1(
					'reviewer',
					{ requiredInventory: many, unclaimed: [] },
					new Map(),
					'unit(bounded)',
				);
				return null;
			} catch (reason) {
				return reason as Error;
			}
		})();
		// MAX_UNCLAIMED_ITEMS_IN_MESSAGE names 50; the rest collapse to a count.
		expect(error?.message).toContain('I-49');
		expect(error?.message).not.toContain('I-50');
		expect(error?.message).toContain('(+14 more)');
	});
});

describe('pr-workflow-gate B1 invariant: no false positives on the settled path', () => {
	test('a normally settled reviewer phase yields a map covering the full inventory', async () => {
		await establishReviewPrerequisites();
		await settleReviewerPhase('rv-1', reviewed(BASE_IDS));
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		// Production entry point that reads the authoritative reviewer map for
		// every item. It resolves only if the map covers all six ids, so this is
		// the positive statement of the B1 property through real code.
		await expect(
			assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
				tempDir,
				SESSION_ID,
				'post_reviewer',
				BASE_IDS.map((findingId) => ({
					finding_id: findingId,
					status: 'CONFIRMED',
					next_action: 'route_to_critic',
					severity: 'HIGH',
				})),
			),
		).resolves.toBeUndefined();
	});

	test('a normally settled critic phase does not trigger the invariant', async () => {
		await establishReviewPrerequisites();
		await settleReviewerPhase('rv-1', reviewed(BASE_IDS));
		await settleCriticPhase('critic-all', BASE_IDS);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		await expect(
			assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
				tempDir,
				SESSION_ID,
				'post_critic',
				BASE_IDS.map((findingId) => ({
					finding_id: findingId,
					status: 'CONFIRMED',
					next_action: 'report',
					severity: 'HIGH',
				})),
			),
		).resolves.toBeUndefined();
	});

	test('an unsettled reviewer phase still reports settlement, not the invariant', async () => {
		await establishReviewPrerequisites();
		// One item never gets a verdict: the phase is not settled, so the
		// antecedent is false and the pre-existing diagnostics must survive.
		await settleReviewerPhase('rv-short', reviewed(BASE_IDS.slice(0, -1)));
		const settlement = await errorFrom(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		);
		expect(settlement?.message).toContain(
			`reviewer items lack an authenticated verdict from any successful lane: ${BASE_IDS.at(-1)}`,
		);
		expect(settlement?.message).not.toContain('internal invariant violated');
		// The critic-coverage gate is never reached silently: completion blocks on
		// reviewer settlement first, so critic coverage cannot be skipped.
		const completion = await errorFrom(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		);
		expect(completion?.message).toContain(
			'reviewer items lack an authenticated verdict',
		);
		// The artifact-record gate does not settle first, so its per-record
		// message is still the correct diagnostic for an unsettled phase.
		const projection = await errorFrom(
			assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
				tempDir,
				SESSION_ID,
				'post_reviewer',
				[
					{
						finding_id: BASE_IDS[0],
						status: 'CONFIRMED',
						next_action: 'route_to_critic',
					},
				],
			),
		);
		// Third case, distinct from both empty-inventory outcomes: if a future
		// refactor stops settling reviewer before the critic-coverage decision,
		// the resulting empty critic inventory BLOCKS naming reviewer
		// unsettledness rather than silently skipping critic coverage.
		const coverage = await errorFrom(
			gateInternals.derivePrReviewCriticInventoryForCoverageGate(
				tempDir,
				SESSION_ID,
				'unit(coverage-gate)',
			),
		);
		expect(coverage?.message).toContain(
			'BLOCKED: PR_REVIEW internal invariant violated at unit(coverage-gate)',
		);
		expect(coverage?.message).toContain(
			'the critic-coverage decision requires a settled reviewer phase',
		);
		expect(coverage?.message).toContain(
			`unsettled reviewer items: ${BASE_IDS.at(-1)}`,
		);
		// Not confusable with the B1 empty-map message.
		expect(coverage?.message).not.toContain('after successful settlement');
		expect(projection?.message).toContain(
			`${BASE_IDS[0]}: no authoritative reviewer verdict (absent from the settled reviewer map)`,
		);
		expect(projection?.message).not.toContain('internal invariant violated');
	});
});

describe('pr-workflow-gate B1 invariant: a legitimately empty critic inventory', () => {
	test('no CONFIRMED CRITICAL/HIGH/MEDIUM verdict means critic coverage is genuinely not required', async () => {
		await establishReviewPrerequisites();
		// Every item is DISPROVED/LOW: the reviewer map is fully populated, and
		// the critic inventory is empty because the *filter* excluded everything.
		await settleReviewerPhase(
			'rv-clean',
			reviewed(BASE_IDS, 'DISPROVED', 'LOW'),
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		const error = await errorFrom(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		);
		// It passed the critic-coverage gate (no critic-related block, no
		// invariant violation) and stopped at the next unrelated obligation.
		expect(error?.message).toContain('requires durable findings checkpoints');
		expect(error?.message).not.toContain('internal invariant violated');
		expect(error?.message).not.toContain('require critic coverage');
		// Distinguishable from the pathological case: the reviewer map that
		// produced the empty inventory covers every required item, which this
		// gate resolving proves.
		await expect(
			assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
				tempDir,
				SESSION_ID,
				'post_reviewer',
				BASE_IDS.map((findingId) => ({
					finding_id: findingId,
					status: 'DISPROVED',
					next_action: 'suppress_with_reason',
					severity: 'LOW',
				})),
			),
		).resolves.toBeUndefined();
	});

	test('a mixed inventory keeps only the qualifying items in critic coverage', async () => {
		await establishReviewPrerequisites();
		const challenged = BASE_IDS.slice(0, 2);
		const suppressed = BASE_IDS.slice(2);
		await settleReviewerPhase(
			'rv-mixed',
			`${reviewed(challenged)}\n${reviewed(suppressed, 'DISPROVED', 'LOW')}`,
		);
		const error = await errorFrom(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		);
		// Non-empty critic inventory: coverage is demanded for exactly the two
		// CONFIRMED/HIGH items and nothing else.
		expect(error?.message).toBe(
			`BLOCKED: PR_REVIEW reviewer verdicts require critic coverage for: ${challenged.join(', ')}`,
		);
		await settleCriticPhase('critic-two', challenged);
		const next = await errorFrom(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		);
		expect(next?.message).toContain('requires durable findings checkpoints');
		expect(next?.message).not.toContain('internal invariant violated');
	});
});
