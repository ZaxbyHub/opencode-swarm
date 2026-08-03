import { describe, expect, test } from 'bun:test';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { _test_exports } from '../../../src/tools/dispatch-lanes';

const buildCollectResult = _test_exports.buildCollectResult as (
	batchId: string,
	records: BackgroundDelegationRecord[],
	includePending: boolean,
) => {
	success: boolean;
	pending: number;
	all_settled: boolean;
	lane_results: Array<{ status: string }>;
};

function ingestingRecord(): BackgroundDelegationRecord {
	return {
		schemaVersion: 2,
		correlationId: 'child-session',
		jobId: 'job-1',
		subagentSessionId: 'child-session',
		parentSessionId: 'parent-session',
		callID: 'call-1',
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: '1.1',
		evidenceTaskId: '1.1',
		batchId: 'batch-1',
		laneId: 'lane-1',
		status: 'ingesting',
		createdAt: 100,
		updatedAt: 200,
		ingestionId: 'lease-1',
		ingestionStartedAt: 200,
		ingestionDigest: 'digest-1',
	};
}

describe('collect_lane_results ingesting status', () => {
	test('keeps an active ingestion lease pending in aggregate and per-lane views', () => {
		const hidden = buildCollectResult('batch-1', [ingestingRecord()], false);
		expect(hidden).toMatchObject({
			success: false,
			pending: 1,
			all_settled: false,
		});
		expect(hidden.lane_results).toEqual([]);

		const included = buildCollectResult('batch-1', [ingestingRecord()], true);
		expect(included).toMatchObject({
			success: false,
			pending: 1,
			all_settled: false,
		});
		expect(included.lane_results).toEqual([
			expect.objectContaining({ status: 'pending' }),
		]);
	});
});
