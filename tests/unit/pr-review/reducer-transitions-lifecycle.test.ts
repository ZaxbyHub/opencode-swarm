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

describe('reducer: base-admission rollback', () => {
	test('rolls back the last unlaunched batch only', () => {
		const state: PrReviewWorkflowState = {
			...BASE,
			prReviewBaseDispatches: [
				{ batchId: 'batch-1', lanes: [{ ...LANE }], validatedAt: 't' },
				{ batchId: 'batch-2', lanes: [{ ...LANE }], validatedAt: 't' },
			],
		};
		const result = reducePrReviewEvent(state, {
			type: 'base_admission_rolled_back',
			batchId: 'batch-2',
			batchDelegationRecordsExist: false,
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(
			result.state.prReviewBaseDispatches?.map((batch) => batch.batchId),
		).toEqual(['batch-1']);
		expect(result.state.prReviewBaseDispatch?.batchId).toBe('batch-1');
		expect(result.effects).toEqual([{ kind: 'persist_state' }]);
	});

	test('rejects non-tail and already-launched rollback without mutation', () => {
		const state: PrReviewWorkflowState = {
			...BASE,
			prReviewBaseDispatches: [
				{ batchId: 'batch-1', lanes: [{ ...LANE }], validatedAt: 't' },
				{ batchId: 'batch-2', lanes: [{ ...LANE }], validatedAt: 't' },
			],
		};
		const notLast = reducePrReviewEvent(state, {
			type: 'base_admission_rolled_back',
			batchId: 'batch-1',
			batchDelegationRecordsExist: false,
		});
		expect(notLast.status).toBe('rejected');
		if (notLast.status === 'rejected') {
			expect(notLast.rejection.code).toBe('rollback_preconditions_failed');
		}
		expect(notLast.state).toBe(state);

		const alreadyLaunched = reducePrReviewEvent(state, {
			type: 'base_admission_rolled_back',
			batchId: 'batch-2',
			batchDelegationRecordsExist: true,
		});
		expect(alreadyLaunched.status).toBe('rejected');
		if (alreadyLaunched.status === 'rejected') {
			expect(alreadyLaunched.rejection.code).toBe(
				'rollback_preconditions_failed',
			);
		}
		expect(alreadyLaunched.state).toBe(state);
	});
});

describe('reducer: collection observation is side-effect free on state', () => {
	test('wait expiry produces a bounded diagnostic and no state mutation', () => {
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

	test('INCOMPLETE publishes the receipt but leaves the lane unresolved', () => {
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
		expect(result.state).toBe(BASE);
	});
});
