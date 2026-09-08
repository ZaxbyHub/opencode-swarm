import { describe, expect, test } from 'bun:test';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type { PrReviewWorkflowState } from '../../../src/pr-review/types.js';

const BASE: PrReviewWorkflowState = {
	sessionID: 'ses_reducer_1',
	workflowInstanceId: 'wfi_1',
	revision: 4,
	prHeadSha: 'abc123def',
};

const LANE = { laneId: 'lane-1', workflowLane: 'correctness-state' } as const;

describe('reducer: base admission lifecycle', () => {
	test('admits a base batch within the cap and persists', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'base_admission_requested',
			batchId: 'batch-1',
			lanes: [{ ...LANE }],
			depthTier: 'M',
			maxBatches: 128,
			validatedAt: '2026-09-01T00:00:00.000Z',
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.state.prReviewBaseDispatches).toHaveLength(1);
		expect(result.effects).toEqual([{ kind: 'persist_state' }]);
	});

	test('rejects admission at the batch cap', () => {
		const state: PrReviewWorkflowState = {
			...BASE,
			prReviewBaseDispatches: Array.from({ length: 128 }, (_, i) => ({
				batchId: `batch-${i}`,
				lanes: [{ ...LANE }],
				validatedAt: '2026-09-01T00:00:00.000Z',
			})),
		};
		const result = reducePrReviewEvent(state, {
			type: 'base_admission_requested',
			batchId: 'batch-129',
			lanes: [{ ...LANE }],
			depthTier: 'M',
			maxBatches: 128,
			validatedAt: '2026-09-01T00:00:00.000Z',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('base_batch_limit_reached');
		expect(result.state).toBe(state);
	});

	test('rolls back the last unlaunched batch only', () => {
		const state: PrReviewWorkflowState = {
			...BASE,
			prReviewBaseDispatches: [
				{ batchId: 'batch-1', lanes: [{ ...LANE }], validatedAt: 't' },
				{ batchId: 'batch-2', lanes: [{ ...LANE }], validatedAt: 't' },
			],
		};
		const rollbackLast = reducePrReviewEvent(state, {
			type: 'base_admission_rolled_back',
			batchId: 'batch-2',
			batchDelegationRecordsExist: false,
		});
		expect(rollbackLast.status).toBe('applied');
		if (rollbackLast.status !== 'applied') return;
		expect(
			rollbackLast.state.prReviewBaseDispatches?.map((b) => b.batchId),
		).toEqual(['batch-1']);

		const notLast = reducePrReviewEvent(state, {
			type: 'base_admission_rolled_back',
			batchId: 'batch-1',
			batchDelegationRecordsExist: false,
		});
		expect(notLast.status).toBe('rejected');
		if (notLast.status !== 'rejected') return;
		expect(notLast.rejection.code).toBe('rollback_preconditions_failed');

		const alreadyLaunched = reducePrReviewEvent(state, {
			type: 'base_admission_rolled_back',
			batchId: 'batch-2',
			batchDelegationRecordsExist: true,
		});
		expect(alreadyLaunched.status).toBe('rejected');
	});
});

describe('reducer: collection observation is side-effect free on state', () => {
	test('wait expiry produces a bounded diagnostic and NEVER a state mutation', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'collection_observed',
			diagnostic: 'wait_expired',
			pendingLaneIds: ['lane-1', 'lane-2'],
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.state).toBe(BASE);
		expect(result.effects).toEqual([
			{
				kind: 'emit_diagnostic',
				source: 'collection_observer',
				code: 'collection_wait_expired',
				boundedDetail: undefined,
			},
		]);
	});

	test('host-client absence is observation-only too', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'collection_observed',
			diagnostic: 'host_unavailable',
			pendingLaneIds: [],
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.state).toBe(BASE);
		expect(result.effects[0]?.kind).toBe('emit_diagnostic');
	});
});

describe('reducer: structured result submission (exactly-once)', () => {
	test('first submission settles the lane', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'lane_structured_result_submitted',
			batchId: 'batch-1',
			laneId: 'lane-1',
			generation: 4,
			semanticEnvelopeDigest: 'digest-a',
			outcome: 'CLEAN',
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.effects).toEqual([
			{
				kind: 'settle_delegation',
				batchId: 'batch-1',
				laneId: 'lane-1',
				status: 'completed',
			},
		]);
	});

	test('INCOMPLETE publishes the receipt and leaves the lane UNRESOLVED (never covered, never errored)', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'lane_structured_result_submitted',
			batchId: 'batch-1',
			laneId: 'lane-1',
			generation: 4,
			semanticEnvelopeDigest: 'digest-b',
			outcome: 'INCOMPLETE',
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		// No settle effect: issue #2384 keeps an INCOMPLETE lane unresolved
		// (the receipt publishes; coverage treats it as an unresolved
		// dimension — never covered, never a terminal error).
		expect(result.effects).toEqual([]);
	});

	test('semantic-equivalent replay is exactly-once', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'lane_structured_result_submitted',
			batchId: 'batch-1',
			laneId: 'lane-1',
			generation: 4,
			semanticEnvelopeDigest: 'digest-a',
			outcome: 'CLEAN',
			existingReceiptDigest: 'digest-a',
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.effects[0]).toMatchObject({ replay: true });
	});

	test('a conflicting second submission cannot overwrite the first', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'lane_structured_result_submitted',
			batchId: 'batch-1',
			laneId: 'lane-1',
			generation: 4,
			semanticEnvelopeDigest: 'digest-b',
			outcome: 'FINDINGS',
			existingReceiptDigest: 'digest-a',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('duplicate_conflicting_result');
	});

	test('a late old-generation result never mutates current state', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'lane_structured_result_submitted',
			batchId: 'batch-1',
			laneId: 'lane-1',
			generation: 3,
			semanticEnvelopeDigest: 'digest-a',
			outcome: 'CLEAN',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('stale_generation_result');
	});
});

// Issue #2512 wire-or-retire census: `transcript_evidence_presented`,
// `provider_terminal_observed`, and `lane_cancelled` were RETIRED from the
// PrReviewEvent union. Their rules live at the richer production authorities:
// - no-receipt-downgrade: validateExactStructuredReceiptCoverage + the
//   legacy-transcript compatibility gate in pr-workflow-gate.ts (covered by
//   tests/unit/pr-review/replay-corpus-transcript.test.ts);
// - invalid provider-terminal evidence classification:
//   classifyPrReviewCircuitSignal in src/pr-review/circuit.ts (covered by the
//   circuit classifier suites);
// - operator lane cancellation: collectOnce cancel_pending in
//   src/tools/dispatch-lanes.ts (covered by the dispatch-lanes cancel suites).
// The retired reducer cases were never dispatched in production; the
// registered-path table is docs/pr-review-transition-authority.md.
