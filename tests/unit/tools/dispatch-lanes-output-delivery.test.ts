/**
 * S1.1 — collect_lane_results output delivery de-duplication.
 *
 * `recordToLaneResult` in src/tools/dispatch-lanes.ts delivers inline
 * `output` only on the FIRST serialization of a given
 * `${batchId}\0${laneId}\0${digest}` key; repeat calls for the same settled
 * lane omit `output` and set `output_omitted_repeat: true` while preserving
 * every other metadata field, so a caller that needs the text again must use
 * `retrieve_lane_output` via `output_ref`. This prevents the repeated
 * preview from being the dominant controller-context driver in PR-review
 * compaction loops.
 *
 * This is pure unit coverage of `recordToLaneResult` itself: tests build
 * `BackgroundDelegationRecord` literals in memory and call
 * `_test_exports.recordToLaneResult` directly. There is no filesystem, no
 * delegation store, and no telemetry involved, so this file needs none of
 * the mock-isolation scaffolding used elsewhere in this directory.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { _test_exports } from '../../../src/tools/dispatch-lanes';

const { recordToLaneResult, resetDeliveredLaneOutputs } = _test_exports;

/** Build a settled (`completed`) delegation record with sensible defaults;
 * override any field, most commonly `laneId`, `batchId`, and `result`. */
function makeRecord(
	overrides: Partial<BackgroundDelegationRecord> = {},
): BackgroundDelegationRecord {
	return {
		schemaVersion: 2,
		correlationId: 'corr-1',
		jobId: null,
		subagentSessionId: 'corr-1',
		parentSessionId: 'parent-session',
		callID: 'call-1',
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		status: 'completed',
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_500,
		completedAt: 1_700_000_000_500,
		batchId: 'batch-1',
		laneId: 'runtime',
		...overrides,
	};
}

beforeEach(() => {
	resetDeliveredLaneOutputs();
});

describe('recordToLaneResult output delivery de-duplication (S1.1)', () => {
	test('first call for a batch/lane/digest includes inline output', () => {
		const record = makeRecord({
			result: {
				text: 'lane output body',
				chars: 17,
				truncated: false,
				digest: 'digest-1',
				outputRef: 'L1:aa:bb:cc',
			},
		});
		const result = _test_exports.recordToLaneResult(record, 'batch-1');
		expect(result.output).toBe('lane output body');
		expect(result.output_omitted_repeat).toBeUndefined();
	});

	test('second call for the SAME batch/lane/digest omits output and sets output_omitted_repeat', () => {
		const record = makeRecord({
			result: {
				text: 'lane output body',
				chars: 17,
				truncated: false,
				digest: 'digest-1',
				outputRef: 'L1:aa:bb:cc',
			},
		});
		recordToLaneResult(record, 'batch-1');
		const second = recordToLaneResult(record, 'batch-1');
		expect(second.output).toBeUndefined();
		expect(second.output_omitted_repeat).toBe(true);
	});

	test('repeat call preserves all other metadata fields', () => {
		const record = makeRecord({
			result: {
				text: 'lane output with metadata',
				chars: 26,
				truncated: true,
				digest: 'digest-meta',
				outputRef: 'L1:11:22:33',
				outputPreviewChars: 500,
				outputDegraded: false,
				transcriptIncomplete: false,
				messageCount: 4,
			},
		});
		recordToLaneResult(record, 'batch-1');
		const repeat = recordToLaneResult(record, 'batch-1');

		expect(repeat.output_omitted_repeat).toBe(true);
		expect(repeat.output).toBeUndefined();
		expect(repeat.output_chars).toBe(26);
		expect(repeat.output_truncated).toBe(true);
		expect(repeat.output_digest).toBe('digest-meta');
		expect(repeat.output_ref).toBe('L1:11:22:33');
		expect(repeat.output_preview_chars).toBe(500);
		expect(repeat.output_degraded).toBe(false);
		expect(repeat.transcript_incomplete).toBe(false);
		expect(repeat.message_count).toBe(4);
	});

	test('a record whose output digest changes (lane re-run) delivers inline output again', () => {
		const firstRun = makeRecord({
			correlationId: 'corr-rerun-1',
			result: {
				text: 'first run output',
				chars: 17,
				truncated: false,
				digest: 'digest-rerun-1',
			},
		});
		const first = recordToLaneResult(firstRun, 'batch-rerun');
		expect(first.output).toBe('first run output');

		// Same batch + lane id, but a NEW correlation record with a different
		// digest simulates a re-run of the same lane.
		const secondRun = makeRecord({
			correlationId: 'corr-rerun-2',
			result: {
				text: 'second run output, different content',
				chars: 37,
				truncated: false,
				digest: 'digest-rerun-2',
			},
		});
		const second = recordToLaneResult(secondRun, 'batch-rerun');
		expect(second.output).toBe('second run output, different content');
		expect(second.output_omitted_repeat).toBeUndefined();
	});

	test('a record with a missing digest fails open — inline output delivered every time', () => {
		const record = makeRecord({
			result: {
				text: 'output with no digest',
				chars: 22,
				truncated: false,
				digest: '',
			},
		});
		for (let i = 0; i < 3; i++) {
			const result = recordToLaneResult(record, 'batch-no-digest');
			expect(result.output).toBe('output with no digest');
			expect(result.output_omitted_repeat).toBeUndefined();
		}
	});

	test('pending/running records are unaffected by de-duplication', () => {
		const record = makeRecord({
			status: 'pending',
			completedAt: undefined,
			result: undefined,
		});
		const first = recordToLaneResult(record, 'batch-pending');
		expect(first.status).toBe('pending');
		expect(first.output).toBeUndefined();
		expect(first.output_omitted_repeat).toBeUndefined();

		const again = recordToLaneResult(record, 'batch-pending');
		expect(again.status).toBe('pending');
		expect(again.output_omitted_repeat).toBeUndefined();
	});

	test('two different lanes in the same batch are tracked independently', () => {
		const laneA = makeRecord({
			laneId: 'lane-a',
			correlationId: 'corr-a',
			result: {
				text: 'lane a output',
				chars: 13,
				truncated: false,
				digest: 'digest-shared',
			},
		});
		const laneB = makeRecord({
			laneId: 'lane-b',
			correlationId: 'corr-b',
			result: {
				text: 'lane b output',
				chars: 13,
				truncated: false,
				digest: 'digest-shared',
			},
		});

		const firstA = recordToLaneResult(laneA, 'batch-multi');
		expect(firstA.output).toBe('lane a output');

		// Delivering lane A must not suppress lane B's first delivery, even
		// though both share the same digest within the same batch.
		const firstB = recordToLaneResult(laneB, 'batch-multi');
		expect(firstB.output).toBe('lane b output');
		expect(firstB.output_omitted_repeat).toBeUndefined();

		const secondA = recordToLaneResult(laneA, 'batch-multi');
		expect(secondA.output).toBeUndefined();
		expect(secondA.output_omitted_repeat).toBe(true);
	});
});
