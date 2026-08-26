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
import {
	_test_exports,
	executeDispatchLanes,
} from '../../../src/tools/dispatch-lanes';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

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
				workflowLaneFailureClass: 'contract',
				salvagedWorkflowLanes: ['correctness-state'],
				salvagedWorkflowLaneRecoveries: [
					{
						workflowLane: 'correctness-state',
						kind: 'parser-normalization',
						reason: 'structural repairs applied: synthesized-header',
					},
				],
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
		expect(repeat.workflow_lane_failure_class).toBe('contract');
		expect(repeat.salvaged_workflow_lanes).toEqual(['correctness-state']);
		expect(repeat.salvaged_workflow_lane_recoveries).toEqual([
			{
				workflow_lane: 'correctness-state',
				kind: 'parser-normalization',
				reason: 'structural repairs applied: synthesized-header',
			},
		]);
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

	test('a record with a digest but missing outputRef fails open — inline output delivered every time, never output_omitted_repeat (R1)', () => {
		const record = makeRecord({
			result: {
				text: 'output with digest but no ref',
				chars: 30,
				truncated: false,
				digest: 'digest-no-ref',
				// outputRef intentionally omitted: simulates storeLaneOutput
				// failing to persist a durable ref (oversized text, ref
				// collision, or an fs error) while the digest still computed.
			},
		});
		for (let i = 0; i < 3; i++) {
			const result = recordToLaneResult(record, 'batch-no-ref');
			expect(result.output).toBe('output with digest but no ref');
			expect(result.output_omitted_repeat).toBeUndefined();
			expect(result.output_ref).toBeUndefined();
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
				outputRef: 'L1:aa:aa:aa',
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
				outputRef: 'L1:bb:bb:bb',
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

/**
 * `evictDeliveredLaneOutputsIfOverBound` (src/tools/dispatch-lanes.ts:96-102)
 * FIFO-evicts the oldest `deliveredLaneOutputs` key once the module-level Set
 * exceeds `MAX_TRACKED_DELIVERED_LANE_OUTPUTS` (1024). The Set itself is not
 * exported, so this test drives the bound through the same public seam the
 * sibling tests above use (`_test_exports.recordToLaneResult`, which is the
 * only production call site that adds to the Set — see line 1925-1926) and
 * observes eviction indirectly: a key that should have been evicted stops
 * being reported as "already delivered" (inline `output` reappears), while a
 * key that should have survived keeps being reported as delivered
 * (`output_omitted_repeat: true`).
 */
describe('deliveredLaneOutputs eviction bound (evictDeliveredLaneOutputsIfOverBound)', () => {
	test('FIFO-evicts the oldest key once the tracked set exceeds the 1024 bound', () => {
		const batchId = 'batch-evict';
		const laneId = 'lane-evict';
		const keyRecord = (index: number) =>
			makeRecord({
				correlationId: `corr-evict-${index}`,
				laneId,
				batchId,
				result: {
					text: `output ${index}`,
					chars: 8,
					truncated: false,
					digest: `digest-evict-${index}`,
					outputRef: `L1:evict:${index}`,
				},
			});

		// Insert one more key than the bound allows (0..1024 inclusive = 1025
		// distinct keys). The 1025th insert pushes the Set to size 1025, which
		// triggers exactly one eviction of the oldest key (index 0).
		for (let i = 0; i <= 1024; i++) {
			const result = recordToLaneResult(keyRecord(i), batchId);
			// Every insert here is a first-ever delivery of a brand-new key, so
			// each call must report inline output, never a repeat.
			expect(result.output).toBe(`output ${i}`);
			expect(result.output_omitted_repeat).toBeUndefined();
		}

		// Index 1 is still within the 1024-entry bound (indices 1..1024
		// survived) — re-delivering it must be recognized as already
		// delivered. Check this BEFORE touching index 0, since re-delivering
		// index 0 below re-inserts it and evicts whatever is currently oldest.
		const repeatOfSurvivor = recordToLaneResult(keyRecord(1), batchId);
		expect(repeatOfSurvivor.output).toBeUndefined();
		expect(repeatOfSurvivor.output_omitted_repeat).toBe(true);

		// Index 0 was the oldest key and must have been evicted by the 1025th
		// insert. Because it is no longer tracked, delivering it again must be
		// treated as a first-ever delivery (inline output, not a repeat). If
		// the eviction bound were removed or raised, index 0 would still be
		// tracked and this would incorrectly report output_omitted_repeat.
		const redeliveredEvictee = recordToLaneResult(keyRecord(0), batchId);
		expect(redeliveredEvictee.output).toBe('output 0');
		expect(redeliveredEvictee.output_omitted_repeat).toBeUndefined();
	});
});

/**
 * `boundZodIssues` (src/tools/dispatch-lanes.ts:111-118) caps a formatted Zod
 * issue list at `MAX_ZOD_ISSUES_LISTED` (20) entries and appends a trailing
 * `... and N more` summary once truncated. It is not exported directly, so
 * this test drives it through the real public validation call site
 * (`executeDispatchLanes`, src/tools/dispatch-lanes.ts:701) with a payload
 * malformed enough to produce more than 20 Zod issues.
 */
describe('boundZodIssues via executeDispatchLanes invalid-args path', () => {
	test('caps the errors array at 20 entries plus a trailing "... and N more" marker', async () => {
		// Each empty lane object is missing 3 required fields (id, agent,
		// prompt) -> 3 Zod issues per lane. 8 empty lanes (MAX_LANES) yields
		// 24 issues, 4 over the 20-entry cap.
		const invalidArgs = {
			lanes: Array.from({ length: 8 }, () => ({})),
		};

		// Validation fails before the directory is touched, so any real path
		// works; canonicalTmpDir keeps the FR-011 lint satisfied honestly.
		const result = await executeDispatchLanes(
			invalidArgs,
			canonicalTmpDir(),
			{},
		);

		expect(result.success).toBe(false);
		expect(result.failure_class).toBe('invalid_args');
		expect(result.errors).toBeDefined();
		const errors = result.errors as string[];
		expect(errors).toHaveLength(21);
		expect(errors.slice(0, 20).every((line) => typeof line === 'string')).toBe(
			true,
		);
		expect(errors[20]).toBe('... and 4 more');
	});
});
